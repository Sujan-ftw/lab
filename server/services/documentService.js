'use strict';
/**
 * Official document generator.
 *
 * The reference file "Sem qp lab AIT-edited.docx" (server/templates/official-reference.docx)
 * is used as the template package: its styles, fonts, theme, numbering, settings and page
 * setup (Letter, margins 720/630/900/1440 twips) are kept unchanged. Only the body is
 * rebuilt, using the paragraph/run/table properties copied from the reference XML, and
 * filled with the examination's saved data. Each document starts on a new page.
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const TEMPLATE = path.join(__dirname, '../templates/official-reference.docx');

// ─── XML primitives (property strings copied from the reference) ─────────────
const TNR = '<w:rFonts w:ascii="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>';
const THEME = '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:cstheme="minorHAnsi"/>';

function x(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}
function rPr({ font = TNR, b = false, sz = null, u = false } = {}) {
  return `<w:rPr>${font || ''}${b ? '<w:b/>' : ''}${sz ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : ''}${u ? '<w:u w:val="single"/>' : ''}</w:rPr>`;
}
function run(text, opts = {}) {
  return `<w:r>${rPr(opts)}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
}
function tab(opts = {}) { return `<w:r>${rPr(opts)}<w:tab/></w:r>`; }
function para(pPrInner, runs = '', markOpts = null) {
  return `<w:p><w:pPr>${pPrInner}${markOpts ? rPr(markOpts) : ''}</w:pPr>${runs}</w:p>`;
}
const PB = '<w:pageBreakBefore/>';

// ─── Formatting helpers ───────────────────────────────────────────────────────
function fmtDate(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return `${String(v.getUTCDate()).padStart(2, '0')}.${String(v.getUTCMonth() + 1).padStart(2, '0')}.${v.getUTCFullYear()}`;
  }
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v);
}
function fmtTime(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return s;
  let h = +m[1];
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}.${m[2]} ${ap}`;
}

/** Flatten saved examination data into the values printed on official documents. */
function docValues(d) {
  const e = d.exam || {}, s = d.subject || {}, st = d.settings || {};
  return {
    month: String(e.exam_month || '').toUpperCase(),
    monthAsEntered: String(e.exam_month || ''),
    year: e.exam_year || '',
    centre: [e.centre_no || st.centre_no, e.centre_name || st.institution_name].filter(Boolean).join(', '),
    programme: e.programme || '',
    semester: e.semester || '',
    subject: s.subject_name || '',
    code: s.subject_code || '',
    maxMarks: s.max_marks || '',
    duration: s.duration || '',
    date: fmtDate(s.lab_date),
    time: `${fmtTime(s.start_time)} to ${fmtTime(s.end_time)}`,
    internal: (d.internal_examiner && d.internal_examiner.name) || '',
    external: (d.external_examiner && d.external_examiner.name) || '',
  };
}

// ─── Shared blocks ────────────────────────────────────────────────────────────
const HEAD_PPR = '<w:pStyle w:val="Normal1"/><w:tabs><w:tab w:val="left" w:pos="6480"/></w:tabs><w:spacing w:line="300" w:lineRule="auto"/>';
const H = { b: true, sz: 26 };

function headerBlock(v, pageBreak, monthAsEntered = false) {
  // The reference prints "April" on the List of Experiments page and "APRIL" on the later pages.
  return [
    para(`<w:pStyle w:val="Normal1"/>${pageBreak ? PB : ''}<w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="center"/>`,
      run(`SEMESTER PRACTICAL EXAMINATIONS -${monthAsEntered ? v.monthAsEntered : v.month} ${v.year}`, H), H),
    para(HEAD_PPR, run(`Center     : ${v.centre}`, H) + tab(H) + run(`MAX MARKS: ${v.maxMarks}`, H), H),
    para(HEAD_PPR, run(`Course     : ${v.programme}`, H) + tab(H) + run(`Duration: ${v.duration}`, H), H),
    para(HEAD_PPR, run('Subject    : ', H) + run(v.subject, { font: THEME, b: true }) + tab(H) + run(`Date: ${v.date}`, H), H),
    para(HEAD_PPR, run('Subject code: ', H) + run(v.code, { font: THEME, b: true }), H),
    para(HEAD_PPR, run(`Semester: ${v.semester}`, H) + tab(H) + run(`       Time: ${v.time}`, H), H),
  ].join('');
}

function sectionTitle(text, line = null) {
  const sp = line ? `<w:spacing w:line="${line}" w:lineRule="auto"/>` : '';
  const o = { b: true, sz: 26, u: true };
  return para(`<w:pStyle w:val="Normal1"/><w:tabs><w:tab w:val="center" w:pos="4680"/></w:tabs>${sp}<w:jc w:val="center"/>`, run(text, o), o);
}

function blankCentered(n) {
  const o = { b: true, sz: 26, u: true };
  return Array.from({ length: n }, () => para('<w:pStyle w:val="Normal1"/><w:tabs><w:tab w:val="center" w:pos="4680"/></w:tabs><w:jc w:val="center"/>', '', o)).join('');
}
function blank(n, sz = 24) {
  return Array.from({ length: n }, () => para('<w:pStyle w:val="Normal1"/><w:spacing w:line="300" w:lineRule="auto"/>', '', { b: true, sz })).join('');
}

function signatures(v) {
  const l = { b: true, sz: 24 };
  const tabs = '<w:tabs><w:tab w:val="left" w:pos="6480"/></w:tabs>';
  return para(`<w:pStyle w:val="Normal1"/>${tabs}<w:keepNext/><w:spacing w:line="300" w:lineRule="auto"/>`,
      run('INTERNAL EXAMINER ', l) + tab(l) + run('           EXTERNAL EXAMINER', l), l)
    + para(`<w:pStyle w:val="Normal1"/>${tabs}<w:spacing w:after="200"/><w:ind w:firstLine="131"/><w:jc w:val="both"/>`,
      run(v.internal, { b: true, sz: 26 }) + tab(l) + run('           ' + v.external, l), { b: true, sz: 26 });
}

const TBL_BORDERS = '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders>';

/** Two-column numbered table used by the List of Experiments and the Question Paper. */
function numberedTable(rows, { rowHeight, numSize, numCenter }) {
  const body = rows.map(r => {
    const lines = r.lines.length ? r.lines : [''];
    const content = lines.map(t => para('<w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="both"/>', t ? run(t, { font: null, sz: 16 }) : '', { font: null, sz: 16 })).join('');
    const numPara = para(`<w:pStyle w:val="Normal10"/>${numCenter ? '' : '<w:spacing w:line="360" w:lineRule="auto"/>'}${numCenter ? '<w:jc w:val="center"/>' : ''}`,
      run(String(r.no), { sz: numSize }), { sz: numSize });
    return `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${rowHeight}"/></w:trPr>`
      + `<w:tc><w:tcPr><w:tcW w:w="665" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${numPara}</w:tc>`
      + `<w:tc><w:tcPr><w:tcW w:w="9570" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${content}</w:tc></w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="10235" w:type="dxa"/>${TBL_BORDERS}<w:tblLook w:val="04A0"/></w:tblPr>`
    + `<w:tblGrid><w:gridCol w:w="665"/><w:gridCol w:w="9570"/></w:tblGrid>${body}</w:tbl>`;
}

const subLines = subs => (subs || []).filter(s => String(s.text || '').trim()).map(s => `${s.letter}) ${String(s.text).trim()}`);
const tableGap = () => para('<w:pStyle w:val="Normal1"/><w:spacing w:after="0" w:line="190" w:lineRule="exact"/>', '', { sz: 4 });

// ─── Official documents ──────────────────────────────────────────────────────
function listOfExperiments(d, v, pb) {
  const rows = (d.experiments || []).map(e => {
    const lines = subLines(e.subquestions);
    return { no: e.exp_no, lines: lines.length ? lines : [e.title, e.description].map(t => String(t || '').trim()).filter(Boolean) };
  });
  return headerBlock(v, pb, true) + sectionTitle('LIST OF EXPERIMENTS') + tableGap()
    + numberedTable(rows, { rowHeight: 714, numSize: 26, numCenter: false })
    + blankCentered(3) + signatures(v);
}

function partHeading(letter, marks) {
  const o = { b: true, sz: 26 };
  return para('<w:pStyle w:val="Normal1"/><w:tabs><w:tab w:val="left" w:pos="0"/><w:tab w:val="left" w:pos="4242"/><w:tab w:val="left" w:pos="4289"/></w:tabs><w:keepNext/><w:ind w:firstLine="720"/><w:jc w:val="center"/>',
    run(` PART – ${letter} (Answer any one`, { ...o, u: true }) + run(`)                                      (${marks} MARKS)`, o), o);
}

function partMarks(d) {
  const qp = d.question_paper || {};
  return { A: parseInt(qp.part_a_marks, 10) || 35, B: parseInt(qp.part_b_marks, 10) || 35 };
}

function questionPaper(d, v, pb) {
  const qs = n => (n === 'A' ? d.part_a_questions : d.part_b_questions || []).map(q => {
    const lines = subLines(q.subquestions);
    return { no: q.q_no, lines: lines.length ? lines : [q.title, q.description].map(t => String(t || '').trim()).filter(Boolean) };
  });
  const m = partMarks(d);
  const o = { b: true, sz: 26 };
  return headerBlock(v, pb) + sectionTitle('QUESTION PAPER')
    + para('<w:pStyle w:val="Normal1"/><w:tabs><w:tab w:val="center" w:pos="4680"/></w:tabs><w:jc w:val="center"/>', '', o)
    + para('<w:pStyle w:val="Normal1"/><w:tabs><w:tab w:val="center" w:pos="4680"/></w:tabs><w:jc w:val="both"/>', run('Answer any one question from Part A and Answer any one question from Part B.', o), o)
    + para('<w:pStyle w:val="Normal1"/><w:tabs><w:tab w:val="center" w:pos="4680"/></w:tabs><w:jc w:val="both"/>', '', o)
    + partHeading('A', m.A) + tableGap()
    + numberedTable(qs('A'), { rowHeight: 530, numSize: 24, numCenter: true })
    + blank(1) + partHeading('B', m.B) + tableGap()
    + numberedTable(qs('B'), { rowHeight: 530, numSize: 24, numCenter: true })
    + blank(1) + signatures(v);
}

function allocationOfMarks(d, v, pb) {
  const comps = d.mark_components || [];
  const total = comps.reduce((n, c) => n + (parseInt(c.max_marks, 10) || 0), 0);
  const cellP = (text, { jc = null, b = false, line = 360 } = {}) =>
    para(`<w:spacing w:line="${line}" w:lineRule="auto"/>${jc ? `<w:jc w:val="${jc}"/>` : ''}`, text === '' ? '' : run(text, { b, sz: 26 }), { b, sz: 26 });
  const tc = (w, inner, span = 0) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="pct"/>${span ? `<w:gridSpan w:val="${span}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>${inner}</w:tc>`;
  const tr = (h, cells) => `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${h}"/><w:jc w:val="center"/></w:trPr>${cells}</w:tr>`;
  let rows = tr(1391,
    tc(544, cellP('S.NO.', { b: true, line: 240 })) +
    tc(3457, cellP('DESCRIPTION OF ALLOCATION', { b: true, line: 240 })) +
    tc(999, cellP('', { b: true, line: 240 }) + cellP('MAXIMUM MARKS', { b: true, line: 240 }) + cellP('', { b: true, line: 240 })));
  comps.forEach((c, i) => {
    rows += tr(517,
      tc(544, cellP(String(i + 1), { jc: 'center' })) +
      tc(3457, cellP(c.description)) +
      tc(999, cellP(String(parseInt(c.max_marks, 10) || 0).padStart(2, '0'), { jc: 'center', b: true })));
  });
  rows += tr(859, tc(4001, cellP('TOTAL', { jc: 'right', b: true }), 2) + tc(999, cellP(String(total), { jc: 'center', b: true })));
  const table = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="3897" w:type="pct"/><w:jc w:val="center"/><w:tblLook w:val="04A0"/></w:tblPr>`
    + `<w:tblGrid><w:gridCol w:w="881"/><w:gridCol w:w="5597"/><w:gridCol w:w="1617"/></w:tblGrid>${rows}</w:tbl>`;
  const o = { b: true, sz: 26, u: true };
  const gap = para('<w:pStyle w:val="Normal1"/><w:tabs><w:tab w:val="center" w:pos="4680"/></w:tabs><w:spacing w:line="240" w:lineRule="auto"/>', '', o);
  return headerBlock(v, pb) + blankCentered(1) + sectionTitle('ALLOCATION OF MARKS', 240) + gap + gap + table + blank(4) + signatures(v);
}

function batchQuestionSet(d, v, pb, batch, set) {
  const qo = { b: true, sz: 18 };
  const so = { sz: 18 };
  let body = '';
  for (const q of (set.questions || [])) {
    body += para('<w:keepNext/><w:jc w:val="both"/>', run(`${q.q_no}. ${q.title || ''}`.trimEnd(), qo), qo);
    for (const s of (q.subquestions || []).filter(z => String(z.text || '').trim())) {
      body += para('<w:keepNext/><w:spacing w:line="240" w:lineRule="auto"/><w:jc w:val="both"/>', run(`    ${s.letter}   `, so) + run(String(s.text).trim(), so), so);
    }
    body += para('<w:spacing w:line="240" w:lineRule="auto"/><w:jc w:val="both"/>', '', so);
  }
  const o = { b: true, sz: 26, u: true };
  return headerBlock(v, pb)
    + para('<w:pStyle w:val="Normal1"/><w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="center"/>', run(`Question Paper Set – ${batch.batch_name}`, o), o)
    + body + blank(1) + signatures(v);
}

// ─── Administrative reports (clean tables, same header) ─────────────────────
function simpleTable(headers, widths, data) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cell = (t, w, { b = false, jc = 'left' } = {}) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>`
    + para(`<w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/><w:jc w:val="${jc}"/>`, t === '' ? '' : run(t, { b, sz: 22 }), { b, sz: 22 }) + '</w:tc>';
  const head = `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${headers.map((h, i) => cell(h.label, widths[i], { b: true, jc: h.jc || 'left' })).join('')}</w:tr>`;
  const body = data.map(r => `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="400"/></w:trPr>${r.map((c, i) => cell(c, widths[i], { jc: headers[i].jc || 'left', b: !!headers[i].b })).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${total}" w:type="dxa"/>${TBL_BORDERS}<w:tblLook w:val="04A0"/></w:tblPr>`
    + `<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${head}${body}</w:tbl>`;
}

function infoLine(text) {
  const o = { b: true, sz: 24 };
  return para('<w:pStyle w:val="Normal1"/><w:spacing w:line="300" w:lineRule="auto"/>', run(text, o), o);
}

function studentAllocationSheet(d, v, pb, batch, allocations, generation) {
  const inv = [batch.invigilator_name, batch.additional_invigilators].filter(Boolean).join(', ');
  return headerBlock(v, pb) + sectionTitle('STUDENT-WISE QUESTION ALLOCATION')
    + infoLine(`Batch: ${batch.batch_name}     Students: ${allocations.length}     Invigilator: ${inv}`)
    + infoLine(`Allocation version ${generation.version} (${generation.mode})`) + tableGap()
    + simpleTable(
      [{ label: 'S.No', jc: 'center' }, { label: 'Roll Number', b: true }, { label: 'Student Name' }, { label: 'Part A', jc: 'center', b: true }, { label: 'Part B', jc: 'center', b: true }, { label: 'Signature' }],
      [700, 1800, 3135, 1100, 1100, 2400],
      allocations.map(r => [String(r.seq), r.roll_no, r.student_name || '', r.part_a_code, r.part_b_code, '']))
    + blank(3) + signatures(v);
}

function studentRegister(d, v, pb, batch) {
  const inv = [batch.invigilator_name, batch.additional_invigilators].filter(Boolean).join(', ');
  return headerBlock(v, pb) + sectionTitle('BATCH STUDENT REGISTER')
    + infoLine(`Batch: ${batch.batch_name}     Students: ${batch.students.length}     Invigilator: ${inv}`) + tableGap()
    + simpleTable(
      [{ label: 'S.No', jc: 'center' }, { label: 'Roll Number', b: true }, { label: 'Student Name' }, { label: 'Signature' }],
      [800, 2200, 4235, 3000],
      batch.students.map((s, i) => [String(i + 1), s.roll_no, s.name || '', '']))
    + blank(3) + signatures(v);
}

function invigilatorDuty(d, v, pb) {
  return headerBlock(v, pb) + sectionTitle('INVIGILATOR DUTY SHEET') + tableGap()
    + simpleTable(
      [{ label: 'S.No', jc: 'center' }, { label: 'Batch', b: true }, { label: 'Students', jc: 'center' }, { label: 'Invigilator(s)' }, { label: 'Signature' }],
      [800, 1900, 1200, 3835, 2500],
      (d.batches || []).map((b, i) => [String(i + 1), b.batch_name, String(b.students.length),
        [b.invigilator_name, b.additional_invigilators].filter(Boolean).join(', '), '']))
    + blank(3) + signatures(v);
}

// ─── Package assembly ────────────────────────────────────────────────────────
function assemble(bodyXml) {
  const zip = new AdmZip(TEMPLATE);
  const original = zip.readAsText('word/document.xml');
  const rootOpen = original.slice(0, original.indexOf('<w:body>'));
  const sectPr = (original.match(/<w:sectPr[\s\S]*?<\/w:sectPr>\s*<\/w:body>/) || [''])[0].replace(/<\/w:body>$/, '').trim();
  zip.updateFile('word/document.xml', Buffer.from(`${rootOpen}<w:body>${bodyXml}${sectPr}</w:body></w:document>`, 'utf8'));
  // Drop the template's stored title/author so the file carries no sample metadata.
  if (zip.getEntry('docProps/core.xml')) {
    const core = zip.readAsText('docProps/core.xml')
      .replace(/<dc:title>[\s\S]*?<\/dc:title>/, '<dc:title>Semester Practical Examinations</dc:title>')
      .replace(/<dc:creator>[\s\S]*?<\/dc:creator>/, '<dc:creator>PSG PEMS</dc:creator>')
      .replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, '<cp:lastModifiedBy>PSG PEMS</cp:lastModifiedBy>');
    zip.updateFile('docProps/core.xml', Buffer.from(core, 'utf8'));
  }
  return zip.toBuffer();
}

/**
 * Build a DOCX for one document key (see readiness.js for the list).
 * `extras.allocations` / `extras.generation` are required for student allocation sheets.
 */
function buildDocx(d, key, extras = {}) {
  const v = docValues(d);
  const [kind, idRaw] = key.split(':');
  const batch = idRaw ? (d.batches || []).find(b => String(b.id) === idRaw) : null;
  const setFor = b => (d.question_sets || []).find(s => String(s.batch_id) === String(b.id));
  let body;
  switch (kind) {
    case 'examination_document': {
      // One file: List of Experiments, Question Paper (Part A = first half of the experiments,
      // Part B = the rest, wording unchanged) and Allocation of Marks, each starting on a new page.
      const qd = { ...d, ...questionsFromExperiments(d.experiments || []) };
      body = listOfExperiments(d, v, false) + questionPaper(qd, v, true) + allocationOfMarks(d, v, true);
      break;
    }
    case 'list_of_experiments': body = listOfExperiments(d, v, false); break;
    case 'question_paper': body = questionPaper(d, v, false); break;
    case 'allocation_of_marks': body = allocationOfMarks(d, v, false); break;
    case 'batch_qp_set': body = batchQuestionSet(d, v, false, batch, setFor(batch)); break;
    case 'official_combined':
      body = listOfExperiments(d, v, false) + questionPaper(d, v, true) + allocationOfMarks(d, v, true)
        + (d.batches || []).map(b => batchQuestionSet(d, v, true, b, setFor(b))).join('');
      break;
    case 'student_allocation': body = studentAllocationSheet(d, v, false, batch, extras.allocations || [], extras.generation || {}); break;
    case 'student_register': body = studentRegister(d, v, false, batch); break;
    case 'invigilator_duty': body = invigilatorDuty(d, v, false); break;
    default: throw new Error('Unknown document type.');
  }
  return assemble(body);
}

/** Question paper made directly from the experiment list, numbering and wording preserved. */
function questionsFromExperiments(exps) {
  const list = exps.map(e => ({ q_no: e.exp_no, title: e.title, description: e.description, subquestions: e.subquestions || [] }));
  const half = Math.ceil(list.length / 2);
  return { part_a_questions: list.slice(0, half), part_b_questions: list.slice(half) };
}

/** e.g. Semester_Practical_Examination_I21451_April_2027.docx */
function examFileName(d, ext) {
  const safe = x => String(x || '').trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const e = d.exam || {}, s = d.subject || {};
  return ['Semester_Practical_Examination', safe(s.subject_code), safe(e.exam_month), safe(e.exam_year)].filter(Boolean).join('_') + '.' + ext;
}

function fileName(d, key, ext) {
  const v = docValues(d);
  const [kind, id] = key.split(':');
  const batch = id ? (d.batches || []).find(b => String(b.id) === id) : null;
  const names = {
    list_of_experiments: 'List-of-Experiments', question_paper: 'Question-Paper', allocation_of_marks: 'Allocation-of-Marks',
    batch_qp_set: 'Question-Paper-Set', official_combined: 'Official-Documents', student_allocation: 'Student-Allocation',
    student_register: 'Student-Register', invigilator_duty: 'Invigilator-Duty',
  };
  const safe = s => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  return [safe(v.code) || 'Exam', names[kind] || kind, batch ? safe(batch.batch_name) : ''].filter(Boolean).join('_') + '.' + ext;
}

module.exports = { buildDocx, fileName, examFileName, questionsFromExperiments, docValues, fmtDate, fmtTime };
