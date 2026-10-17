-- Run ONCE on an existing database (adds custom student fields)
ALTER TABLE students ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';
