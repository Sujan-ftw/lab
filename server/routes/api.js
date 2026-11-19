'use strict';
const express = require('express');
const multer = require('multer');
const { identity, audit, login, ensureCsrf } = require('../auth');
const { query, rows, one } = require('../db');
const pems = require('../services/pemsService');
const legacy = require('../services/legacyService');
const docs = require('../services/documentService');
const { examStatus, generationMissing } = require('../services/readiness');
const { docxToPdf } = require('../services/pdfConverter');
const att = require('../services/attendanceService');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

/** Generated documents are kept per examination until the next generation replaces them. */
const generatedDir = id => path.join(__dirname, '../../var/generated', `exam-${parseInt(id, 10)}`);
function generatedFiles(id) {
  const dir = generatedDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => /\.(docx|pdf)$/i.test(n)).map(n => {
    const st = fs.statSync(path.join(dir, n));
    return { format: n.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx', name: n, size: st.size, generated_at: st.mtime.toISOString() };
  });
}

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }
});

router.post('/', upload.single('file'), async (req, res) => {
  const op = req.query.op || '';
  const d = req.body || {};

  try {
    // 1. Login doesn't require session auth or CSRF
    if (op === 'login') {
      const result = await login(req, d);
      return res.json(result);
    }

    // CSRF check
    const token = req.headers['x-csrf-token'] || req.body?.csrf || '';
    const sessToken = req.session?.csrf || '';
    if (!token || !sessToken || token !== sessToken) {
      return res.status(403).json({ error: 'Refresh the page and try again.' });
    }

    // 2. Identify user
    const u = await identity(req);
    if (!u) {
      return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
    }

    let result = {};

    switch (op) {
      case 'logout': {
        await audit(u.id, 'Logout', 'Signed out');
        const crypto = require('crypto');
        const tokenHash = crypto.createHash('sha256').update(req.sessionID || '').digest('hex');
        await query('DELETE FROM connections WHERE token=?', [tokenHash]);
        req.session.destroy();
        return res.json({ ok: true });
      }

      case 'overview': {
        const legacyData = await legacy.overview(u);
        const pemsExams = await pems.listExaminations(u);
        const pemsSettings = await pems.getSettings();
        const notifications = await pems.getNotifications(u.id);
        const staffDirectory = await pems.getStaffDirectory();
        const depts = await rows('SELECT * FROM departments ORDER BY name ASC');

        result = {
          ...legacyData,
          pems_examinations: pemsExams,
          settings: pemsSettings,
          notifications,
          staff_directory: staffDirectory,
          departments: depts
        };
        break;
      }

      // ── PEMS Examinations ───────────────────────────────────────
      case 'pems_list_exams': {
        result = { examinations: await pems.listExaminations(u, d.filters || {}) };
        break;
      }
      case 'pems_get_exam': {
        const examId = parseInt(d.id || 0);
        const data = await pems.getExamination(examId, u);
        result = { ...data, status: examStatus(data), missing: generationMissing(data), generated: generatedFiles(examId) };
        break;
      }
      case 'pems_lookups': {
        result = await pems.getLookups(u);
        break;
      }
      case 'pems_save_exam': {
        result = await pems.saveExamination(u, d);
        break;
      }
      case 'pems_approve': {
        result = await pems.approve(u, parseInt(d.exam_id || 0), String(d.section || ''), d.approved !== false && d.approved !== 'false');
        break;
      }
      case 'pems_save_batch_set': {
        result = await pems.saveBatchSet(u, parseInt(d.exam_id || 0), parseInt(d.batch_id || 0), d.questions || [], Boolean(d.approve));
        break;
      }
      // ── Examination document: generate (DOCX + PDF), store, download ──
      case 'pems_generate': {
        const examId = parseInt(d.exam_id || 0);
        const data = await pems.getExamination(examId, u);
        const missing = generationMissing(data);
        if (missing.length) return res.status(422).json({ error: 'Fill in: ' + missing.join(', ') + '.', missing });
        const docx = docs.buildDocx(data, 'examination_document');
        const pdf = await docxToPdf(docx);
        if (!docx.length || !pdf.length) throw new Error('The document could not be generated.');
        const dir = generatedDir(examId);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        const files = [];
        for (const [format, bytes] of [['docx', docx], ['pdf', pdf]]) {
          const name = docs.examFileName(data, format);
          fs.writeFileSync(path.join(dir, name), bytes);
          files.push({ format, name, size: bytes.length });
          await query("INSERT INTO exam_documents (exam_id, batch_id, document_type, format, file_name, status, created_by) VALUES (?, NULL, 'examination_document', ?, ?, 'Prepared', ?)", [examId, format, name, u.id]);
        }
        await query("UPDATE examinations SET status = 'Generated' WHERE id = ? AND status <> 'Finalized'", [examId]);
        await pems.logAudit(u.id, u.role, 'Document Generated', 'examinations', examId, `Generated ${files.map(f => f.name).join(' and ')}`);
        result = { ok: true, files, generated_at: new Date().toISOString() };
        break;
      }
      case 'pems_download': {
        const examId = parseInt(d.exam_id || 0);
        await pems.assertOwner(examId, u);
        const format = d.format === 'pdf' ? 'pdf' : 'docx';
        const file = generatedFiles(examId).find(f => f.format === format);
        if (!file) return res.status(404).json({ error: 'Generate the documents first.' });
        res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `${d.inline ? 'inline' : 'attachment'}; filename="${file.name}"`);
        return res.send(fs.readFileSync(path.join(generatedDir(examId), file.name)));
      }

      // ── Attendance sheets (independent of the examination documents) ──
      case 'att_list': {
        result = { sheets: await att.list(u) };
        break;
      }
      case 'att_get': {
        const sheet = await att.get(u, parseInt(d.id || 0));
        result = { sheet, missing: att.problems(sheet) };
        break;
      }
      case 'att_save': {
        const students = typeof d.students === 'string' ? JSON.parse(d.students || '[]') : d.students;
        result = await att.save(u, { ...d, students });
        break;
      }
      case 'att_delete': {
        result = await att.remove(u, parseInt(d.id || 0));
        await pems.logAudit(u.id, u.role, 'Attendance Deleted', 'attendance_sheets', parseInt(d.id || 0), 'Deleted attendance sheet');
        break;
      }
      case 'att_import': {
        if (!req.file) return res.status(422).json({ error: 'Choose an Excel or CSV file.' });
        result = att.parseImport(req.file.buffer, req.file.originalname);
        break;
      }
      case 'att_exam_options': {
        const exams = await pems.listExaminations(u);
        const out = [];
        for (const e of exams.slice(0, 40)) {
          try {
            const x = await pems.getExamination(parseInt(e.id, 10), u);
            const sub = x.subject || {};
            out.push({ id: x.exam.id, label: `${sub.subject_name || 'Untitled'}${sub.subject_code ? ' (' + sub.subject_code + ')' : ''} – ${x.exam.exam_month || ''} ${x.exam.exam_year || ''}`.trim(),
              subject_name: sub.subject_name || '', subject_code: sub.subject_code || '', department: x.exam.department_name || x.exam.department || '',
              semester: x.exam.semester || '', exam_date: sub.lab_date ? String(sub.lab_date instanceof Date ? sub.lab_date.toISOString() : sub.lab_date).slice(0, 10) : '',
              internal_examiner: (x.internal_examiner && x.internal_examiner.name) || '', external_examiner: (x.external_examiner && x.external_examiner.name) || '' });
          } catch { /* skip unreadable */ }
        }
        result = { exams: out };
        break;
      }
      case 'att_preview': {
        const pdf = await att.preview(u, parseInt(d.id || 0));
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="Attendance_Preview.pdf"');
        return res.send(pdf);
      }
      case 'att_generate': {
        const id = parseInt(d.id || 0);
        result = await att.generate(u, id);
        await pems.logAudit(u.id, u.role, 'Attendance Generated', 'attendance_sheets', id, `Generated ${result.docx_name} and ${result.pdf_name}`);
        break;
      }
      case 'att_download': {
        const format = d.format === 'pdf' ? 'pdf' : 'docx';
        const f = await att.file(u, parseInt(d.id || 0), parseInt(d.version || 0), format);
        res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `${d.inline ? 'inline' : 'attachment'}; filename="${f.name}"`);
        return res.send(f.bytes);
      }

      case 'pems_doc_status': {
        const data = await pems.getExamination(parseInt(d.exam_id || 0), u);
        result = examStatus(data);
        break;
      }
      case 'pems_finalize_exam': {
        const examId = parseInt(d.id || 0);
        result = await pems.finalizeExamination(u, examId);
        break;
      }
      case 'pems_reopen_exam': {
        const examId = parseInt(d.id || 0);
        result = await pems.reopenExamination(u, examId, (d.reason || '').trim());
        break;
      }
      case 'pems_delete_exam': {
        const examId = parseInt(d.id || 0);
        const existing = await one('SELECT * FROM examinations WHERE id = ?', [examId]);
        if (!existing || (u.role !== 'admin' && parseInt(existing.owner_id) !== parseInt(u.id))) {
          return res.status(403).json({ error: 'Unauthorized.' });
        }
        if (existing.status === 'Finalized' && u.role !== 'admin') {
          return res.status(422).json({ error: 'Cannot delete finalized examinations.' });
        }
        await query('DELETE FROM examinations WHERE id = ?', [examId]);
        fs.rmSync(generatedDir(examId), { recursive: true, force: true });
        await pems.logAudit(u.id, u.role, 'Examination Deleted', 'examinations', examId, `Deleted examination #${examId}`);
        result = { ok: true };
        break;
      }

      // ── Allocation (preview → confirm) ───────────────────────────
      case 'pems_check_capacity': {
        result = await pems.checkCapacity(u, parseInt(d.exam_id || 0), parseInt(d.batch_id || 0));
        break;
      }
      case 'pems_preview_allocations': {
        const mode = ['Balanced Random', 'Pure Random'].includes(d.mode) ? d.mode : 'Balanced Random';
        result = await pems.previewAllocations(u, parseInt(d.exam_id || 0), parseInt(d.batch_id || 0), mode);
        break;
      }
      case 'pems_confirm_allocations': {
        const mode = ['Balanced Random', 'Pure Random'].includes(d.mode) ? d.mode : 'Balanced Random';
        result = await pems.confirmAllocations(u, parseInt(d.exam_id || 0), parseInt(d.batch_id || 0), mode, d.allocations || [], (d.reason || '').trim());
        break;
      }
      case 'pems_batch_allocations': {
        const batchId = parseInt(d.batch_id || 0);
        const version = parseInt(d.version || 0);
        result = await pems.getBatchAllocations(batchId, version);
        break;
      }

      // ── Exports (each document checked against its own requirements) ──
      case 'pems_export': {
        const examId = parseInt(d.exam_id || 0);
        const key = String(d.doc_type || '');
        const format = String(d.format || 'docx').toLowerCase() === 'pdf' ? 'pdf' : 'docx';
        const data = await pems.getExamination(examId, u);
        const status = examStatus(data);
        const doc = status.documents.find(x => x.key === key);
        if (!doc) return res.status(404).json({ error: 'Unknown document.' });
        if (!doc.available) {
          return res.status(422).json({ error: `${doc.name} cannot be generated yet. Missing: ${doc.missing.map(m => m.text).join('; ')}.`, missing: doc.missing });
        }
        const extras = {};
        if (key.startsWith('student_allocation:')) {
          const alloc = await pems.getBatchAllocations(parseInt(key.split(':')[1], 10));
          extras.allocations = alloc.allocations || [];
          extras.generation = alloc.generation || {};
        }
        let bytes = docs.buildDocx(data, key, extras);
        let mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        if (format === 'pdf') { bytes = await docxToPdf(bytes); mime = 'application/pdf'; }
        const filename = docs.fileName(data, key, format);
        const [kind, bid] = key.split(':');
        await query(
          "INSERT INTO exam_documents (exam_id, batch_id, document_type, format, file_name, status, created_by) VALUES (?, ?, ?, ?, ?, 'Prepared', ?)",
          [examId, bid ? parseInt(bid, 10) : null, kind, format, filename, u.id]
        );
        await pems.logAudit(u.id, u.role, 'Document Exported', 'examinations', examId, `Exported ${doc.name} as ${format.toUpperCase()} (${filename})`);
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Disposition', `${d.inline ? 'inline' : 'attachment'}; filename="${filename}"`);
        return res.send(bytes);
      }

      // ── Student Import ───────────────────────────────────────────
      case 'pems_import_students': {
        if (!req.file) {
          return res.status(422).json({ error: 'Select a CSV or Excel file.' });
        }
        const ext = req.file.originalname.split('.').pop().toLowerCase();
        let rowsArr = [];
        if (ext === 'csv') {
          const wb = XLSX.read(req.file.buffer.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true });
          rowsArr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
        } else if (ext === 'xlsx' || ext === 'xls') {
          const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
          rowsArr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
        } else {
          return res.status(422).json({ error: 'Supported formats are .csv, .xlsx and .xls.' });
        }
        rowsArr = rowsArr.map(r => r.map(c => String(c ?? '').trim()));
        // Column positions from the header row when present (Roll Number, Student Name).
        let rollCol = 0, nameCol = 1, start = 0;
        if (rowsArr.length) {
          const h = rowsArr[0].map(c => c.toLowerCase());
          const ri = h.findIndex(c => /roll|reg/.test(c));
          if (ri >= 0) {
            rollCol = ri;
            const ni = h.findIndex(c => /name/.test(c));
            nameCol = ni >= 0 ? ni : (ri === 0 ? 1 : 0);
            start = 1;
          }
        }
        const valid = [], duplicates = [], invalid = [], seen = {};
        for (let idx = start; idx < rowsArr.length; idx++) {
          const r = rowsArr[idx];
          if (!r.some(c => c)) continue;
          const roll = (r[rollCol] || '').toUpperCase().replace(/\s+/g, '');
          const name = (r[nameCol] || '').replace(/\s+/g, ' ');
          const line = idx + 1;
          if (!roll) { invalid.push({ row: line, roll: '', name, reason: 'Roll number is empty' }); continue; }
          if (!/^[A-Z0-9][A-Z0-9/-]{2,29}$/.test(roll)) { invalid.push({ row: line, roll, name, reason: 'Roll number has invalid characters' }); continue; }
          if (seen[roll]) { duplicates.push({ row: line, roll, name, reason: `Same roll number as row ${seen[roll]}` }); continue; }
          seen[roll] = line;
          valid.push({ roll_no: roll, name });
        }
        result = {
          total_rows: rowsArr.length - start,
          valid_count: valid.length,
          duplicate_count: duplicates.length,
          invalid_count: invalid.length,
          duplicates,
          invalid,
          students: valid
        };
        break;
      }

      case 'pems_sample_csv': {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="student_list_template.csv"');
        return res.send('﻿Roll Number,Student Name\r\n');
      }

      // ── Syllabus Upload & Template ───────────────────────────────
      case 'pems_upload_syllabus': {
        if (!req.file) {
          return res.status(422).json({ error: 'Choose the syllabus file (PDF or DOCX).' });
        }
        const { parseSyllabus } = require('../services/syllabusParser');
        const parsed = await parseSyllabus(req.file.buffer, req.file.originalname);

        const uploadDir = path.join(__dirname, '../../var/uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        const safeName = Date.now() + '_' + req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        fs.writeFileSync(path.join(uploadDir, safeName), req.file.buffer);
        await pems.logAudit(u.id, u.role, 'Syllabus Uploaded', 'syllabus', null, `Uploaded ${req.file.originalname} (${parsed.experiments.length} experiments extracted)`);

        result = {
          file_name: req.file.originalname,
          stored_name: safeName,
          uploaded_at: new Date().toISOString(),
          experiments: parsed.experiments,
          warnings: parsed.warnings,
          source: parsed.source
        };
        break;
      }

      case 'pems_sample_syllabus_csv': {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="experiment_list_template.csv"');
        return res.send('﻿Experiment Number,Experiment Title,Sub-question A,Sub-question B\r\n');
      }

      // ── Admin Features ───────────────────────────────────────────
      case 'pems_admin_calendar': {
        if (u.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        const examRows = await rows(`SELECT e.id, e.title, e.department, e.programme, e.semester, e.exam_date, e.status,
                                            s.subject_name, s.subject_code, s.start_time, s.end_time,
                                            u.name as staff_name,
                                            ex1.name as internal_examiner, ex2.name as external_examiner
                                     FROM examinations e
                                     JOIN users u ON e.owner_id = u.id
                                     LEFT JOIN exam_subjects s ON s.exam_id = e.id
                                     LEFT JOIN exam_examiners ex1 ON ex1.exam_id = e.id AND ex1.role_type = 'internal'
                                     LEFT JOIN exam_examiners ex2 ON ex2.exam_id = e.id AND ex2.role_type = 'external'
                                     ORDER BY e.exam_date ASC`);
        const events = [];
        for (const ex of examRows) {
          const batches = await rows('SELECT * FROM exam_batches WHERE exam_id = ?', [ex.id]);
          for (const b of batches) {
            events.push({
              exam_id: ex.id,
              batch_id: b.id,
              title: `${ex.subject_code} - ${b.batch_code}`,
              exam_name: ex.title,
              department: ex.department,
              subject: ex.subject_name,
              subject_code: ex.subject_code,
              semester: ex.semester,
              batch_code: b.batch_code,
              student_count: b.student_count,
              date: b.exam_date || ex.exam_date,
              start_time: b.start_time || ex.start_time,
              end_time: b.end_time || ex.end_time,
              room: b.room,
              invigilator: b.invigilator_name,
              internal_examiner: ex.internal_examiner,
              external_examiner: ex.external_examiner,
              staff_name: ex.staff_name,
              status: ex.status
            });
          }
        }
        result = { events };
        break;
      }

      case 'pems_admin_analytics': {
        if (u.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        const eCount = await one('SELECT COUNT(*) n FROM examinations');
        const bCount = await one('SELECT COUNT(*) n FROM exam_batches');
        const sCount = await one('SELECT COALESCE(SUM(student_count), 0) n FROM exam_batches');
        const gCount = await one('SELECT COUNT(*) n FROM exam_allocation_generations');
        const dCount = await one('SELECT COUNT(*) n FROM exam_documents');

        const byDept = await rows('SELECT department, COUNT(*) as exam_count, (SELECT COALESCE(SUM(b.student_count),0) FROM exam_batches b JOIN examinations e2 ON b.exam_id=e2.id WHERE e2.department=e.department) as student_count FROM examinations e GROUP BY department');
        const byStatus = await rows('SELECT status, COUNT(*) as count FROM examinations GROUP BY status');
        const recentGenerations = await rows('SELECT g.*, e.title as exam_title, b.batch_code, u.name as staff_name FROM exam_allocation_generations g JOIN examinations e ON g.exam_id=e.id JOIN exam_batches b ON g.batch_id=b.id JOIN users u ON g.created_by=u.id ORDER BY g.completed_at DESC LIMIT 10');

        result = {
          kpis: {
            total_exams: parseInt(eCount.n),
            total_batches: parseInt(bCount.n),
            total_students: parseInt(sCount.n),
            total_generations: parseInt(gCount.n),
            total_exports: parseInt(dCount.n)
          },
          by_department: byDept,
          by_status: byStatus,
          recent_generations: recentGenerations
        };
        break;
      }

      case 'pems_audit_logs': {
        if (u.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        const limit = Math.min(200, parseInt(d.limit || 100));
        const logs = await rows('SELECT a.*, u.name as user_name FROM audit_logs a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.id DESC LIMIT ?', [limit]);
        result = { logs };
        break;
      }

      case 'pems_save_settings': {
        result = await pems.saveSettings(u, d);
        break;
      }

      case 'pems_staff_directory': {
        if (d.name) {
          result = await pems.saveStaffDirectoryMember(u, d);
        } else {
          result = { directory: await pems.getStaffDirectory(d.role_type || '') };
        }
        break;
      }

      case 'pems_notifications': {
        if (d.mark_read) {
          await pems.markNotificationRead(u.id, parseInt(d.mark_read));
          result = { ok: true };
        } else {
          result = { notifications: await pems.getNotifications(u.id) };
        }
        break;
      }

      // ── Legacy operations ────────────────────────────────────────
      case 'save':
      case 'generate': {
        result = await legacy.saveGeneration(u, d, op === 'generate');
        break;
      }
      case 'session': {
        result = await legacy.readSession(d.id, u, d.vid || 0);
        break;
      }
      case 'finalize': {
        result = await legacy.finalize(u, d);
        break;
      }
      case 'user': {
        result = await legacy.manageUser(u, d);
        break;
      }
      case 'saveLibrary': {
        result = await legacy.saveLibrary(u, d);
        break;
      }
      case 'import': {
        if (!req.file) return res.status(422).json({ error: 'No file provided.' });
        result = await legacy.importFile(u, d.kind === 'items' ? 'items' : 'students', req.file.buffer, req.file.originalname);
        break;
      }
      case 'export': {
        const exp = await legacy.exportResult(u, d);
        res.setHeader('Content-Type', exp.mime);
        res.setHeader('Content-Disposition', `attachment; filename="${exp.filename}"`);
        return res.send(exp.bytes);
      }
      case 'timezone': {
        if (u.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        await query("INSERT INTO settings (k, val) VALUES ('timezone', ?) ON DUPLICATE KEY UPDATE val=VALUES(val)", [d.zone]);
        await audit(u.id, 'Settings', 'Changed display timezone');
        result = { ok: true };
        break;
      }

      default:
        return res.status(404).json({ error: `Unknown action: ${op}` });
    }

    return res.json(result);
  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).json({ error: err.message || 'Operation failed' });
  }
});

module.exports = router;
