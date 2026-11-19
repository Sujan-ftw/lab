'use strict';
const { rows, one, query, uid, tx } = require('../db');
const { AllocationUnit, generate, calculateCapacity } = require('./allocationEngine');

/** The examination name is fixed for every practical examination. */
const EXAM_NAME = 'Semester Practical Examinations';

class DomainError extends Error {
  constructor(msg) { super(msg); this.name = 'DomainError'; this.statusCode = 422; }
}
class NotFoundError extends Error {
  constructor(msg) { super(msg); this.name = 'NotFoundError'; this.statusCode = 404; }
}
class ForbiddenError extends Error {
  constructor(msg) { super(msg); this.name = 'ForbiddenError'; this.statusCode = 403; }
}

function requireAdmin(u) {
  if (!u || u.role !== 'admin') throw new ForbiddenError('Administrator access required.');
}
function requireStaff(u) {
  if (!u || (u.role !== 'staff' && u.role !== 'admin')) throw new ForbiddenError('Staff access required.');
}
const str = v => (v === null || v === undefined ? '' : String(v)).trim();
const dateOrNull = v => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : null);

// =========================================================================
// INSTITUTION & SETTINGS
// =========================================================================
async function getSettings() {
  const raw = await rows('SELECT k, val FROM settings');
  const s = {};
  for (const r of raw) s[r.k] = r.val;
  return {
    institution_name: s.institution_name ?? 'PSG Polytechnic College',
    institution_short_name: s.institution_short_name ?? '',
    centre_no: s.centre_no ?? '',
    centre_name: s.centre_name ?? '',
    institution_address: s.institution_address ?? '',
    default_academic_year: s.default_academic_year ?? '',
    default_max_marks: parseInt(s.default_max_marks ?? '75', 10),
    default_duration: s.default_duration ?? '3 hrs.',
    timezone: s.timezone ?? 'Asia/Kolkata',
  };
}

async function saveSettings(u, data) {
  requireAdmin(u);
  await tx(async (conn) => {
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined && typeof v !== 'object') {
        await conn.execute('INSERT INTO settings (k, val) VALUES (?, ?) ON DUPLICATE KEY UPDATE val = VALUES(val)', [String(k), String(v)]);
      }
    }
  });
  await logAudit(u.id, u.role, 'Settings Updated', 'settings', null, 'Institution configuration updated');
  return { ok: true, settings: await getSettings() };
}

/** Saved records offered as dropdown choices so staff do not retype them. */
async function getLookups(u) {
  const departments = (await rows("SELECT name FROM departments WHERE name <> 'Administration' ORDER BY name")).map(r => r.name);
  const programmes = (await rows(`SELECT DISTINCT name FROM (
      SELECT name FROM programmes UNION SELECT programme AS name FROM examinations WHERE programme <> ''
    ) p ORDER BY name`)).map(r => r.name);
  const subjects = await rows(`SELECT s.subject_name, s.subject_code, MAX(e.updated_at) last_used
      FROM exam_subjects s JOIN examinations e ON e.id = s.exam_id
      WHERE s.subject_name <> '' AND s.subject_code <> '' ${u.role === 'admin' ? '' : 'AND e.owner_id = ?'}
      GROUP BY s.subject_name, s.subject_code ORDER BY last_used DESC LIMIT 100`, u.role === 'admin' ? [] : [u.id]);
  const people = (await rows(`SELECT DISTINCT name FROM (
      SELECT name FROM exam_examiners UNION SELECT invigilator_name AS name FROM exam_batches WHERE invigilator_name <> ''
      UNION SELECT name FROM staff_directory WHERE active = 1 UNION SELECT name FROM users WHERE active = 1 AND role = 'staff'
    ) n WHERE name <> '' ORDER BY name`)).map(r => r.name);
  return { departments, programmes, subjects, people, settings: await getSettings() };
}

// =========================================================================
// STAFF DIRECTORY
// =========================================================================
async function getStaffDirectory(roleType = '') {
  let sql = 'SELECT * FROM staff_directory WHERE active = 1';
  const params = [];
  if (roleType !== '') { sql += ' AND role_type = ?'; params.push(roleType); }
  sql += ' ORDER BY name ASC';
  return rows(sql, params);
}

async function saveStaffDirectoryMember(u, d) {
  requireAdmin(u);
  let id = parseInt(d.id ?? 0, 10);
  const name = str(d.name), department = str(d.department);
  const roleType = ['internal', 'external', 'invigilator', 'general'].includes(d.role_type) ? d.role_type : 'general';
  if (!name || !department) throw new DomainError('Name and Department are required for staff directory profile.');
  const vals = [name, str(d.designation), department, str(d.employee_id), str(d.institution), str(d.email), str(d.phone), roleType, str(d.address)];
  if (id > 0) {
    await query('UPDATE staff_directory SET name=?, designation=?, department=?, employee_id=?, institution=?, email=?, phone=?, role_type=?, address=? WHERE id=?', [...vals, id]);
  } else {
    id = uid(await query('INSERT INTO staff_directory (name, designation, department, employee_id, institution, email, phone, role_type, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', vals));
  }
  await logAudit(u.id, u.role, 'Staff Directory Profile Saved', 'staff_directory', id, `Saved directory record for ${name}`);
  return { ok: true, id };
}

// =========================================================================
// EXAMINATIONS
// =========================================================================
async function listExaminations(u, filters = {}) {
  const where = [], params = [];
  if (u.role !== 'admin') { where.push('e.owner_id = ?'); params.push(u.id); }
  if (filters.department && filters.department !== 'All') { where.push('e.department = ?'); params.push(filters.department); }
  if (filters.status && filters.status !== 'All') { where.push('e.status = ?'); params.push(filters.status); }
  const whereClause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  return rows(`SELECT e.*, u.name as owner_name,
    s.subject_name, s.subject_code, s.max_marks, s.duration, s.lab_date,
    (SELECT COUNT(*) FROM exam_batches b WHERE b.exam_id = e.id) as batch_count,
    (SELECT COUNT(*) FROM exam_students st WHERE st.exam_id = e.id) as total_students,
    (SELECT COUNT(*) FROM exam_allocation_generations g WHERE g.exam_id = e.id) as generation_count
  FROM examinations e JOIN users u ON e.owner_id = u.id LEFT JOIN exam_subjects s ON s.exam_id = e.id
  ${whereClause} ORDER BY e.updated_at DESC, e.id DESC`, params);
}

async function assertOwner(id, u) {
  const exam = await one('SELECT * FROM examinations WHERE id = ?', [id]);
  if (!exam || !exam.id) throw new NotFoundError(`Examination #${id} not found.`);
  if (u.role !== 'admin' && parseInt(exam.owner_id, 10) !== parseInt(u.id, 10)) throw new ForbiddenError('Unauthorized access to examination record.');
  return exam;
}

async function getExamination(id, u) {
  const exam = await one('SELECT e.*, u.name as owner_name FROM examinations e JOIN users u ON e.owner_id = u.id WHERE e.id = ?', [id]);
  if (!exam || !exam.id) throw new NotFoundError(`Examination #${id} not found.`);
  if (u.role !== 'admin' && parseInt(exam.owner_id, 10) !== parseInt(u.id, 10)) throw new ForbiddenError('Unauthorized access to examination record.');

  const subject = await one('SELECT * FROM exam_subjects WHERE exam_id = ?', [id]);
  const batches = await rows('SELECT * FROM exam_batches WHERE exam_id = ? ORDER BY id ASC', [id]);
  for (const b of batches) {
    b.students = await rows('SELECT seq, roll_no, name FROM exam_students WHERE batch_id = ? ORDER BY seq ASC', [b.id]);
    const g = await one('SELECT id, version, mode, student_count, completed_at FROM exam_allocation_generations WHERE batch_id = ? ORDER BY version DESC LIMIT 1', [b.id]);
    if (g && g.id) g.rolls = (await rows('SELECT roll_no FROM exam_allocated_items WHERE generation_id = ?', [g.id])).map(r => r.roll_no);
    b.latest_generation = g && g.id ? g : null;
  }

  const examiners = await rows('SELECT * FROM exam_examiners WHERE exam_id = ?', [id]);
  const internal = examiners.find(x => x.role_type === 'internal') || null;
  const external = examiners.find(x => x.role_type === 'external') || null;

  const experiments = await rows('SELECT * FROM exam_experiments WHERE exam_id = ? ORDER BY display_order ASC, exp_no ASC', [id]);
  for (const exp of experiments) {
    exp.subquestions = await rows('SELECT letter, text FROM exam_experiment_subquestions WHERE experiment_id = ? ORDER BY display_order ASC, letter ASC', [exp.id]);
  }
  const syllabus = await one('SELECT id, title AS file_name, stored_name, created_at FROM exam_syllabi WHERE exam_id = ? ORDER BY id DESC LIMIT 1', [id]);

  const qp = await one('SELECT * FROM exam_question_papers WHERE exam_id = ?', [id]);
  const partA = [], partB = [];
  if (qp && qp.id) {
    const items = await rows('SELECT * FROM exam_qp_items WHERE qp_id = ? ORDER BY q_no ASC', [qp.id]);
    for (const it of items) {
      it.subquestions = await rows('SELECT letter, text, source_exp_no, source_letter FROM exam_qp_subquestions WHERE item_id = ? ORDER BY display_order ASC, letter ASC', [it.id]);
      (it.part === 'A' ? partA : partB).push(it);
    }
  }

  const scheme = await one('SELECT * FROM exam_mark_schemes WHERE exam_id = ?', [id]);
  const markComponents = scheme && scheme.id ? await rows('SELECT seq, description, max_marks FROM exam_mark_components WHERE scheme_id = ? ORDER BY seq ASC', [scheme.id]) : [];

  const setRows = await rows('SELECT * FROM exam_question_sets WHERE exam_id = ? AND batch_id IS NOT NULL ORDER BY id DESC', [id]);
  const questionSets = [];
  for (const b of batches) {
    const s = setRows.find(r => parseInt(r.batch_id, 10) === parseInt(b.id, 10));
    if (!s) continue;
    let content = {};
    try { content = JSON.parse(s.content_json || '{}'); } catch { content = {}; }
    questionSets.push({ id: s.id, batch_id: b.id, set_name: s.set_name, questions: content.questions || [], approved_at: s.approved_at, version: s.version });
  }

  return {
    exam, subject: subject && subject.id ? subject : {}, batches,
    internal_examiner: internal, external_examiner: external,
    experiments, syllabus: syllabus && syllabus.id ? syllabus : null,
    question_paper: qp && qp.id ? qp : null,
    part_a_questions: partA, part_b_questions: partB,
    mark_components: markComponents.length ? markComponents : getDefaultMarkComponents(),
    question_sets: questionSets,
    settings: await getSettings(),
  };
}

// ── Content fingerprints: edits after approval withdraw the approval ────────
function fpExperiments(list) {
  return JSON.stringify((list || []).map(e => [parseInt(e.exp_no, 10) || 0, str(e.title), str(e.description),
    (e.subquestions || []).filter(s => str(s.text)).map(s => [str(s.letter).toLowerCase(), str(s.text)])]));
}
function fpQuestions(list) {
  return JSON.stringify((list || []).map(q => [parseInt(q.q_no, 10) || 0, str(q.title),
    (q.subquestions || []).filter(s => str(s.text)).map(s => [str(s.letter).toLowerCase(), str(s.text), parseInt(s.source_exp_no, 10) || null, str(s.source_letter) || null])]));
}

async function saveExamination(u, d) {
  requireStaff(u);
  const settings = await getSettings();
  const result = await tx(async (conn) => {
    let id = parseInt(d.id ?? 0, 10);
    const meta = d.exam ?? {}, subject = d.subject ?? {};

    const month = str(meta.exam_month);
    const year = parseInt(meta.exam_year, 10) || null;
    const title = `${EXAM_NAME}${month || year ? ' - ' + [month, year].filter(Boolean).join(' ') : ''}`;
    const dept = str(meta.department) || str(u.department);
    const prog = str(meta.programme);
    const sem = str(meta.semester);
    const examDate = dateOrNull(subject.exam_date ?? subject.lab_date);
    // Centre and college are entered on the form; the administrator's saved values are the defaults.
    const centreNo = meta.centre_no !== undefined ? str(meta.centre_no) : settings.centre_no;
    const college = meta.centre_name !== undefined ? str(meta.centre_name) : settings.institution_name;

    let existing = null;
    if (id > 0) {
      const [r] = await conn.execute('SELECT * FROM examinations WHERE id = ? FOR UPDATE', [id]);
      existing = r[0];
      if (!existing || (u.role !== 'admin' && parseInt(existing.owner_id, 10) !== parseInt(u.id, 10))) throw new ForbiddenError('Examination unavailable or unauthorized.');
      if (existing.status === 'Finalized' && u.role !== 'admin') throw new DomainError('Finalized examinations cannot be modified. Ask the administrator to reopen it.');
      await conn.execute(
        'UPDATE examinations SET title=?, exam_type=?, exam_month=?, exam_year=?, exam_date=?, department=?, programme=?, semester=?, centre_no=?, centre_name=? WHERE id=?',
        [title, EXAM_NAME, month, year || 0, examDate, dept, prog, sem, centreNo, college, id]
      );
    } else {
      const [r] = await conn.execute(
        "INSERT INTO examinations (owner_id, title, exam_type, exam_month, exam_year, exam_date, academic_year, session, department, programme, semester, study_year, regulation, centre_no, centre_name, instructions) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, '', '', ?, ?, ?)",
        [u.id, title, EXAM_NAME, month, year || 0, examDate, dept, prog, sem, centreNo, college, 'Answer any one question from Part A and Answer any one question from Part B.']
      );
      id = r.insertId;
    }

    const maxMarks = parseInt(subject.max_marks, 10) || 0;
    await conn.execute('DELETE FROM exam_subjects WHERE exam_id = ?', [id]);
    await conn.execute(
      'INSERT INTO exam_subjects (exam_id, subject_name, subject_code, subject_type, department, programme, semester, regulation, max_marks, duration, start_time, end_time, lab_date, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, str(subject.subject_name), str(subject.subject_code).toUpperCase(), 'Practical', dept, prog, sem, '', maxMarks, str(subject.duration), str(subject.start_time), str(subject.end_time), examDate, '']
    );

    if (Array.isArray(d.batches)) await syncBatches(conn, id, d.batches, dept, prog, sem, examDate);
    if (d.internal_examiner !== undefined || d.external_examiner !== undefined) {
      await syncExaminers(conn, id, d.internal_examiner, d.external_examiner);
    }

    let clearExp = false, clearQp = false;
    if (Array.isArray(d.experiments)) {
      const before = await readExperiments(conn, id);
      if (fpExperiments(before) !== fpExperiments(d.experiments)) {
        await syncExperiments(conn, id, d.experiments);
        clearExp = true;
      }
    }
    if (d.syllabus_file && str(d.syllabus_file.file_name)) {
      const prev = (await conn.execute('SELECT stored_name FROM exam_syllabi WHERE exam_id = ? ORDER BY id DESC LIMIT 1', [id]))[0][0];
      if (!prev || prev.stored_name !== str(d.syllabus_file.stored_name)) {
        await conn.execute('INSERT INTO exam_syllabi (exam_id, owner_id, title, subject_code, subject_name, department, semester, stored_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, u.id, str(d.syllabus_file.file_name).slice(0, 200), str(subject.subject_code), str(subject.subject_name), dept, sem, str(d.syllabus_file.stored_name)]);
      }
    }
    if (d.part_a_questions !== undefined || d.part_b_questions !== undefined) {
      const before = await readQuestions(conn, id);
      const next = [...(d.part_a_questions || []), ...(d.part_b_questions || [])];
      if (fpQuestions(before) !== fpQuestions(next)) {
        await syncQuestionPaper(conn, id, d.part_a_questions || [], d.part_b_questions || []);
        clearQp = true;
      }
    }
    if (clearExp) await conn.execute('UPDATE examinations SET experiments_approved_at = NULL, qp_approved_at = NULL WHERE id = ?', [id]);
    if (clearExp || clearQp) {
      await conn.execute('UPDATE examinations SET qp_approved_at = NULL WHERE id = ?', [id]);
      await conn.execute('UPDATE exam_question_sets SET approved_at = NULL WHERE exam_id = ?', [id]);
    }

    const components = Array.isArray(d.mark_components) && d.mark_components.length ? d.mark_components : getDefaultMarkComponents();
    await syncMarkScheme(conn, id, maxMarks, components);
    return { ok: true, id, title };
  });
  await logAudit(u.id, u.role, 'Examination Saved', 'examinations', result.id, `Saved '${result.title}'`);
  return result;
}

async function readExperiments(conn, examId) {
  const [exps] = await conn.execute('SELECT id, exp_no, title, description FROM exam_experiments WHERE exam_id = ? ORDER BY display_order, exp_no', [examId]);
  for (const e of exps) {
    [e.subquestions] = await conn.execute('SELECT letter, text FROM exam_experiment_subquestions WHERE experiment_id = ? ORDER BY display_order, letter', [e.id]);
  }
  return exps;
}

async function readQuestions(conn, examId) {
  const [items] = await conn.execute('SELECT i.id, i.q_no, i.title FROM exam_qp_items i JOIN exam_question_papers qp ON qp.id = i.qp_id WHERE qp.exam_id = ? ORDER BY i.q_no', [examId]);
  for (const it of items) {
    [it.subquestions] = await conn.execute('SELECT letter, text, source_exp_no, source_letter FROM exam_qp_subquestions WHERE item_id = ? ORDER BY display_order, letter', [it.id]);
  }
  return items;
}

async function finalizeExamination(u, id) {
  requireStaff(u);
  const data = await getExamination(id, u);
  const { examStatus } = require('./readiness');
  const st = examStatus(data);
  const missing = st.documents.filter(doc => doc.official && !doc.available);
  if (missing.length) throw new DomainError('Cannot finalize yet: ' + missing.map(doc => `${doc.name} (${doc.missing.map(m => m.text).join('; ')})`).join(' · '));
  const noAlloc = data.batches.filter(b => !b.latest_generation);
  if (noAlloc.length) throw new DomainError('Cannot finalize: generate allocations for ' + noAlloc.map(b => b.batch_name).join(', ') + '.');
  await query("UPDATE examinations SET status = 'Finalized' WHERE id = ?", [id]);
  await query('UPDATE exam_allocation_generations SET finalized_at = UTC_TIMESTAMP() WHERE exam_id = ? AND finalized_at IS NULL', [id]);
  await logAudit(u.id, u.role, 'Examination Finalized', 'examinations', id, `Finalized examination #${id}`);
  return { ok: true };
}

async function reopenExamination(u, id, reason) {
  requireAdmin(u);
  await query("UPDATE examinations SET status = 'Draft' WHERE id = ?", [id]);
  await logAudit(u.id, u.role, 'Examination Reopened', 'examinations', id, `Reopened examination #${id}. Reason: ${reason}`);
  return { ok: true };
}

// =========================================================================
// APPROVALS
// =========================================================================
function validateQuestions(list, label) {
  const problems = [];
  const byNo = new Map(list.map(q => [parseInt(q.q_no, 10), q]));
  for (let n = 1; n <= 10; n++) {
    const q = byNo.get(n);
    const subs = q ? (q.subquestions || []).filter(s => str(s.text)) : [];
    if (!q || !subs.length) problems.push(`${label} question ${n} has no sub-question text`);
  }
  if (list.length !== 10) problems.push(`${label} must have exactly 10 questions (Part A 1–5, Part B 6–10)`);
  return problems;
}

async function approve(u, examId, section, approved = true) {
  requireStaff(u);
  const data = await getExamination(examId, u);
  if (data.exam.status === 'Finalized' && u.role !== 'admin') throw new DomainError('Finalized examinations cannot be changed.');
  if (section === 'experiments') {
    if (approved) {
      if (!data.experiments.length) throw new DomainError('Add or extract at least one experiment before approval.');
      const empty = data.experiments.filter(e => !e.subquestions.length && !str(e.title));
      if (empty.length) throw new DomainError('Experiments ' + empty.map(e => e.exp_no).join(', ') + ' have no content.');
    }
    await query(`UPDATE examinations SET experiments_approved_at = ${approved ? 'UTC_TIMESTAMP()' : 'NULL'}${approved ? '' : ', qp_approved_at = NULL'} WHERE id = ?`, [examId]);
  } else if (section === 'question_paper') {
    if (approved) {
      if (!data.exam.experiments_approved_at) throw new DomainError('Approve the experiment list (Step 2) before approving the question paper.');
      const problems = validateQuestions([...data.part_a_questions, ...data.part_b_questions], 'Question paper');
      if (problems.length) throw new DomainError(problems.join('; ') + '.');
    }
    await query(`UPDATE examinations SET qp_approved_at = ${approved ? 'UTC_TIMESTAMP()' : 'NULL'} WHERE id = ?`, [examId]);
    if (!approved) await query('UPDATE exam_question_sets SET approved_at = NULL WHERE exam_id = ?', [examId]);
  } else {
    throw new DomainError('Unknown approval section.');
  }
  await logAudit(u.id, u.role, approved ? 'Approved' : 'Approval Withdrawn', 'examinations', examId, `${section} ${approved ? 'approved' : 'reopened for editing'}`);
  return { ok: true };
}

/** Save (and optionally approve) a batch-specific question paper set. */
async function saveBatchSet(u, examId, batchId, questions, approveIt) {
  requireStaff(u);
  const data = await getExamination(examId, u);
  const batch = data.batches.find(b => parseInt(b.id, 10) === parseInt(batchId, 10));
  if (!batch) throw new NotFoundError('Batch not found. Save the examination first.');
  if (approveIt) {
    if (!data.exam.qp_approved_at) throw new DomainError('Approve the main question paper before approving batch sets.');
    const problems = validateQuestions(questions || [], batch.batch_name + ' set');
    if (problems.length) throw new DomainError(problems.join('; ') + '.');
  }
  const clean = (questions || []).map((q, i) => ({
    q_no: parseInt(q.q_no, 10) || i + 1,
    title: str(q.title),
    subquestions: (q.subquestions || []).filter(s => str(s.text)).map(s => ({
      letter: str(s.letter).toLowerCase(), text: str(s.text),
      source_exp_no: parseInt(s.source_exp_no, 10) || null, source_letter: str(s.source_letter) || null,
    })),
  }));
  const existing = await one('SELECT id, content_json, version FROM exam_question_sets WHERE exam_id = ? AND batch_id = ? ORDER BY id DESC LIMIT 1', [examId, batchId]);
  const json = JSON.stringify({ questions: clean });
  if (existing && existing.id) {
    const changed = existing.content_json !== json;
    await query(`UPDATE exam_question_sets SET set_name = ?, content_json = ?, version = version + ?, approved_at = ${approveIt ? 'UTC_TIMESTAMP()' : (changed ? 'NULL' : 'approved_at')} WHERE id = ?`,
      [`Question Paper Set – ${batch.batch_name}`, json, changed ? 1 : 0, existing.id]);
  } else {
    await query(`INSERT INTO exam_question_sets (exam_id, batch_id, set_name, set_code, content_json, created_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ${approveIt ? 'UTC_TIMESTAMP()' : 'NULL'})`,
      [examId, batchId, `Question Paper Set – ${batch.batch_name}`, 'B' + batchId, json, u.id]);
  }
  await logAudit(u.id, u.role, approveIt ? 'Batch Set Approved' : 'Batch Set Saved', 'exam_batches', batchId, `Question set for ${batch.batch_name}`);
  return { ok: true };
}

// =========================================================================
// BATCHES, STUDENTS, EXAMINERS
// =========================================================================
async function syncBatches(conn, examId, batches, dept, prog, sem, examDate) {
  const [existing] = await conn.execute('SELECT id FROM exam_batches WHERE exam_id = ?', [examId]);
  const existingIds = existing.map(r => parseInt(r.id, 10));
  const keptIds = [];
  const names = new Set();
  const rollOwner = new Map();
  for (const b of batches) {
    for (const st of Array.isArray(b.students) ? b.students : []) {
      const roll = str(st.roll_no ?? st.roll).toUpperCase();
      if (!roll) continue;
      const other = rollOwner.get(roll);
      if (other !== undefined && other !== b) throw new DomainError(`Roll number ${roll} is in both ${str(other.batch_name)} and ${str(b.batch_name)}.`);
      rollOwner.set(roll, b);
    }
  }

  for (const b of batches) {
    let bId = parseInt(b.id ?? 0, 10);
    const name = str(b.batch_name || b.batch_code);
    if (!name) throw new DomainError('Every batch needs a name.');
    if (names.has(name.toLowerCase())) throw new DomainError(`Batch name "${name}" is used twice.`);
    names.add(name.toLowerCase());
    const count = Math.max(0, parseInt(b.student_count ?? 0, 10) || 0);
    const vals = [name, name, count, str(b.invigilator_name), str(b.additional_invigilators).slice(0, 255)];

    if (bId > 0 && existingIds.includes(bId)) {
      await conn.execute('UPDATE exam_batches SET batch_code=?, batch_name=?, student_count=?, invigilator_name=?, additional_invigilators=? WHERE id=?', [...vals, bId]);
    } else {
      const [r] = await conn.execute(
        "INSERT INTO exam_batches (exam_id, batch_code, batch_name, student_count, invigilator_name, additional_invigilators, department, programme, academic_year, semester, study_year, exam_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, '', ?)",
        [examId, ...vals, dept, prog, sem, examDate]
      );
      bId = r.insertId;
    }
    keptIds.push(bId);
    if (Array.isArray(b.students)) await syncBatchStudents(conn, bId, examId, b.students, name);
  }

  for (const delId of existingIds.filter(i => !keptIds.includes(i))) {
    await conn.execute('DELETE FROM exam_question_sets WHERE batch_id = ?', [delId]);
    await conn.execute('DELETE FROM exam_batches WHERE id = ?', [delId]);
  }
  await conn.execute('UPDATE exam_batches SET exam_date = ? WHERE exam_id = ?', [examDate, examId]);
}

async function syncBatchStudents(conn, batchId, examId, students, batchName) {
  await conn.execute('DELETE FROM exam_students WHERE batch_id = ?', [batchId]);
  const seen = new Set();
  let seq = 1;
  for (const s of students) {
    const roll = str(s.roll_no ?? s.roll).toUpperCase();
    if (!roll) continue;
    if (seen.has(roll)) throw new DomainError(`Roll number ${roll} appears twice in ${batchName}.`);
    seen.add(roll);
    await conn.execute('INSERT INTO exam_students (batch_id, exam_id, seq, roll_no, name) VALUES (?, ?, ?, ?, ?)', [batchId, examId, seq++, roll, str(s.name ?? s.student_name)]);
  }
}

async function syncExaminers(conn, examId, internal, external) {
  for (const [role, ex] of [['internal', internal], ['external', external]]) {
    const name = str(ex && ex.name);
    if (!name) {
      await conn.execute('DELETE FROM exam_examiners WHERE exam_id = ? AND role_type = ?', [examId, role]);
      continue;
    }
    await conn.execute(
      "INSERT INTO exam_examiners (exam_id, role_type, name, designation, department, institution) VALUES (?, ?, ?, '', '', '') ON DUPLICATE KEY UPDATE name = VALUES(name)",
      [examId, role, name]
    );
  }
}

// =========================================================================
// SYLLABUS, QUESTION PAPER, MARKS
// =========================================================================
async function syncExperiments(conn, examId, experiments) {
  await conn.execute('DELETE FROM exam_experiments WHERE exam_id = ?', [examId]);
  let order = 1;
  for (const exp of experiments) {
    const [r] = await conn.execute(
      'INSERT INTO exam_experiments (exam_id, exp_no, title, description, display_order) VALUES (?, ?, ?, ?, ?)',
      [examId, parseInt(exp.exp_no, 10) || order, str(exp.title).slice(0, 300), str(exp.description), order]
    );
    order++;
    let subOrder = 1;
    for (const sub of exp.subquestions ?? []) {
      const text = str(sub.text);
      if (!text) continue;
      await conn.execute('INSERT INTO exam_experiment_subquestions (experiment_id, letter, text, display_order) VALUES (?, ?, ?, ?)',
        [r.insertId, str(sub.letter).toLowerCase() || String.fromCharCode(96 + subOrder), text, subOrder++]);
    }
  }
}

async function syncQuestionPaper(conn, examId, partA, partB) {
  const [[qp]] = await conn.execute('SELECT id FROM exam_question_papers WHERE exam_id = ?', [examId]);
  let qpId = qp ? qp.id : 0;
  if (qpId) await conn.execute('DELETE FROM exam_qp_items WHERE qp_id = ?', [qpId]);
  else {
    const [r] = await conn.execute("INSERT INTO exam_question_papers (exam_id, instructions, part_a_marks, part_b_marks, total_marks) VALUES (?, 'Answer any one question from Part A and Answer any one question from Part B.', 35, 35, 75)", [examId]);
    qpId = r.insertId;
  }
  for (const [part, list] of [['A', partA], ['B', partB]]) {
    for (const item of list) {
      const qNo = parseInt(item.q_no, 10);
      const [r] = await conn.execute('INSERT INTO exam_qp_items (qp_id, part, q_no, title, display_order) VALUES (?, ?, ?, ?, ?)', [qpId, part, qNo, str(item.title).slice(0, 300), qNo]);
      let order = 1;
      for (const sub of item.subquestions ?? []) {
        const text = str(sub.text);
        if (!text) continue;
        await conn.execute('INSERT INTO exam_qp_subquestions (item_id, part, q_no, letter, text, display_order, source_exp_no, source_letter) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [r.insertId, part, qNo, str(sub.letter).toLowerCase(), text, order++, parseInt(sub.source_exp_no, 10) || null, str(sub.source_letter) || null]);
      }
    }
  }
}

function getDefaultMarkComponents() {
  return [
    { seq: 1, description: 'Aim, Algorithm ,Flowchart and Result (PART A)', max_marks: 10 },
    { seq: 2, description: 'Aim, Algorithm ,Flowchart and Result (PART B)', max_marks: 10 },
    { seq: 3, description: 'Viva Voce', max_marks: 5 },
    { seq: 4, description: 'Program Execution -Part A', max_marks: 15 },
    { seq: 5, description: 'Program Execution- Part B', max_marks: 15 },
    { seq: 6, description: 'Output Printout -Part A', max_marks: 10 },
    { seq: 7, description: 'Output Printout - Part B', max_marks: 10 },
  ];
}

async function syncMarkScheme(conn, examId, totalMarks, components) {
  const [[scheme]] = await conn.execute('SELECT id FROM exam_mark_schemes WHERE exam_id = ?', [examId]);
  let schemeId = scheme ? scheme.id : 0;
  if (schemeId) {
    await conn.execute('UPDATE exam_mark_schemes SET total_marks = ? WHERE id = ?', [totalMarks, schemeId]);
    await conn.execute('DELETE FROM exam_mark_components WHERE scheme_id = ?', [schemeId]);
  } else {
    const [r] = await conn.execute('INSERT INTO exam_mark_schemes (exam_id, total_marks) VALUES (?, ?)', [examId, totalMarks]);
    schemeId = r.insertId;
  }
  let seq = 1;
  for (const c of components) {
    const desc = str(c.description);
    if (!desc) continue;
    await conn.execute('INSERT INTO exam_mark_components (scheme_id, seq, description, max_marks) VALUES (?, ?, ?, ?)', [schemeId, seq++, desc, parseInt(c.max_marks, 10) || 0]);
  }
}

// =========================================================================
// ALLOCATION
// =========================================================================
/** Approved question source for a batch: its approved set, otherwise the approved paper. */
function batchQuestionSource(data, batchId) {
  const set = data.question_sets.find(s => parseInt(s.batch_id, 10) === parseInt(batchId, 10) && s.approved_at);
  if (set) return { kind: 'set', label: 'approved batch question set', questions: set.questions, approved_at: set.approved_at };
  if (data.exam.qp_approved_at) {
    return { kind: 'paper', label: 'approved question paper', questions: [...data.part_a_questions, ...data.part_b_questions], approved_at: data.exam.qp_approved_at };
  }
  return null;
}

function unitsFrom(questions) {
  const A = [], B = [];
  for (const q of questions) {
    const n = parseInt(q.q_no, 10);
    if (!(n >= 1 && n <= 10)) continue;
    const part = n <= 5 ? 'A' : 'B';
    const seen = new Set();
    for (const s of q.subquestions || []) {
      const letter = str(s.letter).toLowerCase();
      if (!str(s.text) || seen.has(letter)) continue;
      seen.add(letter);
      (part === 'A' ? A : B).push(new AllocationUnit(n, letter, part, str(s.text), str(q.title)));
    }
  }
  return { A, B };
}

async function allocationContext(u, examId, batchId) {
  const data = await getExamination(examId, u);
  const batch = data.batches.find(b => parseInt(b.id, 10) === parseInt(batchId, 10));
  if (!batch) throw new NotFoundError('Batch not found. Save the examination first.');
  const source = batchQuestionSource(data, batchId);
  if (!source) throw new DomainError('Approve the question paper (Step 5) before generating allocations.');
  const { A, B } = unitsFrom(source.questions);
  return { data, batch, source, A, B, students: batch.students };
}

async function checkCapacity(u, examId, batchId) {
  const { batch, source, A, B, students } = await allocationContext(u, examId, batchId);
  const cap = calculateCapacity(A, B, {});
  return {
    ...cap,
    student_count: students.length,
    source: source.label,
    can_generate: students.length > 0 && students.length <= cap.available_capacity,
    remaining_after: Math.max(0, cap.available_capacity - students.length),
    batch_name: batch.batch_name,
  };
}

/** Build a candidate allocation without saving it. */
async function previewAllocations(u, examId, batchId, mode) {
  const { batch, source, A, B, students } = await allocationContext(u, examId, batchId);
  if (!students.length) throw new DomainError(`${batch.batch_name} has no students. Add the student list in Step 3.`);
  let res;
  try { res = generate(A, B, students, mode, {}); } catch (e) { throw new DomainError(e.message); }
  return { ...res, source: source.label, batch_name: batch.batch_name };
}

/** Validate a previewed allocation against the current data and store it as a new version. */
async function confirmAllocations(u, examId, batchId, mode, allocations, reason = '') {
  requireStaff(u);
  const { data, batch, source, A, B, students } = await allocationContext(u, examId, batchId);
  if (data.exam.status === 'Finalized' && u.role !== 'admin') throw new DomainError('Finalized examinations cannot be regenerated.');
  const unitA = new Map(A.map(x => [x.code(), x])), unitB = new Map(B.map(x => [x.code(), x]));
  const byRoll = new Map((allocations || []).map(a => [str(a.roll_no).toUpperCase(), a]));
  if (byRoll.size !== students.length || (allocations || []).length !== students.length) {
    throw new DomainError('The preview no longer matches the student list. Generate the preview again.');
  }
  const pairs = new Set();
  const final = students.map((st, i) => {
    const a = byRoll.get(st.roll_no);
    if (!a) throw new DomainError(`Roll number ${st.roll_no} is missing from the preview. Generate it again.`);
    const ua = unitA.get(a.part_a_code), ub = unitB.get(a.part_b_code);
    if (!ua || !ub) throw new DomainError('The question set changed after the preview. Generate the preview again.');
    const key = `${ua.code()} + ${ub.code()}`;
    if (pairs.has(key)) throw new DomainError(`Duplicate combination ${key} in the preview.`);
    pairs.add(key);
    return { seq: i + 1, roll_no: st.roll_no, student_name: st.name, ua, ub, key };
  });
  const cap = calculateCapacity(A, B, {});

  const out = await tx(async (conn) => {
    const [[prev]] = await conn.execute('SELECT COALESCE(MAX(version), 0) v FROM exam_allocation_generations WHERE batch_id = ? FOR UPDATE', [batchId]);
    const version = parseInt(prev.v, 10) + 1;
    const [g] = await conn.execute(
      "INSERT INTO exam_allocation_generations (exam_id, batch_id, version, mode, algorithm, no_reuse, reason, student_count, part_a_count, part_b_count, capacity, used_count, duplicate_count, unassigned_count, validation_status, started_at, completed_at, created_by) VALUES (?, ?, ?, ?, 'pems-cartesian-bipartite-v1', 0, ?, ?, ?, ?, ?, ?, 0, 0, 'valid', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), ?)",
      [examId, batchId, version, mode, str(reason) || source.label, final.length, A.length, B.length, cap.available_capacity, final.length, u.id]
    );
    for (const f of final) {
      await conn.execute(
        'INSERT INTO exam_allocated_items (generation_id, batch_id, seq, roll_no, student_name, part_a_q, part_a_letter, part_a_code, part_a_text, part_b_q, part_b_letter, part_b_code, part_b_text, pair_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [g.insertId, batchId, f.seq, f.roll_no, f.student_name || '', f.ua.qNo, f.ua.letter, f.ua.code(), f.ua.text, f.ub.qNo, f.ub.letter, f.ub.code(), f.ub.text, f.key]
      );
    }
    await conn.execute("UPDATE examinations SET status = IF(status = 'Finalized', status, 'Generated') WHERE id = ?", [examId]);
    return { version, generation_id: g.insertId };
  });
  await addNotification(u.id, 'Question Allocation Saved', `Version ${out.version} for ${batch.batch_name} (${final.length} students)`, 'success');
  await logAudit(u.id, u.role, out.version > 1 ? 'Allocations Regenerated' : 'Allocations Generated', 'exam_batches', batchId, `Saved ${final.length} unique combinations for ${batch.batch_name} (version ${out.version})`);
  return { ok: true, ...out, student_count: final.length, remaining_combinations: cap.available_capacity - final.length };
}

async function getBatchAllocations(batchId, version = 0) {
  let sql = 'SELECT * FROM exam_allocation_generations WHERE batch_id = ?';
  const params = [batchId];
  if (version > 0) { sql += ' AND version = ?'; params.push(version); } else sql += ' ORDER BY version DESC LIMIT 1';
  const gen = await one(sql, params);
  if (!gen || !gen.id) return { has_allocations: false, versions: [] };
  const items = await rows('SELECT * FROM exam_allocated_items WHERE generation_id = ? ORDER BY seq ASC', [gen.id]);
  const versions = await rows('SELECT id, version, mode, student_count, completed_at, finalized_at, reason FROM exam_allocation_generations WHERE batch_id = ? ORDER BY version DESC', [batchId]);
  return { has_allocations: true, generation: gen, versions, allocations: items };
}

// =========================================================================
// AUDIT & NOTIFICATIONS
// =========================================================================
async function logAudit(userId, role, action, entityType, entityId, detail, ip = '127.0.0.1') {
  await query('INSERT INTO audit_logs (user_id, user_role, action, entity_type, entity_id, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)', [userId, role, action, entityType, entityId, ip, detail]);
  await query('INSERT INTO events (actor, action, detail) VALUES (?, ?, ?)', [userId, action, detail]);
}
async function addNotification(userId, title, message, type = 'info', link = null) {
  await query('INSERT INTO notifications (user_id, title, message, type, link) VALUES (?, ?, ?, ?, ?)', [userId, title, message, type, link]);
}
async function getNotifications(userId) {
  return rows('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 20', [userId]);
}
async function markNotificationRead(userId, notifId) {
  await query('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [notifId, userId]);
}

module.exports = {
  EXAM_NAME, DomainError, NotFoundError, ForbiddenError,
  getSettings, saveSettings, getLookups,
  getStaffDirectory, saveStaffDirectoryMember,
  listExaminations, getExamination, saveExamination, finalizeExamination, reopenExamination, assertOwner,
  approve, saveBatchSet, batchQuestionSource,
  checkCapacity, previewAllocations, confirmAllocations, getBatchAllocations, calculateCapacity,
  getDefaultMarkComponents,
  logAudit, addNotification, getNotifications, markNotificationRead,
  AllocationUnit,
};
