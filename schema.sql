CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exams    (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS classes  (id TEXT PRIMARY KEY, name TEXT NOT NULL, working_days INTEGER NOT NULL DEFAULT 200);
CREATE TABLE IF NOT EXISTS subjects (id TEXT PRIMARY KEY, class_id TEXT NOT NULL, name TEXT NOT NULL, max_marks INTEGER NOT NULL, pass_marks INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, admission_no TEXT NOT NULL UNIQUE, name TEXT NOT NULL, father_name TEXT NOT NULL, class_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS results  (exam_id TEXT NOT NULL, student_id TEXT NOT NULL, attendance_days INTEGER NOT NULL DEFAULT 0, marks TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (exam_id, student_id));
CREATE INDEX IF NOT EXISTS idx_subjects_class ON subjects(class_id);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);

INSERT OR IGNORE INTO settings VALUES ('madrasa', '{"name":"Al-Noor Darul Uloom Madrasa","subtitle":"Islamic Education & Modern Sciences • Online Result Portal","logo":""}');
INSERT OR IGNORE INTO settings VALUES ('announcements', '["Welcome to the online result portal. Search using your Admission Number."]');
