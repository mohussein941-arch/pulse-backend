-- usage_events.sql
-- Run once in Supabase SQL Editor (or via the pg migration runner).
-- Adds usage_events (raw product-activity "receipts") and extends usage_history
-- with the derived fields the daily event tally computes.

-- ── Raw product-usage events ("receipts") ────────────────────────────────────
create table if not exists usage_events (
  id          uuid        primary key default gen_random_uuid(),
  org_id      uuid        not null references organizations(id) on delete cascade,
  user_id     uuid        not null references auth.users(id)    on delete cascade,
  account_id  uuid        not null references accounts(id)       on delete cascade,
  user_ref    text,                       -- end-user id from the customer's product (for distinct-user counts)
  event_name  text        not null,       -- the action / feature used
  occurred_at timestamptz not null,       -- when it happened (sender's timestamp)
  properties  jsonb,                      -- arbitrary event properties
  session_id  text,                       -- optional; only used for the sessions metric when present
  event_id    text,                       -- optional sender-provided id, for dedup
  received_at timestamptz not null default now()
);

alter table usage_events enable row level security;

create policy "usage_events_org" on usage_events
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- Tally window scan: per account, by time
create index if not exists idx_usage_events_account_time
  on usage_events(account_id, occurred_at desc);

-- Dedup: a sender-provided event_id is unique within an org (when present)
create unique index if not exists idx_usage_events_dedup
  on usage_events(org_id, event_id) where event_id is not null;

-- ── Extend usage_history with the new derived snapshot fields ─────────────────
alter table usage_history add column if not exists wau            int;
alter table usage_history add column if not exists last_active_at timestamptz;
alter table usage_history add column if not exists events_count   int;
alter table usage_history add column if not exists key_events     jsonb;
