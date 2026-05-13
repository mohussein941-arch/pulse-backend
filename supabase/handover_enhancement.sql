-- handover_enhancement.sql
-- Enhanced sales handover: magic link token, sales email, status tracking
-- Run once in Supabase SQL Editor.

alter table onboarding_plans
  add column if not exists handover_token      text unique,
  add column if not exists handover_sales_email text,
  add column if not exists handover_status     text default 'draft',
  add column if not exists handover_sent_at    timestamptz,
  add column if not exists handover_confirmed_at timestamptz,
  add column if not exists handover_sales_notes text;

-- handover_status: draft | sent | confirmed
-- draft    — not yet shared with sales
-- sent     — magic link sent to sales rep, awaiting their input
-- confirmed — sales rep confirmed (and optionally added notes)

create index if not exists idx_ob_plans_handover_token
  on onboarding_plans(handover_token) where handover_token is not null;
