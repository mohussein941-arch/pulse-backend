-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION M2a — Ingestion plumbing
-- Depends on: M1 complete (interactions table with source CHECK constraint)
--
-- Changes:
--   1. Add 'calendar_event' to interactions.source allowed values
--   2. Add unique partial index on (org_id, external_id) for dedup across re-syncs
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Step 1: extend interactions.source CHECK constraint ──────────────────────
-- The inline CHECK from M1 was auto-named 'interactions_source_check' by Postgres.
-- We drop and re-add to include 'calendar_event'.

ALTER TABLE interactions
  DROP CONSTRAINT IF EXISTS interactions_source_check;

ALTER TABLE interactions
  ADD CONSTRAINT interactions_source_check
  CHECK (source IN (
    'call_transcript',
    'email_thread',
    'internal_note',
    'crm_event',
    'health_signal',
    'whatsapp',
    'calendar_event'
  ));


-- ── Step 2: deduplication index for re-sync idempotency ──────────────────────
-- Prevents duplicate interactions when Gmail / Fireflies / Calendar sync runs
-- multiple times against the same source records.
-- NULLs are excluded (manual interactions have no external_id; multiple NULLs
-- are allowed — Postgres treats each NULL as distinct in unique indexes anyway,
-- but the partial WHERE makes the intent explicit).

CREATE UNIQUE INDEX IF NOT EXISTS idx_interactions_org_external
  ON interactions(org_id, external_id)
  WHERE external_id IS NOT NULL;
