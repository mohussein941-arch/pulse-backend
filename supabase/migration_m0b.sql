-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION M0b — Organizations layer
-- Run AFTER migration_v2.sql
-- Phase 1 (additive — run before backend deploy): Steps 1–7
-- Phase 2 (rename — run after backend is confirmed healthy): Step 8
--
-- IMPORTANT: Verify table names before running.
-- The application code uses 'automation_rules' and 'automation_log'.
-- Steps 3, 4, 5, 7, and 8 reference 'automation_rules' — update to 'automation_rules'
-- if that is the actual Supabase table name (run the query below to verify):
--   SELECT tablename FROM pg_tables
--   WHERE schemaname = 'public' AND tablename LIKE 'automat%';
--
-- Tier B tables (17): accounts, ces_history, health_history, activity_log,
--   milestones, stakeholders, playbooks, tasks, surveys, survey_responses,
--   onboarding_plans, onboarding_tasks, usage_history, churn_events,
--   integrations, automation_rules, automation_log
-- ─────────────────────────────────────────────────────────────────────────────

-- ══ PHASE 1 ══════════════════════════════════════════════════════════════════

-- ── Step 1: Create org tables ─────────────────────────────────────────────────

create table if not exists organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text unique,          -- auto-generation deferred; not populated by signup in M0b
  plan       text not null default 'starter',
  domain     text,                 -- reserved for future domain-matching; not used in M0b
  created_at timestamptz default now()
);

create table if not exists org_members (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references organizations(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'csm',
  joined_at timestamptz default now(),
  unique(org_id, user_id)
);

alter table org_members enable row level security;
create policy "org_members_own" on org_members
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Step 2: Helper function ───────────────────────────────────────────────────

create or replace function current_org_id()
returns uuid
language sql stable security definer
as $$
  select org_id from org_members where user_id = auth.uid() limit 1;
$$;

-- ── Step 3: Add org_id FK to all 17 Tier B tables ────────────────────────────
-- Nullable initially — Step 5 sets NOT NULL after backfill.
-- NOTE: Table name confirmed as 'automation_rules'.

alter table accounts         add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table ces_history      add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table health_history   add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table activity_log     add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table milestones       add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table stakeholders     add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table playbooks        add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table tasks            add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table surveys          add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table survey_responses add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table onboarding_plans add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table onboarding_tasks add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table usage_history    add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table churn_events     add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table integrations     add column if not exists org_id uuid references organizations(id) on delete cascade;
-- Table name confirmed: automation_rules
alter table automation_rules add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table automation_log   add column if not exists org_id uuid references organizations(id) on delete cascade;

-- profiles gets org_id as lookup convenience only (nullable)
alter table profiles add column if not exists org_id uuid references organizations(id) on delete set null;

-- ── Step 4: Data migration — one org per existing user ───────────────────────
-- Each existing user becomes the 'owner' of a personal org.
-- Org name: profiles.company if set, otherwise the email prefix.
-- Safe to re-run: the where clause skips users already in org_members.
-- NOTE: Replace 'automation_rules' with actual table name if different.

do $$
declare
  r          record;
  new_org_id uuid;
begin
  for r in
    select au.id as user_id,
           coalesce(nullif(trim(p.company), ''), split_part(au.email, '@', 1)) as org_name
    from auth.users au
    left join profiles p on p.id = au.id
    where au.id not in (select user_id from org_members)
  loop
    insert into organizations (name)
    values (r.org_name)
    returning id into new_org_id;

    insert into org_members (org_id, user_id, role)
    values (new_org_id, r.user_id, 'owner');

    update profiles set org_id = new_org_id where id = r.user_id;

    update accounts         set org_id = new_org_id where user_id = r.user_id;
    update ces_history      set org_id = new_org_id where user_id = r.user_id;
    update health_history   set org_id = new_org_id where user_id = r.user_id;
    update activity_log     set org_id = new_org_id where user_id = r.user_id;
    update milestones       set org_id = new_org_id where user_id = r.user_id;
    update stakeholders     set org_id = new_org_id where user_id = r.user_id;
    update playbooks        set org_id = new_org_id where user_id = r.user_id;
    update tasks            set org_id = new_org_id where user_id = r.user_id;
    update surveys          set org_id = new_org_id where user_id = r.user_id;
    update survey_responses set org_id = new_org_id where user_id = r.user_id;
    update onboarding_plans set org_id = new_org_id where user_id = r.user_id;
    update onboarding_tasks set org_id = new_org_id where user_id = r.user_id;
    update usage_history    set org_id = new_org_id where user_id = r.user_id;
    update churn_events     set org_id = new_org_id where user_id = r.user_id;
    update integrations     set org_id = new_org_id where user_id = r.user_id;
    -- VERIFY TABLE NAME:
    update automation_rules set org_id = new_org_id where user_id = r.user_id;
    update automation_log   set org_id = new_org_id where user_id = r.user_id;
  end loop;
end;
$$;

-- ── Step 5: Set org_id NOT NULL on all 17 Tier B tables ──────────────────────
-- Applied uniformly. Safe because Step 4 backfilled every row.
-- NOTE: Replace 'automation_rules' with actual table name if different.

alter table accounts         alter column org_id set not null;
alter table ces_history      alter column org_id set not null;
alter table health_history   alter column org_id set not null;
alter table activity_log     alter column org_id set not null;
alter table milestones       alter column org_id set not null;
alter table stakeholders     alter column org_id set not null;
alter table playbooks        alter column org_id set not null;
alter table tasks            alter column org_id set not null;
alter table surveys          alter column org_id set not null;
alter table survey_responses alter column org_id set not null;
alter table onboarding_plans alter column org_id set not null;
alter table onboarding_tasks alter column org_id set not null;
alter table usage_history    alter column org_id set not null;
alter table churn_events     alter column org_id set not null;
alter table integrations     alter column org_id set not null;
-- VERIFY TABLE NAME:
alter table automation_rules alter column org_id set not null;
alter table automation_log   alter column org_id set not null;

-- ── Step 6: Update integrations unique constraint ────────────────────────────
-- Decision (Q1): Option A — unique(org_id, connector_id).
-- One CRM connection per org. Admin connects once; all members use shared credentials.
-- Replace the constraint name below with the actual name from pg_constraint
-- (run Part A2 query first: select conname from pg_constraint
--  where conrelid = 'public.integrations'::regclass and contype = 'u')

alter table integrations
  drop constraint if exists integrations_user_id_connector_id_key;

alter table integrations
  add constraint integrations_org_id_connector_id_key
  unique (org_id, connector_id);

-- ── Step 7: Update RLS policies on all 17 Tier B tables ──────────────────────
-- Run Part A3 query first to check which tables need RLS enabled:
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename in ('survey_responses', 'onboarding_tasks');
-- For any table where rowsecurity = false, add:
--   alter table <table_name> enable row level security;
-- before the corresponding create policy statement.

drop policy if exists "accounts_own"       on accounts;
drop policy if exists "ces_own"            on ces_history;
drop policy if exists "health_own"         on health_history;
drop policy if exists "activity_own"       on activity_log;
drop policy if exists "milestones_own"     on milestones;
drop policy if exists "stakeholders_own"   on stakeholders;
drop policy if exists "playbooks_own"      on playbooks;
drop policy if exists "tasks_own"          on tasks;
drop policy if exists "surveys_own"        on surveys;
drop policy if exists "onboarding_own"     on onboarding_plans;
drop policy if exists "integrations_own"   on integrations;
drop policy if exists "churn_own"          on churn_events;
drop policy if exists "automation_rules_own"    on automation_rules;
drop policy if exists "automation_log_own" on automation_log;

create policy "accounts_org"       on accounts         using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "ces_org"            on ces_history       using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "health_org"         on health_history    using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "activity_org"       on activity_log      using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "milestones_org"     on milestones        using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "stakeholders_org"   on stakeholders      using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "playbooks_org"      on playbooks         using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "tasks_org"          on tasks             using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "surveys_org"        on surveys           using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "onboarding_org"     on onboarding_plans  using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "integrations_org"   on integrations      using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "churn_org"          on churn_events      using (org_id = current_org_id()) with check (org_id = current_org_id());
-- VERIFY TABLE NAME for automation policies:
create policy "automation_rules_org"    on automation_rules  using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy "automation_log_org" on automation_log    using (org_id = current_org_id()) with check (org_id = current_org_id());

-- survey_responses: add RLS enable if rowsecurity = false (verify in Part A3)
-- alter table survey_responses enable row level security;  -- uncomment if needed
drop policy if exists "survey_responses_own" on survey_responses;
create policy "survey_responses_org" on survey_responses
  using (org_id = current_org_id()) with check (org_id = current_org_id());

-- onboarding_tasks: add RLS enable if rowsecurity = false (verify in Part A3)
-- alter table onboarding_tasks enable row level security;  -- uncomment if needed
drop policy if exists "onboarding_tasks_own" on onboarding_tasks;
create policy "onboarding_tasks_org" on onboarding_tasks
  using (org_id = current_org_id()) with check (org_id = current_org_id());

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists idx_org_members_user   on org_members(user_id);
create index if not exists idx_accounts_org       on accounts(org_id);
create index if not exists idx_tasks_org          on tasks(org_id);
create index if not exists idx_integrations_org   on integrations(org_id);
create index if not exists idx_churn_org          on churn_events(org_id, churned_at desc);
-- VERIFY TABLE NAME:
create index if not exists idx_automation_rules_org    on automation_rules(org_id);
create index if not exists idx_automation_log_org on automation_log(org_id);


-- ══ PHASE 2 — run AFTER new backend is confirmed healthy ══════════════════════

-- ── Step 8: Rename user_id → created_by on all 17 Tier B tables ──────────────
-- The FK to auth.users(id) survives the rename — Postgres preserves constraints.
-- Alert emails and task assignments continue to use this column as the recipient.
-- VERIFY TABLE NAME for automation_rules before running.
-- IMPORTANT: Deploy the new backend BEFORE running this step. The backend code
-- uses 'created_by' in all Tier B INSERTs — this step makes those INSERTs valid.

alter table accounts         rename column user_id to created_by;
alter table ces_history      rename column user_id to created_by;
alter table health_history   rename column user_id to created_by;
alter table activity_log     rename column user_id to created_by;
alter table milestones       rename column user_id to created_by;
alter table stakeholders     rename column user_id to created_by;
alter table playbooks        rename column user_id to created_by;
alter table tasks            rename column user_id to created_by;
alter table surveys          rename column user_id to created_by;
alter table survey_responses rename column user_id to created_by;
alter table onboarding_plans rename column user_id to created_by;
alter table onboarding_tasks rename column user_id to created_by;
alter table usage_history    rename column user_id to created_by;
alter table churn_events     rename column user_id to created_by;
alter table integrations     rename column user_id to created_by;
-- Table name confirmed: automation_rules
alter table automation_rules rename column user_id to created_by;
alter table automation_log   rename column user_id to created_by;
