-- M3a: closeouts table + outreach_queue org_id backfill
-- (1) closeouts: new table, org-scoped RLS, unique by (org_id, meeting_notes_id).
--     Per D7, one closeout per meeting per org (no TTL, no 6-tuple cache).
-- (2) outreach_queue: add org_id, backfill from org_members, NOT NULL, add FK + index,
--     swap RLS from user-only to org-scoped. Roadmap M3 spec required this.

begin;

-- (1) closeouts table -------------------------------------------------------
create table if not exists public.closeouts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  account_id        uuid          references public.accounts(id)      on delete set null,
  meeting_notes_id  uuid not null references public.meeting_notes(id) on delete cascade,
  user_id           uuid          references auth.users(id)           on delete set null,
  content           jsonb not null,
  model             text  not null default 'claude-sonnet-4-6',
  prompt_version    text  not null,
  created_at        timestamptz not null default now(),
  unique (org_id, meeting_notes_id)
);

create index if not exists idx_closeouts_org_account on public.closeouts (org_id, account_id);
create index if not exists idx_closeouts_meeting     on public.closeouts (meeting_notes_id);

alter table public.closeouts enable row level security;

create policy "closeouts_select" on public.closeouts
  for select using (org_id = current_org_id());

create policy "closeouts_insert" on public.closeouts
  for insert with check (org_id = current_org_id());

create policy "closeouts_update" on public.closeouts
  for update using       (org_id = current_org_id())
              with check (org_id = current_org_id());

create policy "closeouts_delete" on public.closeouts
  for delete using (org_id = current_org_id());

-- (2) outreach_queue org_id migration --------------------------------------
alter table public.outreach_queue
  add column if not exists org_id uuid references public.organizations(id) on delete cascade;

update public.outreach_queue oq
   set org_id = (
     select om.org_id from public.org_members om
      where om.user_id = oq.user_id
      limit 1
   )
 where oq.org_id is null;

-- Fail loudly + roll back the whole transaction if backfill incomplete
do $$
declare null_count int;
begin
  select count(*) into null_count from public.outreach_queue where org_id is null;
  if null_count > 0 then
    raise exception 'outreach_queue backfill incomplete: % rows still have NULL org_id', null_count;
  end if;
end$$;

alter table public.outreach_queue alter column org_id set not null;

create index if not exists idx_outreach_queue_org on public.outreach_queue (org_id);

-- RLS swap: ensure enabled, drop existing user-scoped policies, add org-scoped.
alter table public.outreach_queue enable row level security;
drop policy if exists "outreach_queue_own" on public.outreach_queue;

create policy "outreach_queue_org" on public.outreach_queue
  for all using       (org_id = current_org_id())
          with check (org_id = current_org_id());

commit;
