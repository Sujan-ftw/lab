/**
 * PSG Practical Examination Management System — examination document generator.
 *
 * One page, one staff member, no approvals:
 *   1. Enter examination details   2. Upload syllabus   3. Review the List of Experiments
 *   4. Generate Documents          5. Download Word     6. Download PDF
 * Nothing is pre-filled with sample content; defaults come from the saved settings.
 */
'use strict';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SEMESTERS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const EXAM_NAME = 'SEMESTER PRACTICAL EXAMINATIONS';
const DEFAULT_MARKS = [
  ['Aim, Algorithm ,Flowchart and Result (PART A)', 10], ['Aim, Algorithm ,Flowchart and Result (PART B)', 10], ['Viva Voce', 5],
  ['Program Execution -Part A', 15], ['Program Execution- Part B', 15], ['Output Printout -Part A', 10], ['Output Printout - Part B', 10],
];

const PEMS = {
  draft: null,
  generated: [],
  lookups: { departments: [], programmes: [], subjects: [], people: [], settings: {} },
  dirty: false,
  extraction: null,   // { ok, file, count, warnings } or { ok:false, file, error }

  init() {
    document.addEventListener('input', e => PEMS.onInput(e));
    document.addEventListener('change', e => { if (e.target.id === 'pems-syllabus-file' && e.target.files[0]) PEMS.upload(e.target.files[0]); });
    window.addEventListener('beforeunload', e => { if (PEMS.dirty) { e.preventDefault(); e.returnValue = ''; } });
  },

  // ─── List ──────────────────────────────────────────────────────────────
  async renderExamsList() {
    const res = await api('pems_list_exams');
    const rows = (res.examinations || []).map(e => [
      `<b>${E(e.subject_name || 'Untitled')}</b><small>${E(e.subject_code || '—')}</small>`,
      `${E(e.programme || '—')}<small>${e.semester ? 'Semester ' + E(e.semester) : ''}</small>`,
      `${E(e.exam_month || '')} ${e.exam_year || ''}<small>${e.lab_date ? E(String(e.lab_date).slice(0, 10)) : ''}</small>`,
      e.status === 'Generated' || e.status === 'Finalized' ? '<span class="pill ok">Document generated</span>' : '<span class="pill">Draft</span>',
      `<div class="row">${btn('Open', `pems_open_exam|${e.id}`)}${!isAdmin && e.status !== 'Finalized' ? btn('Delete', `pems_delete_exam|${e.id}`, 'ghost') : ''}</div>`,
    ]);
    const list = res.examinations || [];
    const done = list.filter(e => e.status === 'Generated' || e.status === 'Finalized').length;
    put(title('Practical Examinations', 'Generate the official Semester Practical Examination document from the examination details and the syllabus.', !isAdmin ? btn('New Examination', 'pems_new_exam', 'primary', 'plus') : '') +
      widgets('Ready for the next practical?', 'Details, syllabus, experiments, then one click for Word and PDF.', [
        ['Examinations', list.length, 'layers', 'saved'],
        ['Documents generated', done, 'file', list.length ? Math.round(done / list.length * 100) + '% done' : '', list.length ? done / list.length * 100 : 0],
        ['Drafts', list.length - done, 'clock', 'to finish'],
      ]) +
      card('Examinations', table(['Subject', 'Programme', 'Session', 'Document', ''], rows, 'No examinations yet. Start with New Examination.')));
  },

  // ─── Load / save ───────────────────────────────────────────────────────
  async startWizard(examId = 0) {
    if (this.dirty && !confirm('You have unsaved changes. Discard them?')) return;
    this.lookups = await api('pems_lookups').catch(() => this.lookups);
    this.extraction = null;
    if (examId > 0) await this.load(examId);
    else {
      const st = this.lookups.settings || {};
      this.generated = [];
      this.draft = {
        id: 0, status: 'Draft',
        exam: { exam_month: '', exam_year: new Date().getFullYear(), centre_no: st.centre_no || '', centre_name: st.institution_name || '', department: dept || '', programme: '', semester: '' },
        subject: { subject_name: '', subject_code: '', exam_date: '', start_time: '', end_time: '', duration: '', max_marks: st.default_max_marks || '' },
        internal_examiner: { name: '' }, external_examiner: { name: '' },
        experiments: [], syllabus_file: null, syllabus_name: '',
        mark_components: DEFAULT_MARKS.map(([description, max_marks]) => ({ description, max_marks })),
      };
    }
    this.dirty = false;
    this.render();
  },

  async load(id) {
    const r = await api('pems_get_exam', { id });
    const s = r.subject || {}, st = r.settings || {};
    this.generated = r.generated || [];
    this.draft = {
      id: r.exam.id, status: r.exam.status,
      exam: { exam_month: r.exam.exam_month || '', exam_year: r.exam.exam_year || '', centre_no: r.exam.centre_no || st.centre_no || '', centre_name: r.exam.centre_name || st.institution_name || '', department: r.exam.department || '', programme: r.exam.programme || '', semester: r.exam.semester || '' },
      subject: { subject_name: s.subject_name || '', subject_code: s.subject_code || '', exam_date: s.lab_date ? String(s.lab_date).slice(0, 10) : '', start_time: toTime(s.start_time), end_time: toTime(s.end_time), duration: s.duration || '', max_marks: s.max_marks || '' },
      internal_examiner: { name: (r.internal_examiner && r.internal_examiner.name) || '' },
      external_examiner: { name: (r.external_examiner && r.external_examiner.name) || '' },
      experiments: (r.experiments || []).map(e => ({ title: [e.title, e.description].filter(Boolean).join('\n'), subquestions: (e.subquestions || []).map(x => ({ letter: x.letter, text: x.text })) })),
      syllabus_file: null,
      syllabus_name: r.syllabus ? r.syllabus.file_name : '',
      mark_components: (r.mark_components || []).map(c => ({ description: c.description, max_marks: c.max_marks })),
    };
  },

  payload() {
    const d = this.draft;
    return {
      id: d.id, exam: d.exam, subject: d.subject, internal_examiner: d.internal_examiner, external_examiner: d.external_examiner,
      experiments: d.experiments.map((e, i) => {
        const [title, ...rest] = String(e.title || '').split('\n');
        return { exp_no: i + 1, title: title.trim(), description: rest.join('\n').trim(), subquestions: Array.from(e.subquestions, (x, k) => ({ letter: (x && x.letter) || String.fromCharCode(97 + k), text: (x && x.text) || '' })) };
      }),
      syllabus_file: d.syllabus_file,
      mark_components: d.mark_components.map((c, i) => ({ seq: i + 1, description: c.description, max_marks: parseInt(c.max_marks, 10) || 0 })),
    };
  },

  async save() {
    const r = await api('pems_save_exam', this.payload());
    const keep = this.extraction;
    await this.load(r.id);
    this.extraction = keep;
    this.dirty = false;
    return r.id;
  },

  // ─── Missing information (same rules as the server) ────────────────────
  missing() {
    const d = this.draft, e = d.exam, s = d.subject, out = [];
    const t = v => String(v ?? '').trim();
    const need = (ok, label) => { if (!ok) out.push(label); };
    need(t(e.exam_month), 'Examination month'); need(parseInt(e.exam_year, 10) > 2000, 'Examination year');
    need(t(e.centre_no), 'Centre'); need(t(e.centre_name), 'College name');
    need(t(e.programme), 'Course / Programme'); need(t(e.semester), 'Semester');
    need(t(s.subject_name), 'Subject name'); need(t(s.subject_code), 'Subject code');
    need(t(s.exam_date), 'Examination date'); need(t(s.start_time) && t(s.end_time), 'Examination time');
    need(t(s.duration), 'Duration'); need(parseInt(s.max_marks, 10) > 0, 'Maximum marks');
    need(t(d.internal_examiner.name), 'Internal examiner name'); need(t(d.external_examiner.name), 'External examiner name');
    const exps = d.experiments.filter(x => t(x.title) || x.subquestions.some(q => t(q.text)));
    if (exps.length < 2) out.push('List of Experiments (at least two)');
    return out;
  },

  onInput(e) {
    const el = e.target;
    if (!el.dataset || !el.dataset.bind || !this.draft) return;
    setPath(this.draft, el.dataset.bind, el.value);
    this.markDirty();
    if (el.dataset.bind === 'subject.subject_name') {
      const hit = this.lookups.subjects.find(s => s.subject_name === el.value);
      if (hit && !this.draft.subject.subject_code) { this.draft.subject.subject_code = hit.subject_code; const c = $('[data-bind="subject.subject_code"]'); if (c) c.value = hit.subject_code; }
    }
    if (/subject\.(start|end)_time/.test(el.dataset.bind)) {
      const dur = durationOf(this.draft.subject.start_time, this.draft.subject.end_time);
      if (dur) { this.draft.subject.duration = dur; const c = $('[data-bind="subject.duration"]'); if (c) c.value = dur; }
    }
    this.updateGeneratePanel();
  },

  markDirty() {
    this.dirty = true;
    const f = $('#pems-unsaved'); if (f) f.hidden = false;
  },

  // ─── Page ──────────────────────────────────────────────────────────────
  render() {
    const d = this.draft;
    const head = `<div class="page-title"><div><div class="eyebrow">${E(EXAM_NAME)}</div><h1>${E(d.subject.subject_name || 'New examination')}</h1>
      <p>${E([d.subject.subject_code, d.exam.programme, d.exam.semester && 'Semester ' + d.exam.semester, [d.exam.exam_month, d.exam.exam_year].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || 'Enter the details, upload the syllabus, check the experiments, then generate.')}</p></div>
      <div class="row"><span id="pems-unsaved" class="unsaved" ${this.dirty ? '' : 'hidden'}>Unsaved changes</span>${btn('Save', 'pems_save', '', 'check')}${btn('All examinations', 'go|Examinations')}</div></div>`;
    const flow = '<ol class="flow"><li>Examination details</li><li>Upload syllabus</li><li>Check experiments</li><li>Generate Word &amp; PDF</li></ol>';
    put(head + flow + this.vDetails() + this.vSyllabus() + this.vExperiments() + this.vMarks() + '<div id="pems-generate"></div>');
    this.updateGeneratePanel();
  },

  vDetails() {
    const d = this.draft;
    const f = (bind, label, value, type = 'text', extra = '') => `<label class="field">${E(label)}<input type="${type}" data-bind="${bind}" value="${E(value ?? '')}" ${extra}></label>`;
    const sel = (bind, label, value, opts) => `<label class="field">${E(label)}<select data-bind="${bind}"><option value="">Select…</option>${opts.map(o => `<option ${String(o) === String(value) ? 'selected' : ''}>${E(o)}</option>`).join('')}</select></label>`;
    const dl = (id, list) => `<datalist id="${id}">${list.map(x => `<option value="${E(x)}">`).join('')}</datalist>`;
    return card('1 · Examination details', `<div class="fixed-name"><small>Examination</small><b>${E(EXAM_NAME)}</b></div>
      <div class="fields">
        ${sel('exam.exam_month', 'Month', d.exam.exam_month, MONTHS)}${f('exam.exam_year', 'Year', d.exam.exam_year, 'number', 'min="2000" max="2100"')}
        ${f('exam.centre_no', 'Centre', d.exam.centre_no)}${f('exam.centre_name', 'College name', d.exam.centre_name)}
        ${f('exam.programme', 'Course / Programme', d.exam.programme, 'text', 'list="dl-prog" placeholder="e.g. Diploma in Information Technology"')}
        ${f('exam.department', 'Department', d.exam.department, 'text', 'list="dl-dept"')}${sel('exam.semester', 'Semester', d.exam.semester, SEMESTERS)}
      </div>
      <div class="fields gap">
        ${f('subject.subject_name', 'Subject name', d.subject.subject_name, 'text', 'list="dl-subj"')}${f('subject.subject_code', 'Subject code', d.subject.subject_code)}
        ${f('subject.exam_date', 'Examination date', d.subject.exam_date, 'date')}
        ${f('subject.start_time', 'Start time', d.subject.start_time, 'time')}${f('subject.end_time', 'End time', d.subject.end_time, 'time')}
        ${f('subject.duration', 'Duration', d.subject.duration, 'text', 'placeholder="e.g. 3 hrs."')}${f('subject.max_marks', 'Maximum marks', d.subject.max_marks, 'number', 'min="1"')}
      </div>
      <div class="fields gap">
        ${f('internal_examiner.name', 'Internal examiner', d.internal_examiner.name, 'text', 'list="dl-people"')}${f('external_examiner.name', 'External examiner', d.external_examiner.name, 'text', 'list="dl-people"')}
      </div>
      ${dl('dl-prog', this.lookups.programmes)}${dl('dl-dept', this.lookups.departments)}${dl('dl-subj', this.lookups.subjects.map(s => s.subject_name))}${dl('dl-people', this.lookups.people)}`);
  },

  vSyllabus() {
    const x = this.extraction, d = this.draft;
    let msg = '';
    if (x && x.ok) msg = `<p class="note ok">Found <b>${x.count}</b> experiment${x.count === 1 ? '' : 's'} in <b>${E(x.file)}</b>. Check them below and correct anything that was read wrongly.</p>` +
      (x.warnings.length ? `<div class="note warn"><b>Please check:</b><ul>${x.warnings.map(w => `<li>${E(w)}</li>`).join('')}</ul></div>` : '');
    else if (x && !x.ok) msg = `<div class="note bad"><b>The List of Experiments could not be extracted from ${E(x.file)}.</b><br>${E(x.error)}<br>Type the experiments below with <b>Add experiment</b>, or upload a different copy of the syllabus.</div>`;
    else if (d.syllabus_name) msg = `<p class="muted">Syllabus used: <b>${E(d.syllabus_name)}</b></p>`;
    return card('2 · Upload syllabus', `<div class="dropzone"><div>${ico('file')}<b>Syllabus file</b><small>PDF or Word (.docx). Only the List of Experiments is read from it; the PSG layout comes from the official template.</small></div>
      <label class="upload primary-outline">Choose file<input id="pems-syllabus-file" type="file" accept=".pdf,.docx"></label></div>${msg}`);
  },

  vExperiments() {
    const exps = this.draft.experiments;
    const rows = exps.map((e, i) => {
      const sub = k => `<textarea rows="3" data-bind="experiments.${i}.subquestions.${k}.text" placeholder="${String.fromCharCode(97 + k)}) optional">${E((e.subquestions[k] || {}).text || '')}</textarea>`;
      const extra = e.subquestions.slice(2).map((s, k) => `<label class="extra"><span>${E(s.letter || String.fromCharCode(99 + k))})</span><textarea rows="2" data-bind="experiments.${i}.subquestions.${k + 2}.text">${E(s.text)}</textarea></label>`).join('');
      return `<tr><td class="no">${i + 1}</td><td><textarea rows="3" data-bind="experiments.${i}.title" placeholder="Experiment name / description">${E(e.title)}</textarea></td><td>${sub(0)}</td><td>${sub(1)}${extra}</td>
        <td class="tight"><div class="iconrow">${btn('↑', `pems_exp_move|${i}|-1`, 'icon')}${btn('↓', `pems_exp_move|${i}|1`, 'icon')}${btn('Delete', `pems_exp_del|${i}`, 'ghost')}</div></td></tr>`;
    }).join('');
    const body = exps.length
      ? `<p class="muted">Printed as shown. Where an experiment has sub-questions, the sub-questions are printed; otherwise its name is printed.</p><div class="tablewrap"><table class="edit-table exp"><thead><tr><th>No</th><th>Experiment</th><th>Sub-question a)</th><th>Sub-question b)</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty">' + ico('book') + 'No experiments yet. Upload the syllabus above, or add them by hand.</div>';
    return card('3 · List of Experiments', body + `<div class="actions spread">${btn('Add experiment', 'pems_exp_add', '', 'plus')}<span class="muted">${exps.length} experiment${exps.length === 1 ? '' : 's'}</span></div>`);
  },

  vMarks() {
    const rows = this.draft.mark_components.map((c, i) => `<tr><td class="no">${i + 1}</td><td><input data-bind="mark_components.${i}.description" value="${E(c.description)}"></td><td class="num"><input type="number" min="0" data-bind="mark_components.${i}.max_marks" value="${E(c.max_marks)}"></td><td class="tight">${btn('Remove', `pems_mark_del|${i}`, 'ghost')}</td></tr>`).join('');
    return `<details class="card fold"><summary><h2>Allocation of marks</h2><span class="muted">Standard PSG scheme, change only if needed</span><span id="pems-marks-total" class="pill"></span></summary>
      <div class="tablewrap"><table class="edit-table"><thead><tr><th>S.No</th><th>Description of allocation</th><th>Maximum marks</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="actions spread">${btn('Add row', 'pems_mark_add', '', 'plus')}<span></span></div></details>`;
  },

  updateGeneratePanel() {
    const box = $('#pems-generate'); if (!box) return;
    const total = this.draft.mark_components.reduce((n, c) => n + (parseInt(c.max_marks, 10) || 0), 0);
    const max = parseInt(this.draft.subject.max_marks, 10) || 0;
    const tot = $('#pems-marks-total');
    if (tot) { tot.textContent = `Total ${total}${max && total !== max ? `, maximum marks is ${max}` : ''}`; tot.className = 'pill ' + (max && total !== max ? 'warn' : 'ok'); }
    const miss = this.missing();
    const files = this.generated;
    const done = files.length ? `<div class="generated"><h3>${ico('check')} Documents generated successfully</h3>${['docx', 'pdf'].map(fmt => {
      const f = files.find(x => x.format === fmt); if (!f) return '';
      return `<div class="genrow"><span class="ficon ${fmt}">${fmt === 'pdf' ? 'PDF' : 'DOCX'}</span><div><b>${E(f.name)}</b><small>${Math.max(1, Math.round(f.size / 1024))} KB${f.generated_at ? ' · ' + E(time(f.generated_at)) : ''}</small></div>
        <div class="row">${fmt === 'pdf' ? btn('Preview', 'pems_preview', '', 'eye') : ''}${btn(fmt === 'pdf' ? 'Download PDF' : 'Download Word', `pems_download|${fmt}`, 'primary', 'download')}</div></div>`;
    }).join('')}${this.dirty ? '<p class="note warn">Details changed after these files were made. Click Generate again to include the changes.</p>' : ''}</div>` : '';
    box.innerHTML = `<section class="card generate"><div class="card-head"><h2>4 · Generate the official document</h2></div>
      <p class="muted">One Word file and one PDF in the PSG format: List of Experiments, Question Paper (Part A is the first half of the experiments, Part B the rest) and Allocation of Marks.</p>
      ${miss.length ? `<div class="note warn"><b>Still needed:</b> ${E(miss.join(', '))}.</div>` : ''}
      ${max && total !== max ? `<div class="note warn">Allocation of marks totals ${total}, but maximum marks is ${max}.</div>` : ''}
      <div class="actions spread"><span></span>${btn(files.length ? 'Generate again' : 'Generate Documents', 'pems_generate', 'primary big', 'file')}</div>${done}</section>`;
    const g = box.querySelector('[data-action="pems_generate"]'); if (g && miss.length) g.disabled = true;
  },

  async upload(file) {
    const inp = $('#pems-syllabus-file');
    notice('Reading ' + file.name + '…');
    const fd = new FormData(); fd.append('file', file);
    let r;
    try { r = await api('pems_upload_syllabus', fd); }
    catch (e) { this.extraction = { ok: false, file: file.name, error: e.message }; this.render(); return; }
    finally { if (inp) inp.value = ''; }
    if (!r.experiments.length) { this.extraction = { ok: false, file: file.name, error: 'No numbered experiments were found.' }; this.render(); return; }
    if (this.draft.experiments.length && !confirm(`Replace the ${this.draft.experiments.length} experiments in the list with the ${r.experiments.length} found in ${file.name}?`)) return;
    this.draft.experiments = r.experiments.map(e => ({ title: [e.title, e.description].filter(Boolean).join('\n'), subquestions: (e.subquestions || []).map(s => ({ letter: s.letter, text: s.text })) }));
    this.draft.syllabus_file = { file_name: r.file_name, stored_name: r.stored_name };
    this.extraction = { ok: true, file: r.file_name, count: r.experiments.length, warnings: r.warnings || [] };
    this.markDirty();
    this.render();
  },

  fileFor(fmt) { return this.generated.find(f => f.format === fmt); },
};

// ─── Helpers ──────────────────────────────────────────────────────────────
function setPath(obj, path, val) {
  const k = path.split('.');
  let o = obj;
  for (let i = 0; i < k.length - 1; i++) {
    if (o[k[i]] === undefined || o[k[i]] === null) o[k[i]] = /^\d+$/.test(k[i + 1]) ? [] : {};
    o = o[k[i]];
  }
  o[k[k.length - 1]] = val;
  if (/^experiments\.\d+\.subquestions\.\d+\.text$/.test(path)) {
    obj.experiments[+k[1]].subquestions.forEach((s, i) => { if (s && !s.letter) s.letter = String.fromCharCode(97 + i); });
  }
}
function toTime(v) {
  const m = String(v || '').trim().match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!m) return '';
  let h = +m[1];
  if (m[3]) { const pm = m[3].toLowerCase() === 'pm'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}
function durationOf(a, b) {
  const p = t => { const m = String(t || '').match(/^(\d{2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
  const x = p(a), y = p(b);
  if (x === null || y === null || y <= x) return '';
  const mins = y - x, h = Math.floor(mins / 60), r = mins % 60;
  return r ? `${h} hrs. ${r} mins.` : `${h} hr${h === 1 ? '' : 's'}.`;
}

// ─── Actions ──────────────────────────────────────────────────────────────
act('pems_new_exam', () => PEMS.startWizard(0));
act('pems_edit_exam', id => PEMS.startWizard(Number(id)));
act('pems_open_exam', id => PEMS.startWizard(Number(id)));
act('pems_delete_exam', async id => {
  if (!confirm('Delete this examination and its generated documents? This cannot be undone.')) return;
  await api('pems_delete_exam', { id: Number(id) });
  notice('Examination deleted.');
  PEMS.renderExamsList();
});
act('pems_save', async () => { await PEMS.save(); PEMS.render(); notice('Saved.'); });
act('pems_exp_add', () => { PEMS.draft.experiments.push({ title: '', subquestions: [{ letter: 'a', text: '' }, { letter: 'b', text: '' }] }); PEMS.markDirty(); PEMS.render(); const t = $$('textarea[data-bind$=".title"]'); if (t.length) t[t.length - 1].focus(); });
act('pems_exp_del', i => { if (!confirm(`Delete experiment ${Number(i) + 1}?`)) return; PEMS.draft.experiments.splice(Number(i), 1); PEMS.markDirty(); PEMS.render(); });
act('pems_exp_move', (i, dir) => { i = Number(i); const j = i + Number(dir), a = PEMS.draft.experiments; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; PEMS.markDirty(); PEMS.render(); });
act('pems_mark_add', () => { PEMS.draft.mark_components.push({ description: '', max_marks: 0 }); PEMS.markDirty(); PEMS.render(); $('details.fold').open = true; });
act('pems_mark_del', i => { PEMS.draft.mark_components.splice(Number(i), 1); PEMS.markDirty(); PEMS.render(); $('details.fold').open = true; });
act('pems_generate', async () => {
  const b = $('[data-action="pems_generate"]');
  if (b) { b.classList.add('busy'); b.lastChild.textContent = 'Generating Word and PDF…'; }
  try {
    await PEMS.save();
    const r = await api('pems_generate', { exam_id: PEMS.draft.id });
    PEMS.generated = r.files.map(f => ({ ...f, generated_at: r.generated_at }));
    PEMS.draft.status = 'Generated';
    notice('Documents generated.');
  } finally {
    PEMS.render();
    $('#pems-generate').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
act('pems_download', async fmt => {
  const f = PEMS.fileFor(fmt);
  download(await api('pems_download', { exam_id: PEMS.draft.id, format: fmt }, true), f ? f.name : `document.${fmt}`);
});
act('pems_preview', async () => {
  const f = PEMS.fileFor('pdf');
  modal(f ? f.name : 'Preview', '<div class="pdfwrap"><p class="muted">Loading…</p></div>');
  $('#dialog').classList.add('wide');
  const blob = await api('pems_download', { exam_id: PEMS.draft.id, format: 'pdf', inline: true }, true);
  $('#modal .pdfwrap').innerHTML = `<iframe title="Document preview" src="${URL.createObjectURL(blob)}"></iframe>`;
});
document.addEventListener('close', e => { if (e.target.id === 'dialog') e.target.classList.remove('wide'); }, true);

// index.php initialises the module through window.PEMS.
window.PEMS = PEMS;
