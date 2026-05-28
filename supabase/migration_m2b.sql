-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION M2b — Pre-meeting brief cache + CSM profile
-- Depends on: M1 complete, M2a complete
-- Version: v4
--
-- Tables:
--   briefs       — cached brief output, keyed on
--                  (org_id, account_id, user_id, model_id, prompt_version_hash, data_state_hash)
--   csm_profile  — per-user CSM context injected into the brief prompt
--
-- Convention: updated_at on csm_profile is app-managed (no trigger). This matches
-- the M1 pattern for profile-style tables where the app controls update timing.
-- See README §Conventions for the rationale.
--
-- Cache lookup: application queries MUST include user_id in the WHERE clause when
-- hitting the briefs table — the schema change to UNIQUE is decoration without it.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── briefs ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS briefs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id          uuid        NOT NULL REFERENCES accounts(id)      ON DELETE CASCADE,
  user_id             uuid        NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
  model_id            text        NOT NULL,
  prompt_version_hash text        NOT NULL,
  data_state_hash     text        NOT NULL,
  content             jsonb       NOT NULL,
  expires_at          timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT briefs_cache_key
    UNIQUE (org_id, account_id, user_id, model_id, prompt_version_hash, data_state_hash)
);

-- DELETE intentionally omitted; RLS default-denies. Add explicit policy if delete becomes needed.

ALTER TABLE briefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "briefs_select" ON briefs
  FOR SELECT USING (
    org_id  = current_org_id()
    AND user_id = auth.uid()
  );

CREATE POLICY "briefs_insert" ON briefs
  FOR INSERT WITH CHECK (
    org_id  = current_org_id()
    AND user_id = auth.uid()
  );

-- idx_briefs_hash_lookup: no application queries currently filter on
-- (prompt_version_hash, data_state_hash) without org_id. Drop this index
-- once M2 ships if no batch prompt-invalidation admin query is wired up.
-- Add it back when a cross-org rollback sweep is needed.


-- ── csm_profile ───────────────────────────────────────────────────────────────
-- id is set to auth.uid() by the application on insert (one profile per user).
-- The RLS INSERT policy enforces this; no separate user_id column is needed.

CREATE TABLE IF NOT EXISTS csm_profile (
  id            uuid        PRIMARY KEY DEFAULT auth.uid(),
  org_id        uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  career_stage  text        NOT NULL DEFAULT 'mid'
                  CHECK (career_stage IN ('junior', 'mid', 'senior', 'lead')),
  specialty     text        NOT NULL DEFAULT 'general_csm'
                  CHECK (specialty IN ('general_csm', 'technical_csm', 'enterprise_csm', 'growth_csm')),
  working_style jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- DELETE intentionally omitted; RLS default-denies. Add explicit policy if delete becomes needed.

ALTER TABLE csm_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY "csm_profile_select" ON csm_profile
  FOR SELECT USING (
    id     = auth.uid()
    AND org_id = current_org_id()
  );

CREATE POLICY "csm_profile_insert" ON csm_profile
  FOR INSERT WITH CHECK (
    id     = auth.uid()
    AND org_id = current_org_id()
  );

CREATE POLICY "csm_profile_update" ON csm_profile
  FOR UPDATE
  USING  (id     = auth.uid() AND org_id = current_org_id())
  WITH CHECK (id = auth.uid() AND org_id = current_org_id());
