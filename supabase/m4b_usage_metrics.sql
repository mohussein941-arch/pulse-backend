-- Phase 4b: declared-capacity columns + event aggregation function
alter table accounts add column if not exists licensed_seats    integer;
alter table accounts add column if not exists licensed_features integer;

create or replace function compute_usage_metrics(
  p_account_id uuid,
  p_org_id     uuid,
  p_as_of      timestamptz
)
returns table (
  dau integer, wau integer, mau integer, active_users integer,
  last_active_at timestamptz, events_count integer, events_count_prev integer,
  features_used_count integer, sessions_last_30d integer, key_events jsonb
)
language sql stable as $$
  with ev as (
    select user_ref, event_name, occurred_at, session_id
    from usage_events
    where account_id = p_account_id and org_id = p_org_id
  ),
  recent as (
    select * from ev where occurred_at >= p_as_of - interval '30 days' and occurred_at <= p_as_of
  )
  select
    (select count(distinct user_ref) from ev where occurred_at >= p_as_of - interval '1 day'  and occurred_at <= p_as_of)::int,
    (select count(distinct user_ref) from ev where occurred_at >= p_as_of - interval '7 days'  and occurred_at <= p_as_of)::int,
    (select count(distinct user_ref) from recent)::int,
    (select count(distinct user_ref) from recent)::int,
    (select max(occurred_at) from ev),
    (select count(*) from recent)::int,
    (select count(*) from ev where occurred_at >= p_as_of - interval '60 days' and occurred_at < p_as_of - interval '30 days')::int,
    (select count(distinct event_name) from recent)::int,
    (select count(distinct session_id) from recent where session_id is not null)::int,
    (select jsonb_object_agg(event_name, c) from (select event_name, count(*) c from recent group by event_name) k);
$$;

grant execute on function compute_usage_metrics(uuid, uuid, timestamptz) to service_role, authenticated;
