-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION V2 — Run in Supabase SQL Editor (SQL Editor → New Query → Paste → Run)
-- Adds: health_history table, churn_events table,
--       expansion + escalation columns on accounts
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Health history ────────────────────────────────────────────────────────────
-- Mirrors the ces_history pattern: one row per daily snapshot per account.
-- Written by accounts.js whenever health_score changes on PATCH/POST.
create table if not exists health_history (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  account_id  uuid not null references accounts(id) on delete cascade,
  score       integer not null,
  recorded_at date not null default current_date
);

alter table health_history enable row level security;
create policy "health_own" on health_history
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists idx_health_user on health_history(user_id, account_id);

-- ── Churn events ──────────────────────────────────────────────────────────────
-- Logged when a CSM archives an account and records the churn reason.
-- account_id goes SET NULL on delete so historical records survive account cleanup.
create table if not exists churn_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  account_id   uuid references accounts(id) on delete set null,
  account_name text not null,
  arr          numeric default 0,
  reason       text not null,
  notes        text,
  churned_at   date not null default current_date,
  created_at   timestamptz default now()
);

alter table churn_events enable row level security;
create policy "churn_own" on churn_events
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists idx_churn_user on churn_events(user_id, churned_at desc);

-- ── Expansion columns on accounts ─────────────────────────────────────────────
alter table accounts add column if not exists expansion_potential boolean default false;
alter table accounts add column if not exists expansion_arr       numeric  default 0;
alter table accounts add column if not exists expansion_stage     text;
alter table accounts add column if not exists expansion_notes     text;

-- ── Escalation columns on accounts ───────────────────────────────────────────
-- escalation_status: null = not escalated | 'open' = active | 'resolved' = closed
alter table accounts add column if not exists escalation_status text;
alter table accounts add column if not exists escalation_reason text;
alter table accounts add column if not exists escalation_since  date;
alter table accounts add column if not exists escalation_notes  text;
