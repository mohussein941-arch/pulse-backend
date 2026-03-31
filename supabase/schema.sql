-- ─── Pulse Multi-Tenant Schema ───────────────────────────────────────────────
-- Run this in your Supabase SQL editor (SQL Editor → New Query → Paste → Run)
-- This replaces the previous schema entirely.
--
-- Every table has a user_id column that ties data to a specific CSM.
-- Row Level Security (RLS) ensures users can ONLY ever read and write
-- their own data — enforced at the database level, not just in code.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "uuid-ossp";

-- ── User profiles ─────────────────────────────────────────────────────────────
create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  full_name     text,
  company       text,
  role          text default 'csm',
  avatar_url    text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ── Accounts ──────────────────────────────────────────────────────────────────
create table if not exists accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  external_id   text,
  source        text default 'manual',
  name          text not null,
  industry      text,
  plan          text default 'Starter',
  arr           numeric default 0,
  renewal_date  date,
  nps           integer default 50,
  ces           numeric(3,1) default 3.5,
  product_usage integer default 60,
  open_tickets  integer default 0,
  health_score  integer,
  churn_risk    integer,
  stage         text default 'Stable',
  last_contact  date,
  next_action   text,
  notes         text,
  prep_notes    text,
  success_goal  text,
  archived      boolean default false,
  active_playbook_id    text,
  active_playbook_steps jsonb default '{}',
  snoozed_playbooks     jsonb default '[]',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ── CES history ───────────────────────────────────────────────────────────────
create table if not exists ces_history (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  account_id  uuid not null references accounts(id) on delete cascade,
  value       numeric(3,1) not null,
  recorded_at date not null default current_date
);

-- ── Stakeholders ──────────────────────────────────────────────────────────────
create table if not exists stakeholders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  account_id  uuid not null references accounts(id) on delete cascade,
  name        text not null,
  title       text,
  role        text default 'Neutral',
  sentiment   text default 'Neutral',
  last_touch  date,
  created_at  timestamptz default now()
);

-- ── Activity log ──────────────────────────────────────────────────────────────
create table if not exists activity_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  account_id  uuid not null references accounts(id) on delete cascade,
  type        text not null,
  note        text,
  logged_at   date not null default current_date,
  created_at  timestamptz default now()
);

-- ── Success plan milestones ───────────────────────────────────────────────────
create table if not exists milestones (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  account_id  uuid not null references accounts(id) on delete cascade,
  text        text not null,
  done        boolean default false,
  sort_order  integer default 0,
  created_at  timestamptz default now()
);

-- ── Integrations ──────────────────────────────────────────────────────────────
create table if not exists integrations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  connector_id  text not null,
  connected     boolean default false,
  credentials   jsonb default '{}',
  field_map     jsonb default '{}',
  oauth_token   text,
  oauth_refresh text,
  oauth_expiry  timestamptz,
  last_sync     timestamptz,
  sync_count    integer default 0,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique(user_id, connector_id)
);

-- ── Sync log ──────────────────────────────────────────────────────────────────
create table if not exists sync_log (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  connector_id     text not null,
  status           text not null,
  records_created  integer default 0,
  records_updated  integer default 0,
  records_skipped  integer default 0,
  error_message    text,
  started_at       timestamptz default now(),
  finished_at      timestamptz
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY — multi-tenancy enforcement at the database layer
-- ─────────────────────────────────────────────────────────────────────────────
alter table profiles     enable row level security;
alter table accounts     enable row level security;
alter table ces_history  enable row level security;
alter table stakeholders enable row level security;
alter table activity_log enable row level security;
alter table milestones   enable row level security;
alter table integrations enable row level security;
alter table sync_log     enable row level security;

create policy "profiles_own"     on profiles     using (auth.uid() = id)      with check (auth.uid() = id);
create policy "accounts_own"     on accounts     using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "ces_own"          on ces_history  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "stakeholders_own" on stakeholders using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "activity_own"     on activity_log using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "milestones_own"   on milestones   using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "integrations_own" on integrations using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "sync_log_own"     on sync_log     using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- AUTO-CREATE PROFILE ON SIGNUP
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────────
-- AUTO-UPDATE updated_at
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create or replace trigger accounts_updated_at     before update on accounts     for each row execute function update_updated_at();
create or replace trigger integrations_updated_at before update on integrations for each row execute function update_updated_at();
create or replace trigger profiles_updated_at     before update on profiles     for each row execute function update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES — user_id first on every index for fast per-tenant queries
-- ─────────────────────────────────────────────────────────────────────────────
create index if not exists idx_accounts_user       on accounts(user_id);
create index if not exists idx_accounts_stage      on accounts(user_id, stage);
create index if not exists idx_accounts_renewal    on accounts(user_id, renewal_date);
create index if not exists idx_accounts_external   on accounts(user_id, external_id);
create index if not exists idx_ces_user            on ces_history(user_id, account_id);
create index if not exists idx_activity_user       on activity_log(user_id, account_id);
create index if not exists idx_milestones_user     on milestones(user_id, account_id);
create index if not exists idx_stakeholders_user   on stakeholders(user_id, account_id);
create index if not exists idx_integrations_user   on integrations(user_id, connector_id);
create index if not exists idx_sync_log_user       on sync_log(user_id, connector_id);
