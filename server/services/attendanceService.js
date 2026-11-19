'use strict';
/**
 * Attendance sheets — independent of the examination document workflow.
 *
 * A sheet holds the examination details and a student list (name + roll number).
 * Every "Generate" writes a new numbered version (DOCX + PDF); earlier files are kept.
 *
 * Layout: the PSG template package supplies page size and margins (Letter, top 720,
 * bottom 900, left 1440, right 630 twips). All rows and lines use exact heights so the
 * position of the end of the table is known, and a spacer places the Internal (left) and
 * External (right) examiner signatures at the bottom of the final page.
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const XLSX = require('xlsx');
const { rows, one, query, uid } = require('../db');
const { docxToPdf } = require('./pdfConverter');

const TEMPLATE = path.join(__dirname, '../templates/official-reference.docx');
const STORE = path.join(__dirname, '../../var/attendance');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ROLL_RE = /^[A-Z0-9][A-Z0-9/-]{1,29}$/;

class AttendanceError extends Error { constructor(m, code = 422) { super(m); this.statusCode = code; } }
const str = v => (v === null || v === undefined ? '' : String(v)).trim();
const normRoll = v => str(v).toUpperCase().replace(/\s+/g, '');
const dateOrNull = v => (/^\d{4}-\d{2}-\d{2}/.test(str(v)) ? str(v).slice(0, 10) : null);
function ymd(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return str(v).slice(0, 10);
}

// ─── Storage ─────────────────────────────────────────────────────────────
async function owned(u, id) {
  const s = await one('SELECT * FROM attendance_sheets WHERE id = ?', [id]);
  if (!s || !s.id) throw new AttendanceError('Attendance sheet not found.', 404);
  if (u.role !== 'admin' && parseInt(s.owner_id, 10) !== parseInt(u.id, 10)) throw new AttendanceError('Not your attendance sheet.', 403);
  return s;
}

function shape(s, files = []) {
  let students = [];
  try { students = JSON.parse(s.students_json || '[]'); } catch { students = []; }
  return {
    id: s.id, exam_name: s.exam_name, subject_name: s.subject_name, subject_code: s.subject_code, department: s.department,
    semester: s.semester, exam_date: ymd(s.exam_date), batch_name: s.batch_name, internal_examiner: s.internal_examiner,
    external_examiner: s.external_examiner, roll_prefix: s.roll_prefix, students, created_at: s.created_at, updated_at: s.updated_at, files,
  };
}

async function list(u) {
  const sheets = await rows(`SELECT s.*, (SELECT COUNT(*) FROM attendance_files f WHERE f.sheet_id = s.id) AS versions
    FROM attendance_sheets s ${u.role === 'admin' ? '' : 'WHERE s.owner_id = ?'} ORDER BY s.updated_at DESC, s.id DESC`, u.role === 'admin' ? [] : [u.id]);
  const out = [];
  for (const s of sheets) {
    const latest = await one('SELECT * FROM attendance_files WHERE sheet_id = ? ORDER BY version DESC LIMIT 1', [s.id]);
    const sh = shape(s);
    out.push({ id: s.id, subject_name: s.subject_name, subject_code: s.subject_code, exam_date: sh.exam_date, batch_name: s.batch_name,
      student_count: sh.students.length, versions: parseInt(s.versions, 10), latest: latest && latest.id ? latest : null });
  }
  return out;
}

async function get(u, id) {
  const s = await owned(u, id);
  return shape(s, await rows('SELECT * FROM attendance_files WHERE sheet_id = ? ORDER BY version DESC', [id]));
}

function cleanStudents(list) {
  return (Array.isArray(list) ? list : []).map(x => ({ name: str(x && x.name).replace(/\s+/g, ' ').slice(0, 150), roll_no: normRoll(x && x.roll_no).slice(0, 30) }))
    .filter(x => x.name || x.roll_no);
}

async function save(u, d) {
  if (!u || (u.role !== 'staff' && u.role !== 'admin')) throw new AttendanceError('Staff access required.', 403);
  const id = parseInt(d.id || 0, 10);
  const vals = [
    str(d.exam_name) || 'Semester Practical Examinations', str(d.subject_name).slice(0, 200), str(d.subject_code).toUpperCase().slice(0, 50),
    str(d.department).slice(0, 150), str(d.semester).slice(0, 20), dateOrNull(d.exam_date), str(d.batch_name).slice(0, 100),
    str(d.internal_examiner).slice(0, 150), str(d.external_examiner).slice(0, 150), normRoll(d.roll_prefix).slice(0, 30),
    JSON.stringify(cleanStudents(d.students)),
  ];
  if (id > 0) {
    await owned(u, id);
    await query('UPDATE attendance_sheets SET exam_name=?, subject_name=?, subject_code=?, department=?, semester=?, exam_date=?, batch_name=?, internal_examiner=?, external_examiner=?, roll_prefix=?, students_json=? WHERE id=?', [...vals, id]);
    return { ok: true, id };
  }
  const newId = uid(await query('INSERT INTO attendance_sheets (exam_name, subject_name, subject_code, department, semester, exam_date, batch_name, internal_examiner, external_examiner, roll_prefix, students_json, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...vals, u.id]));
  return { ok: true, id: newId };
}

async function remove(u, id) {
  await owned(u, id);
  await query('DELETE FROM attendance_sheets WHERE id = ?', [id]);
  fs.rmSync(path.join(STORE, `sheet-${parseInt(id, 10)}`), { recursive: true, force: true });
  return { ok: true };
}

/** What stops the sheet from being printed. */
function problems(sh) {
  const out = [];
  if (!str(sh.subject_name)) out.push('Subject name');
  if (!str(sh.exam_date)) out.push('Examination date');
  if (!sh.students.length) out.push('At least one student');
  const noRoll = sh.students.filter(s => !s.roll_no).length;
  if (noRoll) out.push(`Roll number for ${noRoll} student${noRoll === 1 ? '' : 's'}`);
  const noName = sh.students.filter(s => !s.name).length;
  if (noName) out.push(`Name for ${noName} student${noName === 1 ? '' : 's'}`);
  const bad = sh.students.filter(s => s.roll_no && !ROLL_RE.test(s.roll_no)).map(s => s.roll_no);
  if (bad.length) out.push(`Valid roll numbers (check ${bad.slice(0, 5).join(', ')})`);
  const seen = new Set(), dup = new Set();
  for (const s of sh.students) { if (!s.roll_no) continue; if (seen.has(s.roll_no)) dup.add(s.roll_no); seen.add(s.roll_no); }
  if (dup.size) out.push(`Unique roll numbers (repeated: ${[...dup].slice(0, 5).join(', ')})`);
  return out;
}

// ─── Import (Excel / CSV / Word): Student Name, Roll Number (optional) ───
const looksRoll = v => { if (/\s/.test(str(v))) return false; const t = normRoll(v); return ROLL_RE.test(t) && /\d/.test(t) && /[A-Z]/.test(t); };
const looksSno = v => /^\d{1,4}[.)]?$/.test(str(v));
const looksName = v => /[A-Za-z]{2}/.test(str(v)) && !looksRoll(v);

/** Rows of cells from a .docx: tables when present, otherwise one row per paragraph line. */
function docxRows(buffer) {
  let xml;
  try { xml = new AdmZip(buffer).readAsText('word/document.xml'); } catch { throw new AttendanceError('The Word file could not be read. Save it as .docx and try again.'); }
  if (!xml) throw new AttendanceError('The Word file could not be read. Save it as .docx and try again.');
  const text = frag => (frag.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || [frag]).map(par =>
    (par.match(/<w:t[^>]*>[\s\S]*?<\/w:t>|<w:tab\/>/g) || []).map(t => t === '<w:tab/>' ? '\t' : t.replace(/<[^>]+>/g, '')).join('')
  ).join(' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/[ \u00a0]+/g, ' ').trim();
  const tables = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
  if (tables.length) {
    const out = [];
    for (const t of tables) for (const tr of t.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || []) out.push((tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(text));
    return out;
  }
  // Plain list: "1. Name", "24DI01 Name", "Name - 24DI01", "Name, 24DI01" or tab separated.
  let lines = (xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || []).map(text).filter(Boolean).filter(l => !/:\s*$/.test(l));
  // Titles ("Student list", "Batch A") are dropped when most lines are numbered or carry a roll number.
  const marked = l => /^\s*\d{1,4}\s*[.)\-:]\s+/.test(l) || l.split(/[\s,;|	]+/).some(looksRoll);
  if (lines.filter(marked).length >= lines.length / 2) lines = lines.filter(marked);
  return lines.map(line => {
    const l = line.replace(/^\s*\d{1,4}\s*[.)\-:]\s+/, '').trim();
    const cells = l.split(/\t|\s*[,;|]\s*|\s+[-–]\s+/).map(c => c.trim()).filter(Boolean);
    if (cells.length > 1) return cells;
    const m = l.match(/^([A-Za-z0-9/-]*\d[A-Za-z0-9/-]*)\s+(.+)$/) || l.match(/^(.+?)\s+([A-Za-z0-9/-]*\d[A-Za-z0-9/-]*)$/);
    if (m && looksRoll(m[1])) return [m[2], m[1]];
    if (m && looksRoll(m[2])) return [m[1], m[2]];
    return [l];
  });
}

function parseImport(buffer, fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  let data;
  if (ext === 'docx') data = docxRows(buffer);
  else if (ext === 'doc') throw new AttendanceError('Old Word (.doc) files cannot be read. Open the file in Word and save it as .docx.');
  else {
    let wb;
    if (ext === 'csv') wb = XLSX.read(buffer.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string', raw: true });
    else if (ext === 'xlsx' || ext === 'xls') wb = XLSX.read(buffer, { type: 'buffer' });
    else throw new AttendanceError('Use an Excel (.xlsx, .xls), CSV or Word (.docx) file.');
    data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
  }
  data = data.map(r => r.map(c => str(c)));
  // Skip title lines above a heading row (for example "Attendance list – Batch A").
  let start = 0, nameCol = -1, rollCol = -1;
  const isNameHead = c => /^(student'?s?\s*)?names?(\s+of\s+(the\s+)?students?)?$|^name\s+of\s+(the\s+)?students?$/i.test(str(c));
  const isRollHead = c => /^(roll|reg(ister|istration)?)\.?\s*(no|number|num)?\.?$/i.test(str(c));
  const hi = data.slice(0, 8).findIndex(r => r.some(isNameHead) || (r.some(isRollHead) && !r.some(looksRoll)));
  if (hi >= 0) {
    const h = data[hi].map(c => c.toLowerCase());
    nameCol = data[hi].findIndex(isNameHead); rollCol = data[hi].findIndex(isRollHead);
    if (nameCol < 0) nameCol = h.findIndex(c => /name/.test(c));
    if (rollCol < 0) rollCol = h.findIndex(c => /roll|reg/.test(c));
    if (nameCol < 0) nameCol = h.findIndex((c, i) => i !== rollCol && !/s\.?\s*no|serial|sl/.test(c));
    start = hi + 1;
  } else {
    // No heading: pick the columns from what the cells look like.
    const body = data.filter(r => r.some(Boolean));
    const width = Math.max(0, ...body.map(r => r.length));
    const score = (i, fn) => body.filter(r => fn(r[i] || '')).length;
    let best = -1, bestN = 0, rb = -1, rbN = 0;
    for (let i = 0; i < width; i++) {
      const n = score(i, looksName), rr = score(i, looksRoll);
      if (n > bestN) { best = i; bestN = n; }
      if (rr > rbN) { rb = i; rbN = rr; }
    }
    nameCol = best >= 0 ? best : 0;
    rollCol = rb >= 0 && rb !== nameCol && rbN >= Math.max(1, body.length / 3) ? rb : -1;
  }
  const students = [], duplicates = [], invalid = [], seen = {};
  let total = 0;
  for (let i = start; i < data.length; i++) {
    const r = data[i];
    if (!r.some(Boolean)) continue;
    // Repeated heading rows (Word tables split over pages) are skipped.
    if (r.some(isNameHead) && r.some(c => isRollHead(c) || /^s\.?\s*no\.?$/i.test(c))) continue;
    total++;
    let name = str(r[nameCol]).replace(/\s+/g, ' ');
    let roll = rollCol >= 0 ? normRoll(r[rollCol]) : '';
    const row = i + 1;
    if (!name || looksSno(name)) { invalid.push({ row, name, roll, reason: 'Student name is empty' }); continue; }
    if (roll && !ROLL_RE.test(roll)) { invalid.push({ row, name, roll, reason: 'Roll number has invalid characters' }); continue; }
    if (roll && seen[roll]) { duplicates.push({ row, name, roll, reason: `Same roll number as row ${seen[roll]}` }); continue; }
    if (roll) seen[roll] = row;
    students.push({ name: name.slice(0, 150), roll_no: roll });
  }
  if (!total) throw new AttendanceError('No student names were found in the file.');
  return { total_rows: total, valid_count: students.length, without_roll: students.filter(s => !s.roll_no).length,
    duplicate_count: duplicates.length, invalid_count: invalid.length, duplicates, invalid, students };
}

// ─── Word document ───────────────────────────────────────────────────────
const H = 15840 - 720 - 900;           // usable page height (twips)
const W = 12240 - 1440 - 630;          // usable page width
const ROW_HEAD = 500, ROW = 560;       // header row, student row (room for a signature)
const SIG = [900, 330, 330];           // signing space, labels, names
const SAFETY = 240;
const COLS = [900, 4270, 1800, W - 900 - 4270 - 1800];
const TNR = '<w:rFonts w:ascii="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>';

const xe = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const rp = ({ b, u, sz = 24 } = {}) => `<w:rPr>${TNR}${b ? '<w:b/>' : ''}${u ? '<w:u w:val="single"/>' : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
const r = (t, o) => `<w:r>${rp(o)}<w:t xml:space="preserve">${xe(t)}</w:t></w:r>`;
const tb = o => `<w:r>${rp(o)}<w:tab/></w:r>`;
const p = (h, runs, { jc = 'left', tabs = '', extra = '', o = {} } = {}) =>
  `<w:p><w:pPr>${extra}${tabs}<w:spacing w:before="0" w:after="0" w:line="${h}" w:lineRule="exact"/><w:jc w:val="${jc}"/>${rp(o)}</w:pPr>${runs}</w:p>`;

function fmtDate(v) { const m = str(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; }
function monthYear(v) { const m = str(v).match(/^(\d{4})-(\d{2})/); return m ? { month: MONTHS[+m[2] - 1], year: m[1] } : { month: '', year: '' }; }

function headerLines(sh) {
  const my = monthYear(sh.exam_date);
  const tabs = '<w:tabs><w:tab w:val="left" w:pos="6480"/></w:tabs>';
  const L = [], B = { b: true }, N = {};
  L.push([440, p(440, r('PSG POLYTECHNIC COLLEGE', { b: true, sz: 32 }), { jc: 'center' })]);
  L.push([380, p(380, r(`${str(sh.exam_name).toUpperCase()}${my.month ? ` – ${my.month.toUpperCase()} ${my.year}` : ''}`, { b: true, sz: 26 }), { jc: 'center' })]);
  L.push([400, p(400, r('ATTENDANCE SHEET', { b: true, sz: 26, u: true }), { jc: 'center' })]);
  L.push([200, p(200, '')]);
  const subj = sh.subject_name + (sh.subject_code ? ` (${sh.subject_code})` : '');
  L.push([360, p(360, r('Subject: ', B) + r(subj, N) + tb(N) + r('Date: ', B) + r(fmtDate(sh.exam_date), N), { tabs })]);
  L.push([360, p(360, r('Department: ', B) + r(sh.department, N) + tb(N) + r('Semester: ', B) + r(sh.semester, N), { tabs })]);
  if (str(sh.batch_name)) L.push([360, p(360, r('Batch: ', B) + r(sh.batch_name, N) + tb(N) + r('Students: ', B) + r(String(sh.students.length), N), { tabs })]);
  else L.push([360, p(360, r('Students: ', B) + r(String(sh.students.length), N))]);
  L.push([200, p(200, '')]);
  return { xml: L.map(x => x[1]).join(''), height: L.reduce((n, x) => n + x[0], 0) };
}

function table(sh) {
  const border = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(k => `<w:${k} w:val="single" w:sz="6" w:space="0" w:color="000000"/>`).join('') + '</w:tblBorders>';
  const cell = (w, text, { b = false, jc = 'left' } = {}) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${p(280, text === '' ? '' : r(text, { b }), { jc, o: { b } })}</w:tc>`;
  const head = `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${ROW_HEAD}" w:hRule="exact"/><w:tblHeader/></w:trPr>`
    + cell(COLS[0], 'S.No.', { b: true, jc: 'center' }) + cell(COLS[1], 'Name', { b: true }) + cell(COLS[2], 'Roll No.', { b: true, jc: 'center' }) + cell(COLS[3], 'Signature', { b: true, jc: 'center' }) + '</w:tr>';
  const body = sh.students.map((s, i) => `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${ROW}" w:hRule="exact"/></w:trPr>`
    + cell(COLS[0], String(i + 1), { jc: 'center' }) + cell(COLS[1], s.name) + cell(COLS[2], s.roll_no, { jc: 'center' }) + cell(COLS[3], '') + '</w:tr>').join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${W}" w:type="dxa"/>${border}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="04A0"/></w:tblPr>`
    + `<w:tblGrid>${COLS.map(c => `<w:gridCol w:w="${c}"/>`).join('')}</w:tblGrid>${head}${body}</w:tbl>`;
}

/** Height used on the last page by the table, so the signatures can sit at the page bottom. */
function lastPageUsed(headerH, n) {
  const rows1 = Math.floor((H - headerH - ROW_HEAD) / ROW);
  if (n <= rows1) return { used: headerH + ROW_HEAD + n * ROW, pages: 1 };
  const per = Math.floor((H - ROW_HEAD) / ROW);
  const rest = n - rows1;
  const extra = Math.ceil(rest / per);
  const k = rest - (extra - 1) * per;
  return { used: ROW_HEAD + k * ROW, pages: 1 + extra };
}

function signatures(sh, spacer, newPage) {
  const sigH = SIG.reduce((a, b) => a + b, 0);
  const keep = '<w:keepNext/><w:keepLines/>';
  const tabs = `<w:tabs><w:tab w:val="right" w:pos="${W}"/></w:tabs>`;
  const B = { b: true };
  let xml = '';
  if (newPage) xml += p(Math.max(20, H - sigH - SAFETY), '', { extra: '<w:pageBreakBefore/>' + keep });
  else if (spacer >= 20) xml += p(spacer, '', { extra: keep });
  xml += p(SIG[0], '', { extra: keep });
  xml += p(SIG[1], r('Internal Examiner', B) + tb(B) + r('External Examiner', B), { tabs, extra: keep });
  xml += p(SIG[2], r(sh.internal_examiner || '', {}) + tb({}) + r(sh.external_examiner || '', {}), { tabs });
  return xml;
}

function buildDocx(sh) {
  const head = headerLines(sh);
  const sigH = SIG.reduce((a, b) => a + b, 0);
  const { used } = lastPageUsed(head.height, sh.students.length);
  const room = H - used;
  const fits = room >= sigH + SAFETY;
  const body = head.xml + table(sh) + signatures(sh, fits ? room - sigH - SAFETY : 0, !fits);
  const zip = new AdmZip(TEMPLATE);
  const doc = zip.readAsText('word/document.xml');
  const sect = doc.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/)[0];
  zip.updateFile('word/document.xml', Buffer.from(`${doc.slice(0, doc.indexOf('<w:body>'))}<w:body>${body}${sect}</w:body></w:document>`, 'utf8'));
  if (zip.getEntry('docProps/core.xml')) {
    const core = zip.readAsText('docProps/core.xml')
      .replace(/<dc:title>[\s\S]*?<\/dc:title>/, '<dc:title>Attendance Sheet</dc:title>')
      .replace(/<dc:creator>[\s\S]*?<\/dc:creator>/, '<dc:creator>PSG PEMS</dc:creator>')
      .replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, '<cp:lastModifiedBy>PSG PEMS</cp:lastModifiedBy>');
    zip.updateFile('docProps/core.xml', Buffer.from(core, 'utf8'));
  }
  return zip.toBuffer();
}

/** e.g. Attendance_Sheet_24DI_April_2027.docx (batch added when set, _v2 for later versions). */
function baseName(sh, version) {
  const safe = x => str(x).replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const my = monthYear(sh.exam_date);
  const key = sh.roll_prefix || sh.subject_code || 'Sheet';
  return ['Attendance_Sheet', safe(key), safe(sh.batch_name), my.month, my.year].filter(Boolean).join('_') + (version > 1 ? `_v${version}` : '');
}

async function preview(u, id) {
  const sh = await get(u, id);
  const miss = problems(sh);
  if (miss.length) throw new AttendanceError('Fill in: ' + miss.join(', ') + '.');
  return docxToPdf(buildDocx(sh));
}

async function generate(u, id) {
  const sh = await get(u, id);
  const miss = problems(sh);
  if (miss.length) throw new AttendanceError('Fill in: ' + miss.join(', ') + '.');
  const docx = buildDocx(sh);
  const pdf = await docxToPdf(docx);
  const prev = await one('SELECT COALESCE(MAX(version), 0) v FROM attendance_files WHERE sheet_id = ?', [id]);
  const version = parseInt(prev.v, 10) + 1;
  const dir = path.join(STORE, `sheet-${parseInt(id, 10)}`, `v${version}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = baseName(sh, version);
  fs.writeFileSync(path.join(dir, base + '.docx'), docx);
  fs.writeFileSync(path.join(dir, base + '.pdf'), pdf);
  await query('INSERT INTO attendance_files (sheet_id, version, docx_name, pdf_name, student_count, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [id, version, base + '.docx', base + '.pdf', sh.students.length, u.id]);
  return { ok: true, version, docx_name: base + '.docx', pdf_name: base + '.pdf', docx_size: docx.length, pdf_size: pdf.length, student_count: sh.students.length };
}

async function file(u, id, version, format) {
  await owned(u, id);
  const f = version > 0
    ? await one('SELECT * FROM attendance_files WHERE sheet_id = ? AND version = ?', [id, version])
    : await one('SELECT * FROM attendance_files WHERE sheet_id = ? ORDER BY version DESC LIMIT 1', [id]);
  if (!f || !f.id) throw new AttendanceError('Generate the attendance sheet first.', 404);
  const name = format === 'pdf' ? f.pdf_name : f.docx_name;
  const full = path.join(STORE, `sheet-${parseInt(id, 10)}`, `v${f.version}`, name);
  if (!fs.existsSync(full)) throw new AttendanceError('The file is missing on the server. Generate the sheet again.', 404);
  return { name, bytes: fs.readFileSync(full) };
}

module.exports = { list, get, save, remove, problems, parseImport, buildDocx, lastPageUsed, preview, generate, file, baseName };
