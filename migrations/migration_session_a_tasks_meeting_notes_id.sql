-- Session A: add meeting_notes_id to tasks for per-meeting closeout state derivation
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS
  meeting_notes_id uuid REFERENCES meeting_notes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tasks_meeting_notes_id_idx
  ON tasks (meeting_notes_id) WHERE meeting_notes_id IS NOT NULL;
