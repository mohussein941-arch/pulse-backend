-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION M1 — Context Engine Core
-- Creates: interactions, interaction_embeddings, entity_links, ai_traces
-- Depends on: M0b complete (organizations, org_members, accounts.org_id NOT NULL)
-- pgvector 0.8.0 confirmed on staging and production
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Step 1: interactions ─────────────────────────────────────────────────────
-- Unified table for all signal sources feeding the Context Engine.
-- source values: call_transcript (Fireflies), email_thread (Gmail),
--   internal_note (manual/activity log), crm_event (CRM sync),
--   health_signal (NPS/CES/usage changes), whatsapp (Meta BSP)

CREATE TABLE IF NOT EXISTS interactions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid        NOT NULL REFERENCES organizations(id)  ON DELETE CASCADE,
  account_id   uuid                 REFERENCES accounts(id)       ON DELETE SET NULL,
  source       text        NOT NULL
    CHECK (source IN ('call_transcript','email_thread','internal_note','crm_event','health_signal','whatsapp')),
  direction    text
    CHECK (direction IN ('inbound','outbound','internal')),
  content      text,                  -- raw text: transcript body, email body, note text
  summary      text,                  -- AI-generated summary (populated async by embedding worker)
  sentiment    text
    CHECK (sentiment IN ('positive','neutral','negative')),
  language     text        NOT NULL DEFAULT 'en',   -- ISO 639-1 code, detected by worker
  occurred_at  timestamptz NOT NULL DEFAULT now(),   -- when the interaction actually happened
  created_by   uuid                 REFERENCES auth.users(id) ON DELETE SET NULL,
  external_id  text,                  -- source-system ID (Fireflies meeting ID, Gmail thread ID, etc.)
  metadata     jsonb,                 -- source-specific fields (subject, duration, participants, etc.)
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "interactions_org" ON interactions
  USING  (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

CREATE INDEX IF NOT EXISTS idx_interactions_org         ON interactions(org_id);
CREATE INDEX IF NOT EXISTS idx_interactions_account     ON interactions(account_id);
CREATE INDEX IF NOT EXISTS idx_interactions_org_time    ON interactions(org_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_interactions_source      ON interactions(org_id, source);
CREATE INDEX IF NOT EXISTS idx_interactions_external_id ON interactions(external_id)
  WHERE external_id IS NOT NULL;


-- ── Step 2: interaction_embeddings ───────────────────────────────────────────
-- One embedding row per interaction per model.
-- Populated asynchronously by the embedding worker after content is written.
-- IVFFlat index is commented out — create it once > 1000 rows exist.

CREATE TABLE IF NOT EXISTS interaction_embeddings (
  id             uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id uuid      NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  embedding      vector(1536),
  model          text      NOT NULL DEFAULT 'text-embedding-3-small',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interaction_id, model)
);

ALTER TABLE interaction_embeddings ENABLE ROW LEVEL SECURITY;

-- Access gated via the parent interaction's org membership
CREATE POLICY "interaction_embeddings_org" ON interaction_embeddings
  USING (
    EXISTS (
      SELECT 1 FROM interactions i
      WHERE i.id = interaction_id
        AND i.org_id = current_org_id()
    )
  );

CREATE INDEX IF NOT EXISTS idx_embeddings_interaction ON interaction_embeddings(interaction_id);

-- Enable once row count > 1 000 — set lists = ceil(sqrt(row_count)):
-- CREATE INDEX idx_embeddings_cosine ON interaction_embeddings
--   USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);


-- ── Step 3: entity_links ─────────────────────────────────────────────────────
-- Many-to-many: one interaction can reference multiple accounts, stakeholders,
-- tasks, or playbooks (and vice versa). Confidence is AI-assigned (0–1).

CREATE TABLE IF NOT EXISTS entity_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  entity_type    text NOT NULL
    CHECK (entity_type IN ('account','stakeholder','task','playbook')),
  entity_id      uuid NOT NULL,
  confidence     numeric(4,3) CHECK (confidence >= 0 AND confidence <= 1),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interaction_id, entity_type, entity_id)
);

ALTER TABLE entity_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "entity_links_org" ON entity_links
  USING (
    EXISTS (
      SELECT 1 FROM interactions i
      WHERE i.id = interaction_id
        AND i.org_id = current_org_id()
    )
  );

CREATE INDEX IF NOT EXISTS idx_entity_links_interaction ON entity_links(interaction_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_entity      ON entity_links(entity_type, entity_id);


-- ── Step 4: ai_traces ────────────────────────────────────────────────────────
-- Every AI inference call (Claude API) writes one row here.
-- Cost discipline from day one: no inference runs without a trace.
-- feature values map to endpoint names: briefing_summary, pre_meeting_brief,
--   context_retrieval, generate_embedding, post_meeting_closeout, etc.

CREATE TABLE IF NOT EXISTS ai_traces (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL REFERENCES organizations(id)  ON DELETE CASCADE,
  feature        text        NOT NULL,          -- which AI feature generated this call
  model          text        NOT NULL,          -- e.g. 'claude-sonnet-4-6', 'text-embedding-3-small'
  input_tokens   int,
  output_tokens  int,
  cost_usd       numeric(10,6),
  latency_ms     int,
  account_id     uuid                 REFERENCES accounts(id)      ON DELETE SET NULL,
  interaction_id uuid                 REFERENCES interactions(id)  ON DELETE SET NULL,
  created_by     uuid                 REFERENCES auth.users(id)    ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_traces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_traces_org" ON ai_traces
  USING  (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

CREATE INDEX IF NOT EXISTS idx_ai_traces_org      ON ai_traces(org_id);
CREATE INDEX IF NOT EXISTS idx_ai_traces_feature  ON ai_traces(org_id, feature);
CREATE INDEX IF NOT EXISTS idx_ai_traces_time     ON ai_traces(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_traces_account  ON ai_traces(account_id)
  WHERE account_id IS NOT NULL;
