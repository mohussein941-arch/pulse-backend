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

-- ─────────────────────────────────────────────────────────────────────────────
-- SURVEYS — added in Phase: Survey Management
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Surveys table ─────────────────────────────────────────────────────────────
create table if not exists surveys (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  account_id       uuid references accounts(id) on delete set null,
  account_name     text not null,
  type             text not null,        -- 'NPS' | 'CES' | 'CSAT'
  custom_question  text,
  token            text not null unique default encode(gen_random_bytes(16), 'hex'),
  status           text default 'active', -- 'active' | 'closed'
  deadline         date,
  created_at       timestamptz default now()
);

-- ── Survey responses ──────────────────────────────────────────────────────────
create table if not exists survey_responses (
  id                uuid primary key default gen_random_uuid(),
  survey_id         uuid not null references surveys(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  score             integer not null,
  custom_answer     text,
  respondent_name   text,
  respondent_email  text,
  submitted_at      timestamptz default now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table surveys          enable row level security;
alter table survey_responses enable row level security;

create policy "surveys_own"   on surveys          using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "responses_own" on survey_responses using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists idx_surveys_user      on surveys(user_id);
create index if not exists idx_surveys_token     on surveys(token);
create index if not exists idx_responses_survey  on survey_responses(survey_id);
create index if not exists idx_responses_user    on survey_responses(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- WHATSAPP — survey delivery via WhatsApp conversation
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists whatsapp_sessions (
  id          uuid primary key default gen_random_uuid(),
  survey_id   uuid not null references surveys(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  phone       text not null,
  state       text not null default 'awaiting_score', -- awaiting_score | awaiting_comment | completed
  score       integer,
  comment     text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table whatsapp_sessions enable row level security;
create policy "wa_sessions_own" on whatsapp_sessions using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists idx_wa_sessions_phone  on whatsapp_sessions(phone);
create index if not exists idx_wa_sessions_survey on whatsapp_sessions(survey_id);

create or replace trigger wa_sessions_updated_at
  before update on whatsapp_sessions
  for each row execute function update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- AUTOMATION — rules-based background task engine
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists automation_rules (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  trigger_type   text not null,   -- health_below | no_contact_days | renewal_days | nps_below | ces_below | usage_below
  trigger_config jsonb not null default '{}',  -- e.g. { "threshold": 40 } or { "days": 14 }
  action_type    text not null,   -- log_activity | create_task
  action_config  jsonb not null default '{}',  -- e.g. { "note": "Follow up needed" } or { "title": "Check in with account" }
  enabled        boolean default true,
  created_at     timestamptz default now()
);

create table if not exists automation_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  rule_id      uuid not null references automation_rules(id) on delete cascade,
  account_id   uuid not null references accounts(id) on delete cascade,
  account_name text,
  rule_name    text,
  action_type  text not null,
  detail       text,
  fired_at     timestamptz default now()
);

alter table automation_rules enable row level security;
alter table automation_log   enable row level security;

create policy "auto_rules_own" on automation_rules using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "auto_log_own"   on automation_log   using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists idx_auto_rules_user on automation_rules(user_id);
create index if not exists idx_auto_log_user   on automation_log(user_id, fired_at desc);
create index if not exists idx_auto_log_dedup  on automation_log(rule_id, account_id, fired_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- ONBOARDING — optional structured onboarding plans per account
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists onboarding_plans (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  account_id     uuid not null references accounts(id) on delete cascade,
  status         text default 'active',          -- active | closed
  current_phase  text default 'handover',        -- handover | kickoff | configuration | training | go_live | value_realized
  phases         jsonb not null default '{}',    -- per-phase { expected, actual, skipped }
  handover_data  jsonb not null default '{}',    -- { what_sold, why_bought, success_definition, promises, red_flags, contacts }
  go_live_target date,
  go_live_actual date,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- Only one active plan per account per user
create unique index if not exists idx_onboarding_plans_active
  on onboarding_plans(user_id, account_id) where status = 'active';

create table if not exists onboarding_tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  account_id  uuid not null references accounts(id) on delete cascade,
  plan_id     uuid not null references onboarding_plans(id) on delete cascade,
  title       text not null,
  description text,
  owner       text not null default 'csm',         -- csm | customer
  status      text not null default 'not_started', -- not_started | in_progress | done | blocked
  due_date    date,
  sort_order  integer default 0,
  note        text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists account_needs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  account_id  uuid not null references accounts(id) on delete cascade,
  category    text not null default 'business',  -- technical | business | integration | training
  description text not null,
  priority    text default 'medium',             -- high | medium | low
  status      text default 'identified',         -- identified | in_progress | resolved
  created_at  timestamptz default now()
);

alter table onboarding_plans enable row level security;
alter table onboarding_tasks  enable row level security;
alter table account_needs     enable row level security;

create policy "ob_plans_own" on onboarding_plans using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "ob_tasks_own" on onboarding_tasks  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "needs_own"    on account_needs     using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists idx_ob_plans_user    on onboarding_plans(user_id);
create index if not exists idx_ob_plans_account on onboarding_plans(account_id);
create index if not exists idx_ob_tasks_plan    on onboarding_tasks(plan_id);
create index if not exists idx_ob_tasks_account on onboarding_tasks(account_id);
create index if not exists idx_needs_account    on account_needs(account_id);

create or replace trigger ob_plans_updated_at
  before update on onboarding_plans
  for each row execute function update_updated_at();

create or replace trigger ob_tasks_updated_at
  before update on onboarding_tasks
  for each row execute function update_updated_at();
