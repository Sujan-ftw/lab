'use strict';
/**
 * Attendance Sheets — a separate option, independent of the examination document generator.
 * Staff enter the examination details, add students (Excel/CSV import or generated roll numbers
 * with names typed in), then generate a Word and a PDF sheet: S.No. | Name | Roll No. | Signature,
 * with the Internal and External Examiner signatures at the bottom of the last page.
 */
const ATT_PREFIXES = ['24DI', '25DI', '26DI', '24DX'];
const ATT_SEMS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const ATT_ROLL = /^[A-Z0-9][A-Z0-9/-]{1,29}$/;

const ATT = {
  sheet: null,
  exams: [],
  tab: 'manual',
  imported: null,       // last import result, waiting to be added
  dirty: false,
  gen: { prefix: '', start: 1, count: '' },

  // ─── History ───────────────────────────────────────────────────────────
  async list() {
    if (!this.leaveOk()) return;
    this.sheet = null;
    const r = await api('att_list');
    const rows = (r.sheets || []).map(s => {
      const f = s.latest;
      return [
        `<b>${E(s.subject_name || 'Untitled')}</b><small>${E(s.subject_code || '—')}</small>`,
        E(attDate(s.exam_date) || '—'),
        E(s.batch_name || '—'),
        String(s.student_count),
        f ? `${E(time(f.created_at))}<small>Version ${f.version}${s.versions > 1 ? ` of ${s.versions}` : ''}</small>` : '<span class="pill">Not generated</span>',
        `<div class="row">${btn('Open', `att_open|${s.id}`)}${f ? btn('Word', `att_dl|${s.id}|${f.version}|docx`, '', 'download') + btn('PDF', `att_dl|${s.id}|${f.version}|pdf`, '', 'download') : ''}${btn('Delete', `att_del|${s.id}`, 'ghost')}</div>`,
      ];
    });
    const all = r.sheets || [];
    const made = all.filter(s => s.latest).length;
    put(title('Attendance Sheets', 'Make a signed attendance sheet (S.No., Name, Roll No., Signature) for any practical examination, separate from the examination documents.', btn('Create Attendance Sheet', 'att_new', 'primary', 'plus')) +
      widgets('Roll call, ready in a minute', 'Import Excel, Word or CSV, or generate 24DI01 onwards and type the names.', [
        ['Attendance sheets', all.length, 'file', 'saved'],
        ['Students listed', all.reduce((n, s) => n + (s.student_count || 0), 0), 'person', 'across all sheets'],
        ['Generated', made, 'check', all.length ? Math.round(made / all.length * 100) + '% of sheets' : '', all.length ? made / all.length * 100 : 0],
      ]) +
      card('Previously generated attendance sheets', table(['Subject', 'Exam date', 'Batch', 'Students', 'Generated', ''], rows, 'No attendance sheets yet. Start with Create Attendance Sheet.')));
  },

  leaveOk() { return !this.dirty || confirm('You have unsaved changes to this attendance sheet. Discard them?'); },

  // ─── Open / new ────────────────────────────────────────────────────────
  async open(id) {
    if (!this.leaveOk()) return;
    const [opts, r] = await Promise.all([api('att_exam_options').catch(() => ({ exams: [] })), id ? api('att_get', { id }) : null]);
    this.exams = opts.exams || [];
    this.sheet = r ? r.sheet : { id: 0, exam_name: 'Semester Practical Examinations', subject_name: '', subject_code: '', department: dept || '', semester: '', exam_date: '', batch_name: '', internal_examiner: '', external_examiner: '', roll_prefix: '', students: [], files: [] };
    this.gen = { prefix: this.sheet.roll_prefix || '', start: 1, count: '' };
    this.imported = null;
    this.dirty = false;
    this.tab = this.sheet.students.length ? 'manual' : 'manual';
    this.render();
  },

  payload() {
    const s = this.sheet;
    return { id: s.id, exam_name: s.exam_name, subject_name: s.subject_name, subject_code: s.subject_code, department: s.department, semester: s.semester,
      exam_date: s.exam_date, batch_name: s.batch_name, internal_examiner: s.internal_examiner, external_examiner: s.external_examiner,
      roll_prefix: this.gen.prefix || s.roll_prefix, students: s.students };
  },

  async save() {
    const r = await api('att_save', this.payload());
    const g = await api('att_get', { id: r.id });
    this.sheet = g.sheet;
    this.dirty = false;
    return r.id;
  },

  markDirty() { this.dirty = true; const f = $('#att-unsaved'); if (f) f.hidden = false; },

  // ─── Checks (same rules as the server) ─────────────────────────────────
  dupRolls() {
    const seen = new Map(), dup = new Set();
    this.sheet.students.forEach(s => { const r = s.roll_no; if (!r) return; if (seen.has(r)) dup.add(r); seen.set(r, true); });
    return dup;
  },
  missing() {
    const s = this.sheet, out = [];
    if (!String(s.subject_name).trim()) out.push('Subject name');
    if (!s.exam_date) out.push('Examination date');
    if (!s.students.length) out.push('At least one student');
    const noRoll = s.students.filter(x => !x.roll_no).length;
    if (noRoll) out.push(`Roll number for ${noRoll} student${noRoll === 1 ? '' : 's'}`);
    const noName = s.students.filter(x => !String(x.name).trim()).length;
    if (noName) out.push(`Name for ${noName} student${noName === 1 ? '' : 's'}`);
    const bad = s.students.filter(x => x.roll_no && !ATT_ROLL.test(x.roll_no));
    if (bad.length) out.push(`Valid roll numbers (check ${bad.slice(0, 3).map(x => x.roll_no).join(', ')})`);
    const dup = this.dupRolls();
    if (dup.size) out.push(`Unique roll numbers (repeated: ${[...dup].slice(0, 5).join(', ')})`);
    return out;
  },

  // ─── Roll number generator ─────────────────────────────────────────────
  plan() {
    const prefix = String(this.gen.prefix || '').toUpperCase().replace(/\s+/g, '');
    const start = parseInt(this.gen.start, 10), count = parseInt(this.gen.count, 10);
    if (!prefix) return { error: 'Enter a roll number prefix, for example 24DI.' };
    if (!/^[A-Z0-9][A-Z0-9/-]*$/.test(prefix)) return { error: 'The prefix can use only letters, digits, / and -.' };
    if (!(start >= 0)) return { error: 'Enter the starting number.' };
    if (!(count >= 1)) return { error: 'Enter the number of students.' };
    if (count > 500) return { error: 'Add at most 500 students at a time.' };
    const width = Math.max(2, String(start + count - 1).length);
    const rolls = Array.from({ length: count }, (_, i) => prefix + String(start + i).padStart(width, '0'));
    const have = new Set(this.sheet.students.map(s => s.roll_no));
    const clash = rolls.filter(r => have.has(r));
    return { prefix, rolls, clash };
  },
  previewText() {
    const p = this.plan();
    if (p.error) return `<p class="muted">${E(p.error)}</p>`;
    const r = p.rolls;
    const list = r.length <= 6 ? r.join(', ') : `${r.slice(0, 3).join(', ')} … ${r.slice(-2).join(', ')}`;
    return `<p class="note ${p.clash.length ? 'bad' : 'ok'}"><b>${r.length} roll number${r.length === 1 ? '' : 's'}:</b> ${E(r[0])} to ${E(r[r.length - 1])}<br><small>${E(list)}</small>` +
      (p.clash.length ? `<br><b>${p.clash.length} already in the list</b> (${E(p.clash.slice(0, 5).join(', '))}${p.clash.length > 5 ? '…' : ''}). Existing roll numbers are never overwritten; change the starting number or count.` : '') + '</p>';
  },

  // ─── Page ──────────────────────────────────────────────────────────────
  render() {
    const s = this.sheet;
    const head = `<div class="page-title"><div><div class="eyebrow">ATTENDANCE SHEET</div><h1>${E(s.subject_name || 'New attendance sheet')}</h1>
      <p>${E([s.subject_code, s.batch_name, s.exam_date && attDate(s.exam_date), s.students.length ? s.students.length + ' students' : ''].filter(Boolean).join(' · ') || 'Enter the details, add the students, then generate Word and PDF.')}</p></div>
      <div class="row"><span id="att-unsaved" class="unsaved" ${this.dirty ? '' : 'hidden'}>Unsaved changes</span>${btn('Save', 'att_save', '', 'check')}${btn('All attendance sheets', 'go|Attendance Sheets')}</div></div>`;
    const flow = '<ol class="flow"><li>Examination details</li><li>Add students</li><li>Check names and roll numbers</li><li>Generate Word &amp; PDF</li></ol>';
    put(head + flow + this.vDetails() + this.vAdd() + this.vStudents() + '<div id="att-generate"></div>');
    this.updatePanel();
  },

  vDetails() {
    const s = this.sheet;
    const f = (k, label, type = 'text', extra = '') => `<label class="field">${E(label)}<input type="${type}" data-att="${k}" value="${E(s[k] ?? '')}" ${extra}></label>`;
    const copy = this.exams.length ? `<label class="field copyfrom">Copy details from an examination<select id="att-copy"><option value="">Choose an examination…</option>${this.exams.map(x => `<option value="${x.id}">${E(x.label)}</option>`).join('')}</select></label>` : '';
    return card('1 · Examination details', `${copy}
      <div class="fields">
        ${f('exam_name', 'Examination name')}
        ${f('subject_name', 'Subject name')}${f('subject_code', 'Subject code')}
        ${f('department', 'Department')}
        <label class="field">Semester<select data-att="semester"><option value="">Select…</option>${ATT_SEMS.map(o => `<option ${o === s.semester ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
        ${f('exam_date', 'Examination date', 'date')}${f('batch_name', 'Batch (optional)', 'text', 'placeholder="e.g. Batch A"')}
      </div>
      <div class="fields gap">${f('internal_examiner', 'Internal examiner')}${f('external_examiner', 'External examiner')}</div>
      <p class="muted small">Examiner names are printed under the signature lines at the bottom of the last page.</p>`);
  },

  vAdd() {
    const tabs = `<div class="tabs">${btn('Generate roll numbers', 'att_tab|manual', this.tab === 'manual' ? 'current' : '', 'plus')}${btn('Import Excel / Word / CSV', 'att_tab|import', this.tab === 'import' ? 'current' : '', 'file')}</div>`;
    let body;
    if (this.tab === 'manual') {
      const g = this.gen;
      body = `<p class="muted">Enter the prefix and how many students. Roll numbers are numbered in order (two digits, or three when the numbers pass 99). Type the names in the list below.</p>
        <div class="fields att-gen">
          <label class="field">Roll number prefix<input data-gen="prefix" value="${E(g.prefix)}" list="att-prefixes" placeholder="e.g. 24DI" autocapitalize="characters"></label>
          <label class="field">Starting number<input data-gen="start" type="number" min="0" value="${E(g.start)}"></label>
          <label class="field">Number of students<input data-gen="count" type="number" min="1" max="500" value="${E(g.count)}" placeholder="e.g. 50"></label>
        </div>
        <datalist id="att-prefixes">${ATT_PREFIXES.map(p => `<option value="${p}">`).join('')}</datalist>
        <div class="row prefix-chips">${ATT_PREFIXES.map(p => btn(p, `att_prefix|${p}`, 'chip')).join('')}</div>
        <div id="att-plan">${this.previewText()}</div>
        <div class="actions">${btn('Add these roll numbers', 'att_gen', 'primary', 'plus')}</div>`;
    } else {
      const x = this.imported;
      let res = '';
      if (x) {
        const issues = [...x.duplicates.map(d => ({ ...d, kind: 'Duplicate' })), ...x.invalid.map(d => ({ ...d, kind: 'Invalid' }))].sort((a, b) => a.row - b.row);
        const clash = x.students.filter(s => s.roll_no && this.sheet.students.some(t => t.roll_no === s.roll_no)).length;
        res = `<div class="note ${issues.length ? 'warn' : 'ok'}"><b>${E(x.file)}</b>: ${x.total_rows} row${x.total_rows === 1 ? '' : 's'} read · <b>${x.valid_count}</b> ready to add${x.without_roll ? ` (${x.without_roll} without a roll number)` : ''}${x.duplicate_count ? ` · ${x.duplicate_count} duplicate` : ''}${x.invalid_count ? ` · ${x.invalid_count} invalid` : ''}</div>
          ${issues.length ? `<div class="tablewrap short"><table><thead><tr><th>Row</th><th>Problem</th><th>Name</th><th>Roll No.</th><th>Details</th></tr></thead><tbody>${issues.map(i => `<tr class="${i.kind === 'Duplicate' ? 'dup' : 'bad'}"><td>${i.row}</td><td>${i.kind}</td><td>${E(i.name || '—')}</td><td>${E(i.roll || '—')}</td><td>${E(i.reason)}</td></tr>`).join('')}</tbody></table></div><p class="muted small">These rows are left out. Fix them in the file and import again, or add them by hand below.</p>` : ''}
          ${x.students.length ? `<div class="tablewrap short"><table><thead><tr><th>#</th><th>Name</th><th>Roll No.</th></tr></thead><tbody>${x.students.slice(0, 8).map((s, i) => `<tr><td>${i + 1}</td><td>${E(s.name)}</td><td>${E(s.roll_no || '(to be generated)')}</td></tr>`).join('')}${x.students.length > 8 ? `<tr><td colspan="3" class="muted">… and ${x.students.length - 8} more</td></tr>` : ''}</tbody></table></div>` : ''}
          ${x.without_roll ? `<p class="muted small">Students without a roll number can be numbered after adding them with <b>Fill missing roll numbers</b> (uses the prefix from Generate roll numbers).</p>` : ''}
          ${clash ? `<p class="note warn">${clash} roll number${clash === 1 ? ' is' : 's are'} already in the list. Adding keeps the existing entries and skips those rows; Replace uses the file instead.</p>` : ''}
          <div class="actions">${btn('Discard', 'att_imp_discard', 'ghost')}${this.sheet.students.length ? btn('Replace the list', 'att_imp_add|replace') : ''}${btn(this.sheet.students.length ? `Add ${x.students.length} to the list` : `Use these ${x.students.length} students`, 'att_imp_add|append', 'primary', 'plus')}</div>`;
      }
      body = `<div class="dropzone"><div>${ico('file')}<b>Student list file</b><small><b>Excel</b> (.xlsx, .xls), <b>CSV</b> or <b>Word</b> (.docx). Use a Student Name column and an optional Roll Number column; in Word, a table or one student per line (for example <i>1. Arun Kumar – 24DI01</i>, or just the name). Roll numbers in the file are kept as they are.</small></div>
        <label class="upload primary-outline">Choose file<input id="att-file" type="file" accept=".xlsx,.xls,.csv,.docx"></label></div>${res}`;
    }
    return card('2 · Add students', tabs + body);
  },

  vStudents() {
    const list = this.sheet.students;
    const dup = this.dupRolls();
    const rows = list.map((s, i) => `<tr data-i="${i}" class="${dup.has(s.roll_no) ? 'dup' : ''}"><td class="no">${i + 1}</td>
      <td><input data-stu="${i}.roll_no" value="${E(s.roll_no)}" placeholder="Roll No." class="roll"></td>
      <td><input data-stu="${i}.name" value="${E(s.name)}" placeholder="Student name"></td>
      <td class="tight">${btn('Remove', `att_stu_del|${i}`, 'ghost')}</td></tr>`).join('');
    const body = list.length
      ? `<div class="tablewrap stu"><table class="edit-table"><thead><tr><th>S.No.</th><th>Roll No.</th><th>Name</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty">${ico('person')}No students yet. Generate roll numbers or import a file above.</div>`;
    const tools = `${btn('Add student', 'att_stu_add', '', 'plus')}${list.some(s => !s.roll_no) ? btn('Fill missing roll numbers', 'att_fill') : ''}${list.length > 1 ? btn('Sort by roll number', 'att_sort') : ''}${list.length ? btn('Clear list', 'att_clear', 'ghost') : ''}`;
    return card('3 · Students', `<p class="muted">Correct any roll number or name directly in the list. Repeated roll numbers are highlighted.</p><div id="att-dupnote"></div>` + body +
      `<div class="actions spread"><div class="row">${tools}</div><span class="muted" id="att-count">${list.length} student${list.length === 1 ? '' : 's'}</span></div>`);
  },

  refreshChecks() {
    const dup = this.dupRolls();
    $$('#content tr[data-i]').forEach(tr => { const s = this.sheet.students[+tr.dataset.i]; tr.classList.toggle('dup', !!s && dup.has(s.roll_no)); });
    const n = $('#att-dupnote'); if (n) n.innerHTML = dup.size ? `<p class="note bad">Repeated roll number${dup.size === 1 ? '' : 's'}: <b>${E([...dup].join(', '))}</b>. Each student needs a different roll number.</p>` : '';
    this.updatePanel();
  },

  updatePanel() {
    const box = $('#att-generate'); if (!box) return;
    const miss = this.missing(), files = this.sheet.files || [];
    const versions = files.map((f, k) => `<div class="genrow"><span class="ficon pdf">v${f.version}</span><div><b>${E(f.docx_name.replace(/\.docx$/, ''))}</b><small>${f.student_count} students · ${E(time(f.created_at))}${k === 0 ? ' · latest' : ''}</small></div>
      <div class="row">${btn('Preview', `att_view|${f.version}`, '', 'eye')}${btn('Print', `att_print|${f.version}`, '')}${btn('Download Word', `att_dl|${this.sheet.id}|${f.version}|docx`, k === 0 ? 'primary' : '', 'download')}${btn('Download PDF', `att_dl|${this.sheet.id}|${f.version}|pdf`, k === 0 ? 'primary' : '', 'download')}</div></div>`).join('');
    box.innerHTML = `<section class="card generate"><div class="card-head"><h2>4 · Generate the attendance sheet</h2></div>
      <p class="muted">A Word file and a PDF: PSG Polytechnic College heading, S.No. · Name · Roll No. · Signature table with the heading row repeated on every page, and the Internal Examiner (left) and External Examiner (right) signatures at the bottom of the last page. Each generation is kept as a new version; earlier files are never overwritten.</p>
      ${miss.length ? `<div class="note warn"><b>Still needed:</b> ${E(miss.join(', '))}.</div>` : ''}
      <div class="actions spread"><span></span><div class="row">${btn('Preview', 'att_preview', '', 'eye')}${btn(files.length ? 'Generate new version' : 'Generate Word & PDF', 'att_generate', 'primary big', 'file')}</div></div>
      ${files.length ? `<div class="generated"><h3>${ico('check')} Generated files</h3>${versions}${this.dirty ? '<p class="note warn">The sheet changed after the last generation. Generate a new version to include the changes.</p>' : ''}</div>` : ''}</section>`;
    if (miss.length) $$('#att-generate [data-action="att_generate"], #att-generate [data-action="att_preview"]').forEach(b => b.disabled = true);
  },

  // ─── Inputs ────────────────────────────────────────────────────────────
  onInput(e) {
    const el = e.target;
    if (!this.sheet || !el.dataset) return;
    if (el.dataset.att) {
      this.sheet[el.dataset.att] = el.value;
      this.markDirty(); this.updatePanel();
    } else if (el.dataset.stu) {
      const [i, k] = el.dataset.stu.split('.');
      const s = this.sheet.students[+i]; if (!s) return;
      s[k] = k === 'roll_no' ? el.value.toUpperCase().replace(/\s+/g, '') : el.value;
      if (k === 'roll_no' && el.value !== s[k]) { const p = el.selectionStart; el.value = s[k]; try { el.setSelectionRange(p, p); } catch { /* */ } }
      this.markDirty(); this.refreshChecks();
    } else if (el.dataset.gen) {
      this.gen[el.dataset.gen] = el.dataset.gen === 'prefix' ? el.value.toUpperCase() : el.value;
      const box = $('#att-plan'); if (box) box.innerHTML = this.previewText();
    }
  },

  copyFrom(id) {
    const x = this.exams.find(e => String(e.id) === String(id)); if (!x) return;
    const s = this.sheet;
    for (const k of ['subject_name', 'subject_code', 'department', 'semester', 'exam_date', 'internal_examiner', 'external_examiner']) if (x[k]) s[k] = x[k];
    this.markDirty(); this.render();
    notice('Details copied from ' + x.label + '.');
  },

  async importFile(file) {
    const fd = new FormData(); fd.append('file', file);
    notice('Reading ' + file.name + '…');
    try { this.imported = { ...(await api('att_import', fd)), file: file.name }; }
    catch (e) { notice(e.message); this.imported = null; }
    this.render();
  },

  async blob(version, inline = true) {
    return api('att_download', { id: this.sheet.id, version, format: 'pdf', inline }, true);
  },
};

function attDate(v) { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; }
function attShowPdf(name, blob) {
  modal(name, '<div class="pdfwrap"></div>');
  $('#dialog').classList.add('wide');
  $('#modal .pdfwrap').innerHTML = `<iframe title="Attendance sheet preview" src="${URL.createObjectURL(blob)}"></iframe>`;
}

document.addEventListener('input', e => ATT.onInput(e));
document.addEventListener('change', e => {
  if (e.target.id === 'att-file' && e.target.files[0]) { const f = e.target.files[0]; e.target.value = ''; ATT.importFile(f); }
  if (e.target.id === 'att-copy' && e.target.value) ATT.copyFrom(e.target.value);
});
window.addEventListener('beforeunload', e => { if (ATT.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ─── Actions ──────────────────────────────────────────────────────────────
act('att_new', () => ATT.open(0));
act('att_open', id => ATT.open(Number(id)));
act('att_del', async id => {
  if (!confirm('Delete this attendance sheet and all its generated files? This cannot be undone.')) return;
  await api('att_delete', { id: Number(id) });
  notice('Attendance sheet deleted.');
  ATT.list();
});
act('att_save', async () => { await ATT.save(); ATT.render(); notice('Saved.'); });
act('att_tab', t => { ATT.tab = t; ATT.render(); });
act('att_prefix', p => { ATT.gen.prefix = p; const i = $('[data-gen="prefix"]'); if (i) i.value = p; $('#att-plan').innerHTML = ATT.previewText(); const c = $('[data-gen="count"]'); if (c && !c.value) c.focus(); });
act('att_gen', () => {
  const p = ATT.plan();
  if (p.error) { notice(p.error); return; }
  if (p.clash.length) { notice(`${p.clash.length} of these roll numbers are already in the list. Change the starting number or count.`); return; }
  const first = ATT.sheet.students.length;
  ATT.sheet.students.push(...p.rolls.map(r => ({ roll_no: r, name: '' })));
  ATT.sheet.roll_prefix = p.prefix;
  ATT.gen.start = parseInt(ATT.gen.start, 10) + p.rolls.length; ATT.gen.count = '';
  ATT.markDirty(); ATT.render();
  notice(`Added ${p.rolls[0]} to ${p.rolls[p.rolls.length - 1]}. Type the student names in the list.`);
  const inp = $(`[data-stu="${first}.name"]`); if (inp) { inp.scrollIntoView({ block: 'center' }); inp.focus(); }
});
act('att_imp_discard', () => { ATT.imported = null; ATT.render(); });
act('att_imp_add', mode => {
  const x = ATT.imported; if (!x) return;
  let added = x.students.map(s => ({ name: s.name, roll_no: s.roll_no }));
  let skipped = 0;
  if (mode === 'replace') {
    if (!confirm(`Replace the ${ATT.sheet.students.length} students in the list with the ${added.length} from ${x.file}?`)) return;
    ATT.sheet.students = added;
  } else {
    const have = new Set(ATT.sheet.students.map(s => s.roll_no).filter(Boolean));
    const keep = added.filter(s => !s.roll_no || !have.has(s.roll_no));
    skipped = added.length - keep.length;
    ATT.sheet.students.push(...keep); added = keep;
  }
  ATT.imported = null; ATT.markDirty(); ATT.render();
  notice(`${added.length} student${added.length === 1 ? '' : 's'} added${skipped ? `, ${skipped} skipped (roll number already in the list)` : ''}.`);
});
act('att_stu_add', () => { ATT.sheet.students.push({ roll_no: '', name: '' }); ATT.markDirty(); ATT.render(); const i = $(`[data-stu="${ATT.sheet.students.length - 1}.roll_no"]`); if (i) { i.scrollIntoView({ block: 'center' }); i.focus(); } });
act('att_stu_del', i => { const s = ATT.sheet.students[+i]; if ((s.name || s.roll_no) && !confirm(`Remove ${s.name || s.roll_no} from the list?`)) return; ATT.sheet.students.splice(+i, 1); ATT.markDirty(); ATT.render(); });
act('att_clear', () => { if (!confirm(`Remove all ${ATT.sheet.students.length} students from the list?`)) return; ATT.sheet.students = []; ATT.markDirty(); ATT.render(); });
act('att_sort', () => { ATT.sheet.students.sort((a, b) => String(a.roll_no).localeCompare(String(b.roll_no), 'en', { numeric: true })); ATT.markDirty(); ATT.render(); });
act('att_fill', () => {
  const prefix = String(ATT.gen.prefix || ATT.sheet.roll_prefix || '').toUpperCase();
  if (!prefix) { ATT.tab = 'manual'; ATT.render(); notice('Enter the roll number prefix under Generate roll numbers first.'); $('[data-gen="prefix"]').focus(); return; }
  const list = ATT.sheet.students, empty = list.filter(s => !s.roll_no);
  const have = new Set(list.map(s => s.roll_no).filter(Boolean));
  const used = list.map(s => s.roll_no).filter(r => r && r.startsWith(prefix)).map(r => parseInt(r.slice(prefix.length), 10)).filter(n => n >= 0);
  let n = Math.max(parseInt(ATT.gen.start, 10) || 1, used.length ? Math.max(...used) + 1 : 1);
  const width = Math.max(2, String(n + empty.length - 1).length, ...list.map(s => s.roll_no).filter(r => r && r.startsWith(prefix)).map(r => r.length - prefix.length));
  for (const s of empty) { let r; do { r = prefix + String(n++).padStart(width, '0'); } while (have.has(r)); s.roll_no = r; have.add(r); }
  ATT.sheet.roll_prefix = prefix; ATT.markDirty(); ATT.render();
  notice(`${empty.length} roll number${empty.length === 1 ? '' : 's'} filled in.`);
});
act('att_preview', async () => {
  await ATT.save();
  modal('Preview (not saved as a file)', '<div class="pdfwrap"><p class="muted">Preparing the preview…</p></div>');
  $('#dialog').classList.add('wide');
  const blob = await api('att_preview', { id: ATT.sheet.id }, true);
  $('#modal .pdfwrap').innerHTML = `<iframe title="Attendance sheet preview" src="${URL.createObjectURL(blob)}"></iframe>`;
  ATT.updatePanel();
});
act('att_generate', async () => {
  const b = $('[data-action="att_generate"]');
  if (b) { b.classList.add('busy'); b.lastChild.textContent = 'Generating Word and PDF…'; }
  try {
    await ATT.save();
    const r = await api('att_generate', { id: ATT.sheet.id });
    ATT.sheet = (await api('att_get', { id: ATT.sheet.id })).sheet;
    ATT.dirty = false;
    notice(`Generated ${r.docx_name} and ${r.pdf_name}.`);
  } finally {
    ATT.render();
    $('#att-generate').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
act('att_dl', async (id, version, fmt) => {
  const blob = await api('att_download', { id: Number(id), version: Number(version), format: fmt }, true);
  let name = `Attendance_Sheet.${fmt}`;
  const f = ATT.sheet && String(ATT.sheet.id) === String(id) ? (ATT.sheet.files || []).find(x => String(x.version) === String(version)) : null;
  if (f) name = fmt === 'pdf' ? f.pdf_name : f.docx_name;
  else { const r = await api('att_get', { id: Number(id) }); const g = r.sheet.files.find(x => String(x.version) === String(version)); if (g) name = fmt === 'pdf' ? g.pdf_name : g.docx_name; }
  download(blob, name);
});
act('att_view', async v => { const f = ATT.sheet.files.find(x => String(x.version) === String(v)); attShowPdf(f ? f.pdf_name : 'Attendance sheet', await ATT.blob(Number(v))); });
act('att_print', async v => {
  const url = URL.createObjectURL(await ATT.blob(Number(v)));
  const fr = document.createElement('iframe');
  fr.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  fr.src = url;
  fr.onload = () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch { window.open(url, '_blank'); } setTimeout(() => fr.remove(), 60000); };
  document.body.append(fr);
});

window.ATT = ATT;
