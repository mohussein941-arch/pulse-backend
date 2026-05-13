-- ─── Daily Briefing Schema ────────────────────────────────────────────────────
-- Run in Supabase SQL Editor → New Query → Paste → Run

-- ── 1. Briefing config on profiles ───────────────────────────────────────────
alter table profiles
  add column if not exists briefing_config jsonb not null default '{
    "enabled": false,
    "days": [0,1,2,3,4],
    "hour": 7,
    "timezone": "Asia/Dubai",
    "email_enabled": false
  }';

-- ── 2. Tasks table (migrates manual tasks out of localStorage) ────────────────
create table if not exists tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  account_id  uuid references accounts(id) on delete cascade,
  title       text not null,
  description text,
  priority    text not null default 'High' check (priority in ('Critical','High','Medium')),
  due_date    date,
  done        boolean not null default false,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table tasks enable row level security;
drop policy if exists "tasks_own" on tasks;
create policy "tasks_own" on tasks
  for all using (user_id = auth.uid());

create index if not exists tasks_user_id    on tasks(user_id);
create index if not exists tasks_account_id on tasks(account_id);
create index if not exists tasks_due_date   on tasks(user_id, due_date) where done = false;

-- ── 3. Briefing items table ───────────────────────────────────────────────────
create table if not exists briefing_items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  account_id     uuid references accounts(id) on delete cascade,
  briefing_date  date not null,
  category       text not null default 'action' check (category in ('action','win','task')),
  signal_type    text not null,
  signal_detail  text not null,
  base_score     numeric not null default 0,
  carry_days     int not null default 0,
  current_score  numeric not null default 0,
  status         text not null default 'pending'
                   check (status in ('pending','done','snoozed','dismissed')),
  snoozed_until  date,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

alter table briefing_items enable row level security;
drop policy if exists "briefing_items_own" on briefing_items;
create policy "briefing_items_own" on briefing_items
  for all using (user_id = auth.uid());

create index if not exists briefing_items_user_date on briefing_items(user_id, briefing_date desc);
create index if not exists briefing_items_pending   on briefing_items(user_id, status) where status = 'pending';
