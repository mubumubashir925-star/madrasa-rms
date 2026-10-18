-- Run ONCE on an existing database (class teacher details). Run each line separately if the console complains.
ALTER TABLE classes ADD COLUMN teacher_title TEXT NOT NULL DEFAULT '';
ALTER TABLE classes ADD COLUMN teacher_name TEXT NOT NULL DEFAULT '';
