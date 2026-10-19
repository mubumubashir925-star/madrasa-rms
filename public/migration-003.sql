-- Run ONCE on an existing database (lets you switch subjects on/off per class)
ALTER TABLE subjects ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
