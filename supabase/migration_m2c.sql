-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION M2c — Add updated_at to interactions and stakeholders
-- Depends on: M1 complete (interactions table), M0b complete (stakeholders.org_id)
--
-- Why this migration exists:
--   The pre-meeting brief cache (M2b) uses dataStateHash to detect when context
--   changes so it can regenerate a stale brief. The hash includes
--   interactions[].updated_at and stakeholders[].updated_at. Without these
--   columns any UPDATE to an interaction or stakeholder row is invisible to the
--   hash, meaning the cache would serve stale briefs after data is corrected.
--
-- interactions: the column was missing from the original M1 CREATE TABLE.
--   Currently no application code path UPDATEs interaction rows after insert,
--   but the interactions.summary column is reserved for async population by the
--   embedding worker, and future routes may correct content. Adding the trigger
--   now prevents a silent cache correctness bug when that write path is wired in.
--
-- stakeholders: the column was missing from the original schema.sql CREATE TABLE.
--   The current accounts.js deletes and re-inserts all stakeholders on every
--   change, so ID churn already busts the hash. Adding updated_at + trigger
--   future-proofs individual-row UPDATE paths and removes the dependency on the
--   delete-reinsert pattern for cache correctness.
--
-- The update_updated_at() trigger function is defined in schema.sql and is
-- already present in the database — this migration only adds columns and wires
-- triggers.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── interactions ──────────────────────────────────────────────────────────────

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill: set existing rows to their creation time rather than migration time
UPDATE interactions
  SET updated_at = created_at
  WHERE updated_at > created_at;   -- true for all rows just assigned DEFAULT now()

CREATE OR REPLACE TRIGGER interactions_updated_at
  BEFORE UPDATE ON interactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── stakeholders ──────────────────────────────────────────────────────────────

ALTER TABLE stakeholders
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill: use created_at where available; fall back to now() if null
UPDATE stakeholders
  SET updated_at = COALESCE(created_at, now())
  WHERE updated_at > COALESCE(created_at, now()) -- true for all rows just assigned DEFAULT now()
     OR updated_at IS NULL;

CREATE OR REPLACE TRIGGER stakeholders_updated_at
  BEFORE UPDATE ON stakeholders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
