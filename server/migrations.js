'use strict';
/**
 * Additive, idempotent schema corrections for the practical examination workflow.
 * Nothing here drops tables or deletes rows; every statement can run repeatedly.
 */
const { query } = require('./db');

const STATEMENTS = [
  // Drafts can be saved before every date is known.
  'ALTER TABLE examinations MODIFY exam_date DATE NULL',
  'ALTER TABLE exam_subjects MODIFY lab_date DATE NULL',
  'ALTER TABLE exam_schedules MODIFY exam_date DATE NULL',
  'ALTER TABLE exam_batches MODIFY exam_date DATE NULL',

  // Approval state: documents and allocation use only approved content.
  'ALTER TABLE examinations ADD COLUMN IF NOT EXISTS experiments_approved_at DATETIME NULL',
  'ALTER TABLE examinations ADD COLUMN IF NOT EXISTS qp_approved_at DATETIME NULL',
  'ALTER TABLE exam_question_sets ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL',

  // Each batch has its own invigilators.
  'ALTER TABLE exam_batches ADD COLUMN IF NOT EXISTS additional_invigilators VARCHAR(255) NULL',

  // Preserve the link between a question paper sub-question and its source experiment.
  'ALTER TABLE exam_qp_subquestions ADD COLUMN IF NOT EXISTS source_exp_no INT NULL',
  'ALTER TABLE exam_qp_subquestions ADD COLUMN IF NOT EXISTS source_letter VARCHAR(10) NULL',

  // Uploaded syllabus file record.
  'ALTER TABLE exam_syllabi ADD COLUMN IF NOT EXISTS stored_name VARCHAR(255) NULL',

  // Attendance sheets: independent of the examination document workflow.
  `CREATE TABLE IF NOT EXISTS attendance_sheets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NOT NULL,
    exam_name VARCHAR(200) NOT NULL DEFAULT 'Semester Practical Examinations',
    subject_name VARCHAR(200) NOT NULL DEFAULT '',
    subject_code VARCHAR(50) NOT NULL DEFAULT '',
    department VARCHAR(150) NOT NULL DEFAULT '',
    semester VARCHAR(20) NOT NULL DEFAULT '',
    exam_date DATE NULL,
    batch_name VARCHAR(100) NOT NULL DEFAULT '',
    internal_examiner VARCHAR(150) NOT NULL DEFAULT '',
    external_examiner VARCHAR(150) NOT NULL DEFAULT '',
    roll_prefix VARCHAR(30) NOT NULL DEFAULT '',
    students_json MEDIUMTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY (owner_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS attendance_files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sheet_id INT NOT NULL,
    version INT NOT NULL,
    docx_name VARCHAR(200) NOT NULL,
    pdf_name VARCHAR(200) NOT NULL,
    student_count INT NOT NULL,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (sheet_id, version),
    CONSTRAINT fk_att_files_sheet FOREIGN KEY (sheet_id) REFERENCES attendance_sheets(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function runMigrations() {
  for (const sql of STATEMENTS) {
    try {
      await query(sql);
    } catch (e) {
      console.error('[migrate] ' + sql + ' -> ' + e.message);
    }
  }
}

module.exports = { runMigrations };
