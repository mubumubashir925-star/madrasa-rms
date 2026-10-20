-- Multi-institution schema (fresh install). Existing single-institution databases upgrade automatically.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, admin_user TEXT NOT NULL, admin_salt TEXT NOT NULL, admin_hash TEXT NOT NULL, admin_ver INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', plan TEXT NOT NULL DEFAULT 'standard', paid_until TEXT NOT NULL DEFAULT '', max_students INTEGER NOT NULL DEFAULT 500, contact TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS settings (tenant_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (tenant_id, key));
CREATE TABLE IF NOT EXISTS exams (tenant_id INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id, id));
CREATE TABLE IF NOT EXISTS classes (tenant_id INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, working_days INTEGER NOT NULL DEFAULT 200, teacher_title TEXT NOT NULL DEFAULT '', teacher_name TEXT NOT NULL DEFAULT '', PRIMARY KEY (tenant_id, id));
CREATE TABLE IF NOT EXISTS subjects (tenant_id INTEGER NOT NULL, id TEXT NOT NULL, class_id TEXT NOT NULL, name TEXT NOT NULL, max_marks INTEGER NOT NULL, pass_marks INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id, id));
CREATE TABLE IF NOT EXISTS students (tenant_id INTEGER NOT NULL, id TEXT NOT NULL, admission_no TEXT NOT NULL, name TEXT NOT NULL, father_name TEXT NOT NULL DEFAULT '', class_id TEXT NOT NULL, extra TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, admission_no));
CREATE TABLE IF NOT EXISTS results (tenant_id INTEGER NOT NULL, exam_id TEXT NOT NULL, student_id TEXT NOT NULL, attendance_days INTEGER NOT NULL DEFAULT 0, marks TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (tenant_id, exam_id, student_id));
CREATE INDEX IF NOT EXISTS idx_subjects_class ON subjects(tenant_id, class_id);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(tenant_id, class_id);
CREATE INDEX IF NOT EXISTS idx_results_student ON results(tenant_id, student_id);
