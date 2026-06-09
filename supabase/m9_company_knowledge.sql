create table if not exists company_profile (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  product_name     text,
  website_url      text,
  overview         text,
  value_props      jsonb default '[]',
  icp              text,
  pricing_summary  text,
  positioning      text,
  competitors      jsonb default '[]',
  target_verticals jsonb default '[]',
  sources          jsonb default '[]',
  confirmed        boolean default false,
  generated_at     timestamptz,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  unique (org_id)
);

create table if not exists features (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  name             text not null,
  problem_solved   text,
  use_cases        jsonb default '[]',
  personas         jsonb default '[]',
  tier             text,
  trigger_keywords jsonb default '[]',
  source           text default 'research',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists idx_features_org on features(org_id);
