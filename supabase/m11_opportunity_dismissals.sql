create table if not exists opportunity_dismissals (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  account_id   uuid not null references accounts(id) on delete cascade,
  feature_id   uuid not null references features(id) on delete cascade,
  dismissed_by uuid,
  dismissed_at timestamptz not null default now(),
  unique(account_id, feature_id)
);
create index if not exists idx_opp_dismissals_account on opportunity_dismissals(account_id);
