create table if not exists knowledge_documents (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  kind         text not null,
  title        text,
  source       text,
  content_text text,
  created_at   timestamptz default now()
);
create index if not exists idx_knowledge_documents_org on knowledge_documents(org_id);

alter table features add column if not exists locked boolean default false;

alter table company_profile add column if not exists profile_draft jsonb;
alter table company_profile add column if not exists has_draft boolean default false;
