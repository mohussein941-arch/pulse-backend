-- M2f: harden current_org_id() — pin search_path, qualify org_members reference.
-- No behavior change for normal callers. Closes Supabase's
-- function_search_path_mutable lint on this SECURITY DEFINER function.
CREATE OR REPLACE FUNCTION public.current_org_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT org_id FROM public.org_members WHERE user_id = auth.uid() LIMIT 1;
$$;
