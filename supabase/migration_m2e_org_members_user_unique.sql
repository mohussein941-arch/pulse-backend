-- M2e: enforce one-org-per-user at the DB level
-- current_org_id() uses `limit 1` with no ORDER BY; without this constraint a user
-- in two orgs would get an arbitrary org and silently access the wrong tenant's data.
-- Verified zero violators immediately before applying (2026-05-28).
ALTER TABLE public.org_members
  ADD CONSTRAINT org_members_user_id_key UNIQUE (user_id);
