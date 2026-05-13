-- security.sql
-- Run this in the Supabase SQL editor ONCE.
-- Adds: audit_log table, ai_config column on profiles.

-- ── Audit log ─────────────────────────────────────────────────────────────────
-- No user-facing RLS policies — only accessible via service role key.
-- This means no user can read, modify, or delete their own audit trail.

create table if not exists audit_log (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        references auth.users(id) on delete set null,
  action        text        not null,
  resource_type text,
  resource_id   text,
  ip_address    text,
  user_agent    text,
  metadata      jsonb,
  created_at    timestamptz not null default now()
);

alter table audit_log enable row level security;
-- No policies = no user access. Service role bypasses RLS.

create index if not exists audit_log_user_id_idx  on audit_log(user_id);
create index if not exists audit_log_action_idx   on audit_log(action);
create index if not exists audit_log_created_idx  on audit_log(created_at desc);

-- ── AI config on profiles ─────────────────────────────────────────────────────
-- Stores provider + encrypted API key + preferred model.
-- The backend always encrypts the api_key before writing; never returns it raw.

alter table profiles
  add column if not exists ai_config jsonb;

-- ── Verify RLS is enabled on all sensitive tables ─────────────────────────────
-- (These should already be on from the initial schema — confirm here.)
alter table profiles          enable row level security;
alter table accounts          enable row level security;
alter table tasks             enable row level security;
alter table briefing_items    enable row level security;
alter table email_accounts    enable row level security;
alter table activity_log      enable row level security;
alter table survey_responses  enable row level security;
alter table surveys           enable row level security;
