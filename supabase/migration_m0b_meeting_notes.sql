-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION M0b extension — meeting_notes and email_threads org-scope
-- Run AFTER migration_m0b.sql
--
-- Fixes the multi-tenancy gap for two tables that were created after the
-- original 16 Tier B tables were migrated:
--   meeting_notes   (created by meeting_notes.sql)
--   email_threads   (created by gmail_ingestion.sql)
--
-- Pattern is identical to M0b Phase 1:
--   additive first (nullable FK, backfill, NOT NULL), then update constraints,
--   then update RLS policies, then update indexes.
--
-- Other tables audited and found to have the same user_id-only gap:
--   briefing_items, outreach_queue, survey_schedules, digest_schedules
--   These are listed at the bottom of this file as DEFERRED items.
--   They do not feed M1 directly, so they are not migrated here.
--   Each one must be migrated before any feature uses them cross-org.
-- ─────────────────────────────────────────────────────────────────────────────

-- ══ PART 1 — meeting_notes ════════════════════════════════════════════════════

-- Step 1: Add nullable org_id FK
alter table meeting_notes
  add column if not exists org_id uuid references organizations(id) on delete cascade;

-- Step 2: Backfill org_id from user_id via org_members
update meeting_notes m
set org_id = om.org_id
from org_members om
where om.user_id = m.user_id
  and m.org_id is null;

-- Step 3: Set NOT NULL
alter table meeting_notes alter column org_id set not null;

-- Step 4: Replace unique constraint scoped by user_id with one scoped by org_id
--   Old: unique(user_id, fireflies_id)
--   New: unique(org_id, fireflies_id)
--   The upsert in firefliesIngestion.js will be updated to use this conflict key.
alter table meeting_notes
  drop constraint if exists meeting_notes_user_id_fireflies_id_key;

alter table meeting_notes
  add constraint meeting_notes_org_id_fireflies_id_key
  unique (org_id, fireflies_id);

-- Step 5: Update RLS policy to scope by org instead of user
drop policy if exists "meeting_notes_own" on meeting_notes;

create policy "meeting_notes_org" on meeting_notes
  using  (org_id = current_org_id())
  with check (org_id = current_org_id());

-- Step 6: Indexes
create index if not exists idx_meeting_notes_org
  on meeting_notes(org_id, meeting_date desc);

-- (keep existing idx_meeting_notes_account and idx_meeting_notes_user_date as-is;
--  user_date index is still useful for author-scoped queries)


-- ══ PART 2 — email_threads ════════════════════════════════════════════════════

-- Step 1: Add nullable org_id FK
alter table email_threads
  add column if not exists org_id uuid references organizations(id) on delete cascade;

-- Step 2: Backfill org_id from user_id via org_members
update email_threads e
set org_id = om.org_id
from org_members om
where om.user_id = e.user_id
  and e.org_id is null;

-- Step 3: Set NOT NULL
alter table email_threads alter column org_id set not null;

-- Step 4: Replace unique constraint
--   Old: unique(user_id, gmail_thread_id)
--   New: unique(org_id, gmail_thread_id)
alter table email_threads
  drop constraint if exists email_threads_user_id_gmail_thread_id_key;

alter table email_threads
  add constraint email_threads_org_id_gmail_thread_id_key
  unique (org_id, gmail_thread_id);

-- Step 5: Update RLS policy
drop policy if exists "email_threads_own" on email_threads;

create policy "email_threads_org" on email_threads
  using  (org_id = current_org_id())
  with check (org_id = current_org_id());

-- Step 6: Indexes
create index if not exists idx_email_threads_org
  on email_threads(org_id, last_message_at desc);

-- (keep existing idx_email_threads_account, idx_email_threads_user,
--  idx_email_threads_unread as-is)


-- ══ DEFERRED — tables with the same gap, not yet blocking any milestone ═══════
--
-- These four tables were audited and confirmed user_id-scoped only.
-- They must be migrated before any cross-org feature references them.
-- Create a separate migration (migration_m0b_workload_tables.sql) when ready.
--
-- briefing_items    — used by daily briefing engine; blocks M5 (priority queue)
-- outreach_queue    — used by outreach runner; blocks M3 (close-out write-back)
-- survey_schedules  — used by survey scheduler; blocks M5 (org-level survey config)
-- digest_schedules  — used by digest runner; blocks M5 (org-level digest config)
--
-- Pattern to follow: same Phase 1 steps as above (add nullable, backfill,
-- NOT NULL, update RLS). No unique-constraint replacement needed for these four
-- (their existing constraints do not include user_id).
-- ─────────────────────────────────────────────────────────────────────────────
