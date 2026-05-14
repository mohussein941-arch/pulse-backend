-- Run this in the Supabase SQL Editor

create table if not exists meeting_notes (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,
  account_id       uuid        references accounts(id) on delete set null,
  fireflies_id     text        not null,
  title            text,
  meeting_date     timestamptz,
  participants     text[],
  summary          text,
  action_items     text,
  organizer_email  text,
  synced_at        timestamptz not null default now(),
  unique(user_id, fireflies_id)
);

alter table meeting_notes enable row level security;

create policy "meeting_notes_own" on meeting_notes
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_meeting_notes_account
  on meeting_notes(account_id)
  where account_id is not null;

create index if not exists idx_meeting_notes_user_date
  on meeting_notes(user_id, meeting_date desc);
