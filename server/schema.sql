-- =====================================================================
-- PSG Practical Examination Management System (PEMS) - Complete Schema
-- =====================================================================

-- Base settings
CREATE TABLE IF NOT EXISTS settings (
    k VARCHAR(60) PRIMARY KEY,
    val LONGTEXT NOT NULL
) ENGINE=InnoDB;

-- Ensure default institution settings exist
INSERT IGNORE INTO settings (k, val) VALUES
('institution_name', 'PSG Polytechnic College'),
('institution_short_name', 'PSG Tech / PSGPTC'),
('centre_no', '209'),
('centre_name', 'PSG Polytechnic College Examination Centre'),
('institution_address', 'Avinashi Road, Peelamedu, Coimbatore - 641004, Tamil Nadu, India'),
('default_academic_year', '2023-2024'),
('default_max_marks', '75'),
('default_duration', '3 hrs.'),
('timezone', 'Asia/Kolkata');

-- Departments
CREATE TABLE IF NOT EXISTS departments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE
) ENGINE=InnoDB;

INSERT IGNORE INTO departments (name) VALUES 
('Information Technology'),
('Computer Networking'),
('Mechanical Engineering'),
('Electrical and Electronics Engineering'),
('Electronics and Communication Engineering'),
('Automobile Engineering'),
('Apparel Technology'),
('Administration');

-- Users (Staff & Admin)
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(190) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    department_id INT NOT NULL,
    role ENUM('admin', 'staff') NOT NULL,
    admin_slot TINYINT GENERATED ALWAYS AS (IF(role='admin', 1, NULL)) STORED UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT 1,
    epoch INT NOT NULL DEFAULT 1,
    last_login DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (department_id) REFERENCES departments(id)
) ENGINE=InnoDB;

-- Login throttle log
CREATE TABLE IF NOT EXISTS logins (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    ip VARCHAR(45) NOT NULL,
    identity_hash CHAR(64) NOT NULL,
    at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (ip, at),
    INDEX (identity_hash, at)
) ENGINE=InnoDB;

-- Active session connection tokens
CREATE TABLE IF NOT EXISTS connections (
    token CHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    seen DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Programmes
CREATE TABLE IF NOT EXISTS programmes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    department_id INT NOT NULL,
    code VARCHAR(30) NOT NULL,
    name VARCHAR(150) NOT NULL,
    FOREIGN KEY (department_id) REFERENCES departments(id)
) ENGINE=InnoDB;

INSERT IGNORE INTO programmes (department_id, code, name) 
SELECT id, 'DIT', 'Diploma in Information Technology' FROM departments WHERE name='Information Technology' LIMIT 1;

-- Staff Directory (Examiners, Invigilators, Teaching Faculty)
CREATE TABLE IF NOT EXISTS staff_directory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    designation VARCHAR(120) NOT NULL,
    department VARCHAR(120) NOT NULL,
    employee_id VARCHAR(60) NOT NULL,
    institution VARCHAR(200) NOT NULL DEFAULT 'PSG Polytechnic College',
    email VARCHAR(190) NULL,
    phone VARCHAR(30) NULL,
    role_type ENUM('internal', 'external', 'invigilator', 'general') NOT NULL DEFAULT 'general',
    address TEXT NULL,
    active BOOLEAN NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Master Examinations
CREATE TABLE IF NOT EXISTS examinations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NOT NULL,
    title VARCHAR(200) NOT NULL,
    exam_type VARCHAR(100) NOT NULL DEFAULT 'Semester Practical Examination',
    exam_month VARCHAR(30) NOT NULL DEFAULT 'April',
    exam_year INT NOT NULL DEFAULT 2024,
    exam_date DATE NOT NULL,
    academic_year VARCHAR(30) NOT NULL DEFAULT '2023-2024',
    session VARCHAR(30) NOT NULL DEFAULT 'FN & AN',
    department VARCHAR(120) NOT NULL,
    programme VARCHAR(150) NOT NULL,
    semester VARCHAR(20) NOT NULL DEFAULT 'IV',
    study_year VARCHAR(20) NOT NULL DEFAULT 'II',
    regulation VARCHAR(40) NOT NULL DEFAULT 'L-Scheme',
    centre_no VARCHAR(20) NOT NULL DEFAULT '209',
    centre_name VARCHAR(150) NOT NULL DEFAULT 'PSG Polytechnic College',
    instructions TEXT NOT NULL,
    status ENUM('Draft', 'Generated', 'Finalized') NOT NULL DEFAULT 'Draft',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- Examination Subject Information (Subject Name and Code stored separately!)
CREATE TABLE IF NOT EXISTS exam_subjects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    subject_name VARCHAR(200) NOT NULL,
    subject_code VARCHAR(50) NOT NULL,
    subject_type VARCHAR(80) NOT NULL DEFAULT 'Practical',
    department VARCHAR(120) NOT NULL,
    programme VARCHAR(150) NOT NULL,
    semester VARCHAR(20) NOT NULL,
    regulation VARCHAR(40) NOT NULL DEFAULT 'L-Scheme',
    max_marks INT NOT NULL DEFAULT 75,
    duration VARCHAR(50) NOT NULL DEFAULT '3 hrs.',
    start_time VARCHAR(30) NOT NULL DEFAULT '09.00 am',
    end_time VARCHAR(30) NOT NULL DEFAULT '04.00 pm',
    lab_date DATE NOT NULL,
    remarks TEXT NULL,
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Examination Schedule
CREATE TABLE IF NOT EXISTS exam_schedules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    exam_date DATE NOT NULL,
    start_time VARCHAR(30) NOT NULL DEFAULT '09.00 am',
    end_time VARCHAR(30) NOT NULL DEFAULT '04.00 pm',
    duration VARCHAR(50) NOT NULL DEFAULT '3 hrs.',
    session VARCHAR(50) NOT NULL DEFAULT 'Full Day',
    room VARCHAR(100) NOT NULL DEFAULT 'Software Development Lab',
    reporting_time VARCHAR(30) NOT NULL DEFAULT '08.45 am',
    break_info VARCHAR(150) NOT NULL DEFAULT 'Lunch Break: 12.30 pm to 01.30 pm',
    special_instructions TEXT NULL,
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Examination Batches
CREATE TABLE IF NOT EXISTS exam_batches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    batch_code VARCHAR(60) NOT NULL,
    batch_name VARCHAR(120) NOT NULL,
    department VARCHAR(120) NOT NULL,
    programme VARCHAR(150) NOT NULL,
    academic_year VARCHAR(30) NOT NULL,
    semester VARCHAR(20) NOT NULL,
    study_year VARCHAR(20) NOT NULL,
    student_count INT NOT NULL DEFAULT 0,
    qp_set_id INT NULL,
    invigilator_name VARCHAR(120) NULL,
    room VARCHAR(100) NOT NULL DEFAULT 'Lab 1',
    exam_date DATE NOT NULL,
    start_time VARCHAR(30) NOT NULL DEFAULT '09.00 am',
    end_time VARCHAR(30) NOT NULL DEFAULT '12.00 pm',
    remarks TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_exam_batch (exam_id, batch_code),
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Batch Students (Individual Roll Numbers)
CREATE TABLE IF NOT EXISTS exam_students (
    id INT AUTO_INCREMENT PRIMARY KEY,
    batch_id INT NOT NULL,
    exam_id INT NOT NULL,
    seq INT NOT NULL,
    roll_no VARCHAR(60) NOT NULL,
    name VARCHAR(120) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_batch_roll (batch_id, roll_no),
    FOREIGN KEY (batch_id) REFERENCES exam_batches(id) ON DELETE CASCADE,
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Internal and External Examiners Assigned to Examination
CREATE TABLE IF NOT EXISTS exam_examiners (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    role_type ENUM('internal', 'external') NOT NULL,
    name VARCHAR(120) NOT NULL,
    designation VARCHAR(120) NOT NULL,
    department VARCHAR(120) NOT NULL,
    employee_id VARCHAR(60) NULL,
    institution VARCHAR(200) NOT NULL,
    address TEXT NULL,
    UNIQUE KEY uq_exam_role (exam_id, role_type),
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Invigilator Assignments
CREATE TABLE IF NOT EXISTS exam_invigilator_assignments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    batch_id INT NOT NULL,
    name VARCHAR(120) NOT NULL,
    employee_id VARCHAR(60) NULL,
    department VARCHAR(120) NOT NULL,
    room VARCHAR(100) NOT NULL,
    duty_date DATE NOT NULL,
    start_time VARCHAR(30) NOT NULL,
    end_time VARCHAR(30) NOT NULL,
    remarks TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE,
    FOREIGN KEY (batch_id) REFERENCES exam_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Practical Syllabus and Experiments
CREATE TABLE IF NOT EXISTS exam_syllabi (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NULL,
    owner_id INT NOT NULL,
    title VARCHAR(200) NOT NULL,
    subject_code VARCHAR(50) NOT NULL,
    subject_name VARCHAR(200) NOT NULL,
    department VARCHAR(120) NOT NULL,
    semester VARCHAR(20) NOT NULL,
    regulation VARCHAR(40) NOT NULL DEFAULT 'L-Scheme',
    version INT NOT NULL DEFAULT 1,
    status ENUM('active', 'archived') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- Experiments in Syllabus (1 to 10+)
CREATE TABLE IF NOT EXISTS exam_experiments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    syllabus_id INT NULL,
    exam_id INT NOT NULL,
    exp_no INT NOT NULL,
    title VARCHAR(300) NOT NULL DEFAULT '',
    description TEXT NULL,
    display_order INT NOT NULL DEFAULT 0,
    INDEX (exam_id, exp_no),
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Dynamic Sub-questions for Experiments (a, b, c, d...)
CREATE TABLE IF NOT EXISTS exam_experiment_subquestions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    experiment_id INT NOT NULL,
    letter VARCHAR(10) NOT NULL,
    text TEXT NOT NULL,
    display_order INT NOT NULL DEFAULT 0,
    FOREIGN KEY (experiment_id) REFERENCES exam_experiments(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Question Papers
CREATE TABLE IF NOT EXISTS exam_question_papers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    title VARCHAR(200) NOT NULL DEFAULT 'Question Paper',
    instructions TEXT NOT NULL,
    part_a_marks INT NOT NULL DEFAULT 35,
    part_b_marks INT NOT NULL DEFAULT 35,
    total_marks INT NOT NULL DEFAULT 70,
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Question Paper Items (Part A: 1-5, Part B: 6-10)
CREATE TABLE IF NOT EXISTS exam_qp_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    qp_id INT NOT NULL,
    part ENUM('A', 'B') NOT NULL,
    q_no INT NOT NULL,
    title VARCHAR(300) NOT NULL DEFAULT '',
    display_order INT NOT NULL DEFAULT 0,
    FOREIGN KEY (qp_id) REFERENCES exam_question_papers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Sub-questions for Question Paper Items (1(a), 1(b), 6(a), 6(b)...)
CREATE TABLE IF NOT EXISTS exam_qp_subquestions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_id INT NOT NULL,
    part ENUM('A', 'B') NOT NULL,
    q_no INT NOT NULL,
    letter VARCHAR(10) NOT NULL,
    text TEXT NOT NULL,
    marks INT NULL,
    display_order INT NOT NULL DEFAULT 0,
    FOREIGN KEY (item_id) REFERENCES exam_qp_items(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Question Paper Sets (e.g. Batch 1 Set, Batch 2 Set, Batch 3 Set)
CREATE TABLE IF NOT EXISTS exam_question_sets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    batch_id INT NULL,
    set_name VARCHAR(120) NOT NULL,
    set_code VARCHAR(40) NOT NULL,
    instructions TEXT NULL,
    content_json LONGTEXT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- Mark Schemes
CREATE TABLE IF NOT EXISTS exam_mark_schemes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    total_marks INT NOT NULL DEFAULT 75,
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Mark Scheme Components (Default 7 PSG components summing to 75)
CREATE TABLE IF NOT EXISTS exam_mark_components (
    id INT AUTO_INCREMENT PRIMARY KEY,
    scheme_id INT NOT NULL,
    seq INT NOT NULL,
    description VARCHAR(255) NOT NULL,
    max_marks INT NOT NULL,
    FOREIGN KEY (scheme_id) REFERENCES exam_mark_schemes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Sub-Question Allocation Generations
CREATE TABLE IF NOT EXISTS exam_allocation_generations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    batch_id INT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    mode ENUM('Balanced Random', 'Pure Random') NOT NULL DEFAULT 'Balanced Random',
    algorithm VARCHAR(100) NOT NULL DEFAULT 'pems-cartesian-bipartite-v1',
    no_reuse BOOLEAN NOT NULL DEFAULT 0,
    reason VARCHAR(500) NOT NULL DEFAULT '',
    student_count INT NOT NULL,
    part_a_count INT NOT NULL,
    part_b_count INT NOT NULL,
    capacity INT NOT NULL,
    used_count INT NOT NULL,
    duplicate_count INT NOT NULL DEFAULT 0,
    unassigned_count INT NOT NULL DEFAULT 0,
    validation_status ENUM('valid', 'capacity_exceeded', 'duplicate_detected', 'incomplete') NOT NULL DEFAULT 'valid',
    started_at DATETIME(6) NOT NULL,
    completed_at DATETIME(6) NOT NULL,
    finalized_at DATETIME NULL,
    created_by INT NOT NULL,
    UNIQUE KEY uq_batch_gen_version (batch_id, version),
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE,
    FOREIGN KEY (batch_id) REFERENCES exam_batches(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- Allocated Sub-questions per Student (Unique pair: 1 from Part A + 1 from Part B)
CREATE TABLE IF NOT EXISTS exam_allocated_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    generation_id INT NOT NULL,
    batch_id INT NOT NULL,
    seq INT NOT NULL,
    roll_no VARCHAR(60) NOT NULL,
    student_name VARCHAR(120) NOT NULL DEFAULT '',
    part_a_q INT NOT NULL,
    part_a_letter VARCHAR(10) NOT NULL,
    part_a_code VARCHAR(20) NOT NULL,
    part_a_text TEXT NOT NULL,
    part_b_q INT NOT NULL,
    part_b_letter VARCHAR(10) NOT NULL,
    part_b_code VARCHAR(20) NOT NULL,
    part_b_text TEXT NOT NULL,
    pair_key VARCHAR(50) NOT NULL,
    INDEX (generation_id, seq),
    INDEX (pair_key),
    FOREIGN KEY (generation_id) REFERENCES exam_allocation_generations(id) ON DELETE CASCADE,
    FOREIGN KEY (batch_id) REFERENCES exam_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Generated Documents & Export Records
CREATE TABLE IF NOT EXISTS exam_documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    batch_id INT NULL,
    generation_id INT NULL,
    document_type VARCHAR(60) NOT NULL,
    format VARCHAR(20) NOT NULL,
    version INT NOT NULL DEFAULT 1,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(255) NULL,
    file_size INT NULL,
    file_hash VARCHAR(64) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Prepared',
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES examinations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- Activity and Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    user_role VARCHAR(20) NOT NULL,
    action VARCHAR(80) NOT NULL,
    entity_type VARCHAR(60) NOT NULL,
    entity_id INT NULL,
    ip VARCHAR(45) NULL,
    detail TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (created_at),
    INDEX (user_id),
    INDEX (action),
    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- In-app Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    message TEXT NOT NULL,
    type ENUM('info', 'success', 'warning', 'error') NOT NULL DEFAULT 'info',
    is_read BOOLEAN NOT NULL DEFAULT 0,
    link VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================================
-- Legacy tables retained for backward compatibility with test harness
-- =====================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner INT NOT NULL,
    draft LONGTEXT NOT NULL,
    status ENUM('Draft','Generated','Finalized') NOT NULL DEFAULT 'Draft',
    created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    modified DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(owner) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    version INT NOT NULL,
    meta LONGTEXT NOT NULL,
    mode VARCHAR(24) NOT NULL,
    no_reuse BOOLEAN NOT NULL,
    algorithm VARCHAR(80) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    started DATETIME(6) NOT NULL,
    completed DATETIME(6) NOT NULL,
    finalized DATETIME NULL,
    UNIQUE(session_id,version),
    FOREIGN KEY(session_id) REFERENCES sessions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS students (
    version_id INT NOT NULL,
    seq INT NOT NULL,
    roll VARCHAR(60) NOT NULL,
    name VARCHAR(120) NOT NULL,
    PRIMARY KEY(version_id,roll),
    UNIQUE(version_id,seq),
    FOREIGN KEY(version_id) REFERENCES versions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS items (
    version_id INT NOT NULL,
    num INT NOT NULL,
    topic VARCHAR(500) NOT NULL,
    seq INT NOT NULL,
    PRIMARY KEY(version_id,num),
    FOREIGN KEY(version_id) REFERENCES versions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pairs (
    version_id INT NOT NULL,
    roll VARCHAR(60) NOT NULL,
    q1 INT NOT NULL,
    q2 INT NOT NULL,
    CHECK(q1<q2),
    PRIMARY KEY(version_id,roll),
    UNIQUE(version_id,q1,q2),
    FOREIGN KEY(version_id,roll) REFERENCES students(version_id,roll),
    FOREIGN KEY(version_id,q1) REFERENCES items(version_id,num),
    FOREIGN KEY(version_id,q2) REFERENCES items(version_id,num)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS library (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner INT NOT NULL,
    created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(owner) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS library_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    lib INT NOT NULL,
    version INT NOT NULL,
    meta LONGTEXT NOT NULL,
    created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(lib,version),
    FOREIGN KEY(lib) REFERENCES library(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS library_items (
    revision INT NOT NULL,
    seq INT NOT NULL,
    num INT NOT NULL,
    topic VARCHAR(500) NOT NULL,
    PRIMARY KEY(revision,num),
    FOREIGN KEY(revision) REFERENCES library_versions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    actor INT NOT NULL,
    session_id INT NULL,
    version_id INT NULL,
    action VARCHAR(50) NOT NULL,
    detail VARCHAR(500) NOT NULL,
    at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX(at),
    FOREIGN KEY(actor) REFERENCES users(id),
    FOREIGN KEY(session_id) REFERENCES sessions(id),
    FOREIGN KEY(version_id) REFERENCES versions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    actor INT NOT NULL,
    version_id INT NOT NULL,
    format VARCHAR(10) NOT NULL,
    status VARCHAR(16) NOT NULL,
    at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(actor) REFERENCES users(id),
    FOREIGN KEY(version_id) REFERENCES versions(id)
) ENGINE=InnoDB;
