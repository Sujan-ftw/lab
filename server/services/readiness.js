'use strict';
/**
 * Document readiness: decides, per document, whether the specific information it needs
 * is saved and approved. Every missing item names the wizard step that fixes it.
 *
 * Wizard steps (0-based): 0 Details · 1 Syllabus · 2 Batches · 3 Examiners ·
 *                         4 Question paper · 5 Allocation · 6 Documents
 */
const STEP = { details: 0, syllabus: 1, batches: 2, examiners: 3, paper: 4, allocation: 5 };
const s = v => (v === null || v === undefined ? '' : String(v)).trim();
const ts = v => (!v ? 0 : v instanceof Date ? v.getTime() : new Date(String(v).replace(' ', 'T') + (/Z$/.test(String(v)) ? '' : 'Z')).getTime());

function headerMissing(d) {
  const e = d.exam || {}, sub = d.subject || {}, set = d.settings || {};
  const out = [];
  const need = (ok, text, step = STEP.details) => { if (!ok) out.push({ text, step }); };
  need(s(e.exam_month), 'Examination month');
  need(parseInt(e.exam_year, 10) > 2000, 'Examination year');
  need(s(e.programme), 'Programme / Diploma');
  need(s(e.semester), 'Semester');
  need(s(sub.subject_name), 'Subject name');
  need(s(sub.subject_code), 'Subject code');
  need(s(sub.lab_date), 'Examination date');
  need(s(sub.start_time) && s(sub.end_time), 'Start and end time');
  need(s(sub.duration), 'Duration');
  need(parseInt(sub.max_marks, 10) > 0, 'Maximum marks');
  if (!s(set.centre_no) || !s(set.institution_name)) out.push({ text: 'Centre number and institution name (administrator Settings)', step: null });
  return out;
}

function signatureMissing(d) {
  const out = [];
  if (!s(d.internal_examiner && d.internal_examiner.name)) out.push({ text: 'Internal examiner name', step: STEP.examiners });
  if (!s(d.external_examiner && d.external_examiner.name)) out.push({ text: 'External examiner name', step: STEP.examiners });
  return out;
}

function questionsComplete(list) {
  if (list.length !== 10) return false;
  const nums = new Set(list.map(q => parseInt(q.q_no, 10)));
  for (let n = 1; n <= 10; n++) if (!nums.has(n)) return false;
  return list.every(q => (q.subquestions || []).some(x => s(x.text)));
}

function examStatus(d) {
  const header = headerMissing(d);
  const sign = signatureMissing(d);
  const exp = d.experiments || [];
  const expApproved = !!d.exam.experiments_approved_at;
  const qpApproved = !!d.exam.qp_approved_at;
  const qpList = [...(d.part_a_questions || []), ...(d.part_b_questions || [])];
  const batches = d.batches || [];
  const docs = [];
  const add = (key, name, official, missing, extra = {}) => docs.push({ key, name, official, available: missing.length === 0, missing, ...extra });

  // 1. List of Experiments
  const loe = [...header];
  if (!exp.length) loe.push({ text: 'Experiment list (upload or enter the syllabus)', step: STEP.syllabus });
  else if (!expApproved) loe.push({ text: 'Approval of the experiment list', step: STEP.syllabus });
  add('list_of_experiments', 'List of Experiments', true, [...loe, ...sign]);

  // 2. Question Paper
  const qp = [...header];
  if (!qpList.length) qp.push({ text: 'Question paper Part A and Part B questions', step: STEP.paper });
  else if (!questionsComplete(qpList)) qp.push({ text: 'All ten questions with sub-question text', step: STEP.paper });
  if (qpList.length && !qpApproved) qp.push({ text: 'Approval of the question paper', step: STEP.paper });
  add('question_paper', 'Question Paper', true, [...qp, ...sign]);

  // 3. Allocation of Marks
  const marks = [...header];
  const comps = d.mark_components || [];
  const total = comps.reduce((n, c) => n + (parseInt(c.max_marks, 10) || 0), 0);
  const max = parseInt(d.subject && d.subject.max_marks, 10) || 0;
  if (!comps.length) marks.push({ text: 'Mark allocation components', step: STEP.paper });
  else if (max && total !== max) marks.push({ text: `Mark allocation totals ${total}, but maximum marks is ${max}`, step: STEP.paper });
  if (!d.exam.id) marks.push({ text: 'Save the examination details', step: STEP.details });
  add('allocation_of_marks', 'Allocation of Marks', true, [...marks, ...sign]);

  // 4+. Question Paper Set per batch
  if (!batches.length) {
    add('batch_qp_set', 'Question Paper Set – Batch', true, [{ text: 'At least one batch', step: STEP.batches }]);
  }
  for (const b of batches) {
    const set = (d.question_sets || []).find(x => parseInt(x.batch_id, 10) === parseInt(b.id, 10));
    const m = [...header];
    if (!set || !(set.questions || []).length) m.push({ text: `Question set for ${b.batch_name}`, step: STEP.paper });
    else if (!questionsComplete(set.questions)) m.push({ text: `All ten questions in the ${b.batch_name} set`, step: STEP.paper });
    if (set && (set.questions || []).length && !set.approved_at) m.push({ text: `Approval of the ${b.batch_name} set`, step: STEP.paper });
    add(`batch_qp_set:${b.id}`, `Question Paper Set – ${b.batch_name}`, true, [...m, ...sign], { batch_id: b.id });
  }

  // Combined official document (all of the above)
  const officialMissing = docs.filter(x => x.official && !x.available).map(x => ({ text: `${x.name} is not ready`, step: (x.missing[0] || {}).step ?? null }));
  add('official_combined', 'Complete official document (all sections)', false, officialMissing, { combined: true });

  // Administrative reports
  for (const b of batches) {
    const m = [];
    const source = sourceFor(d, b.id);
    if (!b.students.length) m.push({ text: `Student list for ${b.batch_name}`, step: STEP.batches });
    if (!source) m.push({ text: `Approved question paper or ${b.batch_name} set`, step: STEP.paper });
    else if (!b.latest_generation) m.push({ text: `Generated allocation for ${b.batch_name}`, step: STEP.allocation });
    else if (source && ts(b.latest_generation.completed_at) < ts(source.approved_at)) {
      m.push({ text: `Allocation for ${b.batch_name} is older than the approved questions; generate it again`, step: STEP.allocation });
    } else if ([...b.latest_generation.rolls].sort().join('|') !== b.students.map(x => x.roll_no).sort().join('|')) {
      m.push({ text: `Student list for ${b.batch_name} changed after allocation; generate it again`, step: STEP.allocation });
    }
    add(`student_allocation:${b.id}`, `Student-wise Allocation Sheet – ${b.batch_name}`, false, [...header.filter(h => h.step !== null), ...m], { batch_id: b.id, report: true });
  }
  for (const b of batches) {
    const m = [];
    if (!b.students.length) m.push({ text: `Student list for ${b.batch_name}`, step: STEP.batches });
    add(`student_register:${b.id}`, `Batch Student Register – ${b.batch_name}`, false, [...header.filter(h => h.step !== null), ...m], { batch_id: b.id, report: true });
  }
  const inv = [];
  if (!batches.length) inv.push({ text: 'At least one batch', step: STEP.batches });
  for (const b of batches) if (!s(b.invigilator_name)) inv.push({ text: `Invigilator for ${b.batch_name}`, step: STEP.batches });
  add('invigilator_duty', 'Invigilator Duty Sheet', false, [...header.filter(h => h.step !== null), ...inv], { report: true });

  // Step completion for the progress indicator
  const steps = [
    header.filter(h => h.step === STEP.details).length === 0,
    expApproved,
    batches.length > 0 && batches.every(b => b.students.length > 0 && b.students.length === parseInt(b.student_count, 10) && s(b.invigilator_name)),
    sign.length === 0,
    qpApproved && batches.length > 0 && batches.every(b => (d.question_sets || []).some(x => parseInt(x.batch_id, 10) === parseInt(b.id, 10) && x.approved_at)),
    batches.length > 0 && batches.every(b => docs.find(x => x.key === `student_allocation:${b.id}`).available),
    docs.filter(x => x.official).every(x => x.available),
  ];
  return { steps, documents: docs };
}

function sourceFor(d, batchId) {
  const set = (d.question_sets || []).find(x => parseInt(x.batch_id, 10) === parseInt(batchId, 10) && x.approved_at);
  if (set) return { approved_at: set.approved_at };
  if (d.exam.qp_approved_at) return { approved_at: d.exam.qp_approved_at };
  return null;
}

/**
 * What the single examination document needs. No approvals, batches or allocations:
 * only the printed examination details, the two examiner names and the experiment list.
 */
function generationMissing(d) {
  const e = d.exam || {}, sub = d.subject || {}, set = d.settings || {};
  const out = [];
  const need = (ok, text) => { if (!ok) out.push(text); };
  need(s(e.exam_month), 'Examination month');
  need(parseInt(e.exam_year, 10) > 2000, 'Examination year');
  need(s(e.centre_no || set.centre_no), 'Centre');
  need(s(e.centre_name || set.institution_name), 'College name');
  need(s(e.programme), 'Course / Programme');
  need(s(e.semester), 'Semester');
  need(s(sub.subject_name), 'Subject name');
  need(s(sub.subject_code), 'Subject code');
  need(s(sub.lab_date), 'Examination date');
  need(s(sub.start_time) && s(sub.end_time), 'Examination time (start and end)');
  need(s(sub.duration), 'Duration');
  need(parseInt(sub.max_marks, 10) > 0, 'Maximum marks');
  need(s(d.internal_examiner && d.internal_examiner.name), 'Internal examiner name');
  need(s(d.external_examiner && d.external_examiner.name), 'External examiner name');
  const exps = (d.experiments || []).filter(x => s(x.title) || s(x.description) || (x.subquestions || []).some(q => s(q.text)));
  if (exps.length < 2) out.push('List of Experiments (at least two experiments, so the question paper has Part A and Part B)');
  return out;
}

module.exports = { examStatus, headerMissing, generationMissing, STEP };
