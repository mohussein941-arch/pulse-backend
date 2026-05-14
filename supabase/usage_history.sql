-- Run this in the Supabase SQL Editor

-- Track when product usage data was last received
alter table accounts
  add column if not exists product_usage_updated_at timestamptz;

-- Full usage history — every inbound webhook payload stored with timestamp
create table if not exists usage_history (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  account_id          uuid        not null references accounts(id) on delete cascade,
  -- Calculated score (0-100) derived from raw metrics below
  product_usage       numeric(5,2) not null,
  -- Raw metrics — store whatever the sender provides
  active_users        int,
  licensed_seats      int,
  dau                 int,
  mau                 int,
  features_used_count int,
  total_features      int,
  sessions_last_30d   int,
  -- Full original payload preserved for debugging / future reprocessing
  raw_payload         jsonb,
  recorded_at         timestamptz not null default now()
);

alter table usage_history enable row level security;

create policy "usage_history_own" on usage_history
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Fast lookups: trend chart (account + time), and per-user history
create index if not exists idx_usage_history_account_time
  on usage_history(account_id, recorded_at desc);

create index if not exists idx_usage_history_user_time
  on usage_history(user_id, recorded_at desc);
