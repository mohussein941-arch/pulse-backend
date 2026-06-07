create table if not exists tickets (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  account_id        uuid references accounts(id) on delete cascade,
  source            text not null,
  external_id       text not null,
  subject           text,
  status            text,
  priority          text,
  is_open           boolean default true,
  opened_at         timestamptz,
  ticket_updated_at timestamptz,
  resolved_at       timestamptz,
  url               text,
  synced_at         timestamptz default now(),
  created_at        timestamptz default now(),
  unique (org_id, source, external_id)
);
create index if not exists idx_tickets_account  on tickets(account_id);
create index if not exists idx_tickets_org_open on tickets(org_id, is_open);
