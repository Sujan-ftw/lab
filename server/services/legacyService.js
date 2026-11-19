'use strict';
/**
 * Legacy Service — ports app/generations.php + app/engine.php to Node.js.
 * Handles: save, generate, session, capacity, finalize, overview, user, saveLibrary, library, import, export, report
 */
const crypto = require('crypto');
const { rows, one, query, uid, tx } = require('../db');
const { audit } = require('../auth');
const XLSX = require('xlsx');

// ─── Error helpers ────────────────────────────────────────────────────────────
class DomainError extends Error {
  constructor(msg) { super(msg); this.statusCode = 422; }
}

function need(ok, msg) {
  if (!ok) throw new DomainError(msg);
}

function field(v, max, required = false) {
  need(v !== null && v !== undefined && typeof v !== 'object', 'Invalid field.');
  v = String(v).trim();
  need(v.length <= max && (!required || v !== ''), 'A required field is missing or too long.');
  return v;
}

function syllabus(items) {
  need(Array.isArray(items) && items.length >= 2 && items.length <= 500, 'Enter 2 to 500 syllabus items.');
  const seen = {};
  const out = [];
  for (const r of items) {
    const n = parseInt(r.num);
    need(Number.isInteger(n) && n >= 1 && n <= 2147483647 && !seen[n], 'Question numbers must be unique positive integers.');
    seen[n] = true;
    out.push({ num: n, topic: field(r.topic ?? '', 500, true) });
  }
  return out;
}

function roster(items, expected) {
  need(expected > 0 && expected <= 5000 && items.length === expected, 'The roster must match the student count (1–5000).');
  const seen = {};
  const out = [];
  for (const r of items) {
    const roll = field(r.roll ?? '', 60, true).toUpperCase();
    need(/^[A-Z0-9][A-Z0-9./_-]*$/.test(roll), 'Invalid roll number.');
    need(!seen[roll], 'Duplicate roll number: ' + roll);
    seen[roll] = true;
    out.push({ roll, name: field(r.name ?? '', 120) });
  }
  return out;
}

// ─── Secure Shuffle (Fisher-Yates) ───────────────────────────────────────────
function secureShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ─── Circle-schedule pair generation ─────────────────────────────────────────
function generatePairs(nums, count, mode, excluded = {}) {
  need(['Balanced Random', 'Pure Random'].includes(mode), 'Unknown generation mode.');
  nums = [...nums];
  secureShuffle(nums);

  const ring = [...nums];
  if (ring.length % 2) ring.push(null);
  const len = ring.length;
  const rounds = [];

  for (let r = 1; r < len; r++) {
    const round = [];
    for (let i = 0; i < len / 2; i++) {
      const a = ring[i], b = ring[len - 1 - i];
      if (a === null || b === null) continue;
      const p = [Math.min(a, b), Math.max(a, b)];
      const key = p.join(':');
      if (!excluded[key]) round.push(p);
    }
    secureShuffle(round);
    rounds.push(round);
    // Rotate ring (keep index 0 fixed, rotate tail)
    const tail = ring.pop();
    ring.splice(1, 0, tail);
  }

  secureShuffle(rounds);
  const pool = rounds.flat();
  need(count <= pool.length, `Only ${pool.length} unique combinations are available for ${count} students.`);
  if (mode === 'Pure Random') secureShuffle(pool);
  const chosen = pool.slice(0, count);
  secureShuffle(chosen);
  const unique = new Set(chosen.map(p => p.join(':'))).size;
  need(unique === count, 'Combination validation failed.');
  return chosen;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function requireAdmin(u) {
  if (!u || u.role !== 'admin') { const e = new Error('Administrator access required.'); e.statusCode = 403; throw e; }
}
function requireStaff(u) {
  if (!u || (u.role !== 'staff' && u.role !== 'admin')) { const e = new Error('Staff access required.'); e.statusCode = 403; throw e; }
}

async function ownedSession(id, u, forUpdate = false) {
  const sql = `SELECT * FROM sessions WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`;
  const s = await one(sql, [id]);
  need(!!s, 'Session not found.');
  need(u.role === 'admin' || parseInt(s.owner) === parseInt(u.id), 'Access denied.');
  return s;
}

// ─── Metadata helpers ─────────────────────────────────────────────────────────
function metadata(m, strict) {
  const out = {};
  for (const k of ['title', 'department', 'programme', 'batch', 'academicYear', 'semester', 'studyYear', 'subject', 'code', 'exam', 'date', 'remarks']) {
    out[k] = field(m[k] ?? '', k === 'remarks' ? 500 : 160, strict && k !== 'remarks');
  }
  if (strict) {
    const d = out.date;
    need(/^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d).getTime()), 'Invalid generation date.');
  }
  return out;
}

async function historical(u, d) {
  if (!d.noReuse) return {};
  const list = await rows(
    "SELECT DISTINCT p.q1,p.q2 FROM pairs p JOIN versions v ON p.version_id=v.id JOIN sessions s ON v.session_id=s.id WHERE s.owner=? AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(v.meta,'$.code')))=LOWER(?)",
    [u.id, d.meta?.code ?? '']
  );
  const set = {};
  for (const p of list) set[p.q1 + ':' + p.q2] = true;
  return set;
}

// ─── Main handlers ────────────────────────────────────────────────────────────
async function saveGeneration(u, d, generate) {
  requireStaff(u);
  const m = metadata(d.meta ?? {}, generate);
  d.meta = m;
  need((d.students?.length ?? 0) <= 5000 && (d.items?.length ?? 0) <= 500, 'List limit exceeded.');

  return tx(async (conn) => {
    await conn.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [u.id]);
    let sid = parseInt(d.id ?? 0);

    if (sid) {
      const s = await ownedSession(sid, u, true);
      need(generate || s.status === 'Draft', 'Save changes by generating a new version.');
    } else {
      await conn.execute('INSERT INTO sessions(owner,draft) VALUES (?,?)', [u.id, JSON.stringify(d)]);
      sid = await uid(conn);
      await audit(u.id, 'Draft', 'Created generation session', sid);
    }

    if (!generate) {
      await conn.execute('UPDATE sessions SET draft=?,modified=UTC_TIMESTAMP() WHERE id=?', [JSON.stringify(d), sid]);
      await audit(u.id, 'Draft', `Saved draft with ${d.students?.length ?? 0} roster rows and ${d.items?.length ?? 0} syllabus items`, sid);
      return { id: sid };
    }

    const start = (await one('SELECT UTC_TIMESTAMP(6) t')).t;
    const students = roster(d.students, parseInt(d.count));
    const items = syllabus(d.items);
    const pairs = generatePairs(items.map(i => i.num), students.length, d.mode, await historical(u, d));

    const revRow = await one('SELECT MAX(version) n FROM versions WHERE session_id=?', [sid]);
    const rev = 1 + parseInt(revRow.n ?? 0);

    await conn.execute(
      "INSERT INTO versions(session_id,version,meta,mode,no_reuse,algorithm,reason,started,completed) VALUES (?,?,?,?,?,'circle-fisher-yates/1',?,?,UTC_TIMESTAMP(6))",
      [sid, rev, JSON.stringify(m), d.mode, d.noReuse ? 1 : 0, field(d.reason ?? '', 500), start]
    );
    const vid = await uid(conn);

    for (const [i, r] of items.entries()) {
      await conn.execute('INSERT INTO items VALUES (?,?,?,?)', [vid, r.num, r.topic, i]);
    }
    for (const [i, r] of students.entries()) {
      await conn.execute('INSERT INTO students VALUES (?,?,?,?)', [vid, i + 1, r.roll, r.name]);
      await conn.execute('INSERT INTO pairs VALUES (?,?,?,?)', [vid, r.roll, ...pairs[i]]);
    }

    await conn.execute('UPDATE versions SET completed=UTC_TIMESTAMP(6) WHERE id=?', [vid]);
    await conn.execute("UPDATE sessions SET draft=?,status='Generated',modified=UTC_TIMESTAMP() WHERE id=?", [JSON.stringify(d), sid]);
    await audit(u.id, rev > 1 ? 'Regenerated' : 'Generated', `${students.length} unique combinations · version ${rev}`, sid, vid);
    return { id: sid, vid };
  });
}

async function readSession(id, u, vid = 0) {
  const s = await ownedSession(id, u);
  s.draft = JSON.parse(s.draft || '{}');
  const staffRow = await one('SELECT name FROM users WHERE id=?', [s.owner]);
  s.staff = staffRow?.name ?? '';
  s.versions = await rows('SELECT id,version,mode,algorithm,started,completed,finalized,reason,no_reuse FROM versions WHERE session_id=? ORDER BY version DESC', [id]);
  vid = vid || (s.versions[0]?.id ?? 0);
  if (vid) {
    const v = await one('SELECT * FROM versions WHERE session_id=? AND id=?', [id, vid]);
    need(!!v, 'Unknown generation version.');
    v.meta = JSON.parse(v.meta || '{}');
    const cRow = await one('SELECT COUNT(*) n FROM students WHERE version_id=?', [vid]);
    v.studentCount = parseInt(cRow.n);
    v.items = await rows('SELECT num,topic FROM items WHERE version_id=? ORDER BY seq', [vid]);
    v.rows = await rows('SELECT s.seq,s.roll,s.name,p.q1,p.q2 FROM students s JOIN pairs p ON s.version_id=p.version_id AND s.roll=p.roll WHERE s.version_id=? ORDER BY s.seq', [vid]);
    s.selected = v;
  }
  return s;
}

async function finalize(u, d) {
  requireStaff(u);
  return tx(async (conn) => {
    const s = await ownedSession(d.id, u, true);
    const v = await one('SELECT id,finalized FROM versions WHERE session_id=? ORDER BY version DESC LIMIT 1', [s.id]);
    need(v && String(v.id) === String(d.vid) && !v.finalized, 'Only the current preview can be finalized.');
    const check = await one(
      'SELECT (SELECT COUNT(*) FROM students WHERE version_id=?) expected,(SELECT COUNT(*) FROM pairs WHERE version_id=?) assigned',
      [v.id, v.id]
    );
    need(check.expected > 0 && check.expected == check.assigned, 'Roster and assignment counts must match.');
    await conn.execute('UPDATE versions SET finalized=UTC_TIMESTAMP() WHERE id=?', [v.id]);
    await conn.execute("UPDATE sessions SET status='Finalized',modified=UTC_TIMESTAMP() WHERE id=?", [s.id]);
    await audit(u.id, 'Finalized', 'Confirmed and finalized assignments', s.id, v.id);
    return { ok: true };
  });
}

async function overview(u) {
  const admin = u.role === 'admin';
  const args = admin ? [] : [u.id];
  const scope = admin ? '' : ' WHERE s.owner=?';

  const sessions = await rows(
    `SELECT s.id,s.owner,s.created,s.modified,s.status,u.name staff,COALESCE(v.meta,JSON_EXTRACT(s.draft,'$.meta')) metadata,v.id vid,v.version,v.completed,v.mode,COALESCE((SELECT COUNT(*) FROM students WHERE version_id=v.id),0) n,(SELECT COUNT(*) FROM items WHERE version_id=v.id) itemCount FROM sessions s JOIN users u ON s.owner=u.id LEFT JOIN versions v ON v.id=(SELECT MAX(id) FROM versions WHERE session_id=s.id)${scope} ORDER BY s.modified DESC,s.id DESC`,
    args
  );
  for (const s of sessions) {
    s.meta = JSON.parse(s.metadata || '{}');
    delete s.metadata;
  }

  const events = await rows(
    `SELECT e.*,u.name staff,v.meta snapshot,(SELECT COUNT(*) FROM pairs WHERE version_id=e.version_id) pair_count FROM events e JOIN users u ON u.id=e.actor LEFT JOIN versions v ON v.id=e.version_id${admin ? '' : ' WHERE e.actor=?'} ORDER BY e.id DESC`,
    args
  );
  for (const ev of events) ev.snapshot = ev.snapshot ? JSON.parse(ev.snapshot) : null;

  const exports = await rows(
    `SELECT x.*,v.session_id,v.version,u.name staff FROM exports x JOIN versions v ON v.id=x.version_id JOIN users u ON u.id=x.actor${admin ? '' : ' WHERE x.actor=?'} ORDER BY x.id DESC`,
    args
  );

  const lib = await rows(
    "SELECT l.id,l.created,r.id revision,r.version,r.meta,r.created modified,(SELECT COUNT(*) FROM library_items WHERE revision=r.id) n FROM library l JOIN library_versions r ON r.id=(SELECT MAX(id) FROM library_versions WHERE lib=l.id) WHERE l.owner=? ORDER BY r.id DESC",
    [u.id]
  );
  for (const l of lib) l.meta = JSON.parse(l.meta || '{}');

  let people = [];
  if (admin) {
    people = await rows(
      "SELECT u.id,u.name,u.email,u.active,u.last_login,d.name department,EXISTS(SELECT 1 FROM connections c WHERE c.user_id=u.id AND seen>UTC_TIMESTAMP()-INTERVAL 30 MINUTE) online,(SELECT MAX(at) FROM events WHERE actor=u.id) last_activity FROM users u JOIN departments d ON d.id=u.department_id WHERE role='staff' ORDER BY u.name"
    );
  }

  const tzRow = await one("SELECT val FROM settings WHERE k='timezone'");
  return { sessions, events, exports, lib, people, timezone: tzRow?.val ?? 'Asia/Kolkata' };
}

async function manageUser(u, d) {
  requireAdmin(u);
  const bcrypt = require('bcryptjs');
  const name = field(d.name ?? '', 120, true);
  const email = field(d.email ?? '', 190, true);
  need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Invalid email address.');
  const dep = field(d.department ?? '', 120, true);
  const pw = d.password ?? '';
  const id = parseInt(d.id ?? 0);
  need((id && pw === '') || (pw.length >= 14 && pw.length <= 72), 'Use a password of 14–72 bytes.');

  return tx(async (conn) => {
    await conn.execute('INSERT IGNORE INTO departments(name) VALUES (?)', [dep]);
    const deptRow = await one('SELECT id FROM departments WHERE name=?', [dep]);
    const dept = deptRow.id;

    if (id) {
      const [rs] = await conn.execute("SELECT id FROM users WHERE id=? AND role='staff' FOR UPDATE", [id]);
      need(rs.length > 0, 'Staff account unavailable.');
      await conn.execute('UPDATE users SET name=?,email=?,department_id=?,active=?,epoch=epoch+1 WHERE id=?', [name, email, dept, d.active ? 1 : 0, id]);
      if (pw) await conn.execute('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(pw, 10), id]);
      await conn.execute('DELETE FROM connections WHERE user_id=?', [id]);
    } else {
      await conn.execute("INSERT INTO users(name,email,department_id,role,password_hash) VALUES (?,?,?,'staff',?)", [name, email, dept, await bcrypt.hash(pw, 10)]);
      const newId = await uid(conn);
      await audit(u.id, 'Account', `Managed staff account #${newId}`);
    }
    await audit(u.id, 'Account', `Managed staff account #${id}`);
    return { ok: true };
  });
}

async function saveLibrary(u, d) {
  requireStaff(u);
  const items = syllabus(d.items);
  const m = {};
  for (const k of ['title', 'subject', 'code', 'department', 'semester', 'scheme']) {
    m[k] = field(d.meta?.[k] ?? '', 160, true);
  }

  return tx(async (conn) => {
    let id = parseInt(d.id ?? 0);
    if (id) {
      const [rs] = await conn.execute('SELECT id FROM library WHERE owner=? AND id=? FOR UPDATE', [u.id, id]);
      need(rs.length > 0, 'Syllabus unavailable.');
    } else {
      await conn.execute('INSERT INTO library(owner) VALUES (?)', [u.id]);
      id = await uid(conn);
    }
    const revRow = await one('SELECT MAX(version) n FROM library_versions WHERE lib=?', [id]);
    const rev = 1 + parseInt(revRow.n ?? 0);
    await conn.execute('INSERT INTO library_versions(lib,version,meta) VALUES (?,?,?)', [id, rev, JSON.stringify(m)]);
    const rid = await uid(conn);
    for (const [i, item] of items.entries()) {
      await conn.execute('INSERT INTO library_items VALUES (?,?,?,?)', [rid, i, item.num, item.topic]);
    }
    await audit(u.id, 'Syllabus', `Saved syllabus #${id} version ${rev}`);
    return { id };
  });
}

// ─── File import (CSV / XLSX) ─────────────────────────────────────────────────
async function importFile(u, kind, fileBuffer, originalName) {
  requireStaff(u);
  const ext = (originalName || '').split('.').pop().toLowerCase();
  const limit = kind === 'items' ? 501 : 5001;
  const data = [];

  if (ext === 'csv') {
    const text = fileBuffer.toString('utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      // Simple CSV parse (handles quoted fields)
      const row = [];
      let cur = '', inQ = false;
      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci];
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { row.push(cur); cur = ''; }
        else cur += ch;
      }
      row.push(cur);
      data.push(row);
      need(data.length <= limit, 'Too many records.');
    }
  } else if (ext === 'xlsx' || ext === 'xls') {
    const wb = XLSX.read(fileBuffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    for (const r of rawRows) {
      data.push([String(r[0] ?? ''), String(r[1] ?? '')]);
      need(data.length <= limit, 'Too many records.');
    }
  } else {
    need(false, 'Supported formats are CSV and XLSX.');
  }

  // Strip header
  if (data.length > 0) {
    const first = String(data[0][0] ?? '').replace(/^\uFEFF/, '').toLowerCase().trim();
    if (/^(roll( number| no\.?)?|question( number| no\.?)?|number|num)$/.test(first)) {
      data.shift();
    }
  }

  const out = data
    .filter(r => !(r.length === 1 && !r[0]))
    .map(r => kind === 'items'
      ? { num: String(r[0] ?? '').trim(), topic: String(r[1] ?? '').trim() }
      : { roll: String(r[0] ?? '').trim(), name: String(r[1] ?? '').trim() }
    );

  await audit(u.id, 'Imported', `Imported ${out.length} ${kind} rows`);
  return { rows: out };
}

// ─── Export result (legacy) ──────────────────────────────────────────────────
async function exportResult(u, d) {
  const s = await readSession(d.id, u, d.vid);
  const v = s.selected;
  need(!!v, 'Generate assignments first.');
  const format = d.format;
  need(['csv', 'pdf', 'xlsx', 'docx', 'print'].includes(format), 'Unsupported format.');
  const m = v.meta;

  const title = 'PSG Polytechnic College';
  const subtitle = `${m.title} · Version ${v.version}`;
  const metaInfo = {
    Department: m.department,
    Subject: `${m.subject} (${m.code})`,
    Batch: m.batch,
    Semester: m.semester,
    'Academic year': m.academicYear,
    'Generation date': m.date,
    'Prepared by': s.staff,
    Distribution: v.mode,
  };
  const labels = ['S.No', 'Roll number', 'Student name', 'Question 1', 'Question 2', 'Combination'];
  const tableData = [labels, ...v.rows.map(r => [r.seq, r.roll, r.name, r.q1, r.q2, `${r.q1} + ${r.q2}`])];

  let bytes, mime, filename;
  filename = `PSG-${s.id}-v${v.version}.${format}`;

  if (format === 'csv') {
    const lines = ['\uFEFF'];
    for (const row of tableData) {
      lines.push(row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','));
    }
    bytes = Buffer.from(lines.join('\n'), 'utf8');
    mime = 'text/csv';
  } else if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    const wsData = [[title], [subtitle]];
    for (const [k, val] of Object.entries(metaInfo)) wsData.push([k, val]);
    for (const row of tableData) wsData.push(row);
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Assignments');
    bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else {
    // For docx, pdf, print — build HTML and return it (docx/pdf require heavy libs; return HTML as fallback)
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let html = `<h1>${esc(title)}</h1><h2>${esc(subtitle)}</h2>`;
    for (const [k, val] of Object.entries(metaInfo)) html += `<b>${esc(k)}</b> ${esc(val)} &nbsp; `;
    html += '<table style="border-collapse:collapse;width:100%;margin-top:16px"><thead><tr>';
    for (const label of labels) html += `<th style="background:#183844;color:white;padding:7px">${esc(label)}</th>`;
    html += '</tr></thead><tbody>';
    for (const row of tableData.slice(1)) {
      html += '<tr>' + row.map(val => `<td style="border-bottom:1px solid #ccd4d4;padding:6px">${esc(val)}</td>`).join('') + '</tr>';
    }
    html += '</tbody></table>';

    if (format === 'docx') {
      // Use docx package (already installed in server/)
      try {
        const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, WidthType, BorderStyle } = require('docx');
        const headerCells = labels.map(l => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: l, bold: true })] })] }));
        const dataRows = tableData.slice(1).map(row =>
          new TableRow({ children: row.map(val => new TableCell({ children: [new Paragraph(String(val))] })) })
        );
        const doc = new Document({
          sections: [{
            children: [
              new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 36 })] }),
              new Paragraph({ children: [new TextRun({ text: subtitle, size: 28 })] }),
              ...Object.entries(metaInfo).map(([k, v]) => new Paragraph(`${k}: ${v}`)),
              new Table({ rows: [new TableRow({ children: headerCells }), ...dataRows] }),
            ]
          }]
        });
        bytes = await Packer.toBuffer(doc);
        mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } catch (e) {
        bytes = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(subtitle)}</title></head><body>${html}</body></html>`);
        mime = 'text/html';
        filename = filename.replace('.docx', '.html');
      }
    } else {
      bytes = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(subtitle)}</title><style>@page{size:A4}body{font:12pt sans-serif;color:#17343c}</style></head><body>${html}</body></html>`);
      mime = 'text/html';
      if (format === 'pdf') filename = filename.replace('.pdf', '.html'); // fallback
    }
  }

  await tx(async (conn) => {
    await conn.execute("INSERT INTO exports(actor,version_id,format,status) VALUES (?,?,?,'Prepared')", [u.id, v.id, format]);
    await audit(u.id, 'Exported', `${format.toUpperCase()} prepared · version ${v.version}`, s.id, v.id);
  });

  return { bytes, mime, filename };
}

module.exports = {
  DomainError,
  field, syllabus, roster, need,
  saveGeneration, readSession, finalize, overview, manageUser, saveLibrary,
  importFile, exportResult,
};
