-- gmail_ingestion.sql
-- Run once in Supabase SQL Editor.
-- Adds: email field on stakeholders, domain on accounts, email_threads table.

-- ── Stakeholder email — needed for thread→account matching ────────────────────
alter table stakeholders
  add column if not exists email text;

create index if not exists idx_stakeholders_email
  on stakeholders(email) where email is not null;

-- ── Account domain — fallback matcher when no stakeholder email matches ───────
-- e.g. "acme.com" — all emails from @acme.com map to this account
alter table accounts
  add column if not exists domain text;

create index if not exists idx_accounts_domain
  on accounts(user_id, domain) where domain is not null;

-- ── Email threads — matched Gmail threads per account ─────────────────────────
create table if not exists email_threads (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  account_id        uuid        references accounts(id) on delete set null,
  gmail_thread_id   text        not null,
  subject           text,
  participants      text[],                -- all email addresses in the thread
  last_message_at   timestamptz,
  last_message_from text,                 -- sender of the most recent message
  snippet           text,                 -- preview of last message (~200 chars)
  message_count     int         default 1,
  is_unread_reply   boolean     default false, -- customer replied, CSM hasn't responded yet
  synced_at         timestamptz not null default now(),

  unique(user_id, gmail_thread_id)
);

alter table email_threads enable row level security;
create policy "email_threads_own" on email_threads
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_email_threads_account
  on email_threads(account_id, last_message_at desc);
create index if not exists idx_email_threads_user
  on email_threads(user_id, synced_at desc);
create index if not exists idx_email_threads_unread
  on email_threads(account_id) where is_unread_reply = true;
