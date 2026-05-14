-- ============================================================
-- Workload Automation Migration
-- Adds: outreach_queue, survey_schedules, digest_schedules
-- Alters: activity_log (source, external_ref), tasks (source, account_name), surveys (source)
-- Run once in Supabase SQL Editor
-- ============================================================

-- ── 1. activity_log additions ─────────────────────────────────────────────────
-- source: who created this entry (manual | gmail_auto | fireflies_auto | automation | system)
-- external_ref: dedup key for auto-logged entries (e.g. 'gmail:threadId')
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS source       TEXT DEFAULT 'manual';
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS external_ref TEXT;

-- Unique index so gmail/fireflies can upsert without creating duplicates
CREATE UNIQUE INDEX IF NOT EXISTS activity_log_external_ref_idx
  ON activity_log (user_id, external_ref)
  WHERE external_ref IS NOT NULL;

-- ── 2. tasks additions ────────────────────────────────────────────────────────
-- source: manual | automation | playbook_signal | renewal_kit
-- account_name: denormalised for display without a join
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source       TEXT DEFAULT 'manual';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS account_name TEXT;

-- ── 3. surveys addition ───────────────────────────────────────────────────────
-- source: manual | schedule  (distinguishes auto-created surveys)
ALTER TABLE surveys ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

-- ── 4. outreach_queue ────────────────────────────────────────────────────────
-- Holds AI-ready draft outreach emails waiting for CSM review/approval/send.
-- trigger_type values: health_drop | no_contact | renewal_approaching |
--                      nps_drop | usage_drop | playbook_suggested | digest
-- status values:       pending | approved | sent | dismissed
CREATE TABLE IF NOT EXISTS outreach_queue (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id     UUID        REFERENCES accounts(id) ON DELETE SET NULL,
  account_name   TEXT        NOT NULL,
  trigger_type   TEXT        NOT NULL,
  subject        TEXT        NOT NULL,
  body_draft     TEXT        NOT NULL,
  recipient_email TEXT,
  recipient_name  TEXT,
  status         TEXT        NOT NULL DEFAULT 'pending',
  sent_at        TIMESTAMPTZ,
  ai_generated   BOOLEAN     DEFAULT FALSE,   -- set to TRUE once AI layer is wired
  metadata       JSONB       DEFAULT '{}'::jsonb,  -- AI context: health, nps, renewal_date, etc.
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE outreach_queue ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'outreach_queue' AND policyname = 'outreach_queue_own'
  ) THEN
    CREATE POLICY outreach_queue_own ON outreach_queue
      FOR ALL USING (user_id = auth.uid());
  END IF;
END $$;

-- ── 5. survey_schedules ───────────────────────────────────────────────────────
-- Rules that auto-create and send surveys on a schedule.
-- trigger_type values: onboarding_complete | recurring | renewal_approaching | health_recovery
CREATE TABLE IF NOT EXISTS survey_schedules (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  survey_type    TEXT    NOT NULL,   -- NPS | CES | CSAT
  trigger_type   TEXT    NOT NULL,
  trigger_config JSONB   DEFAULT '{}'::jsonb,  -- { days, recurrence_days, days_before, min_health }
  segment_config JSONB   DEFAULT '{}'::jsonb,  -- { plan, stage, arr_min }
  custom_question TEXT,
  enabled        BOOLEAN DEFAULT TRUE,
  last_run_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE survey_schedules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'survey_schedules' AND policyname = 'survey_schedules_own'
  ) THEN
    CREATE POLICY survey_schedules_own ON survey_schedules
      FOR ALL USING (user_id = auth.uid());
  END IF;
END $$;

-- ── 6. digest_schedules ───────────────────────────────────────────────────────
-- Per-account schedule for sending health digests to customer stakeholders.
-- auto_send=false  → adds to outreach_queue for CSM approval
-- auto_send=true   → sends directly via Resend
-- frequency: monthly | quarterly
CREATE TABLE IF NOT EXISTS digest_schedules (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id   UUID    REFERENCES accounts(id) ON DELETE CASCADE,
  frequency    TEXT    DEFAULT 'monthly',
  auto_send    BOOLEAN DEFAULT FALSE,
  enabled      BOOLEAN DEFAULT TRUE,
  last_sent_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE digest_schedules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'digest_schedules' AND policyname = 'digest_schedules_own'
  ) THEN
    CREATE POLICY digest_schedules_own ON digest_schedules
      FOR ALL USING (user_id = auth.uid());
  END IF;
END $$;
