-- M3c: broaden tasks.priority CHECK to include 'Low'
--
-- The existing constraint only allowed ('Critical', 'High', 'Medium'), which
-- means low-priority task creation has never succeeded — both via routes/tasks.js
-- (where validate.js's zod enum accepts 'Low' but the DB rejects it with a
-- check_violation) and via the m3c accept-tasks handler (which capitalizes
-- 'low' → 'Low' to mirror the existing case convention).
--
-- This migration brings the DB into alignment with the rest of the codebase.
-- No existing rows are affected — the constraint is broadened, not narrowed.

ALTER TABLE tasks DROP CONSTRAINT tasks_priority_check;

ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check
  CHECK (priority = ANY (ARRAY['Critical'::text, 'High'::text, 'Medium'::text, 'Low'::text]));
