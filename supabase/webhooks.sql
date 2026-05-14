-- Run this in the Supabase SQL Editor

create table if not exists user_webhooks (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  token      text        not null unique default encode(gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now()
);

alter table user_webhooks enable row level security;

create policy "webhooks_own" on user_webhooks
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
