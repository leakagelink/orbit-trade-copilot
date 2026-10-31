CREATE OR REPLACE FUNCTION public.has_pro_access(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
 SELECT (_uid IS NOT NULL AND now() < timestamptz '2026-11-05 00:00:00+05:30') OR EXISTS (SELECT 1 FROM public.subscriptions WHERE user_id = _uid AND plan IN ('pro','elite','premium') AND status IN ('active','trialing') AND (current_period_end IS NULL OR current_period_end > now())) OR public.has_role(_uid,'admin') OR public.has_role(_uid,'super_admin')
$$;
CREATE OR REPLACE FUNCTION public.has_elite_access(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
 SELECT (_uid IS NOT NULL AND now() < timestamptz '2026-11-05 00:00:00+05:30') OR EXISTS (SELECT 1 FROM public.subscriptions WHERE user_id = _uid AND plan IN ('elite','premium') AND status IN ('active','trialing') AND (current_period_end IS NULL OR current_period_end > now())) OR public.has_role(_uid,'admin') OR public.has_role(_uid,'super_admin')
$$;
COMMENT ON FUNCTION public.has_elite_access(uuid) IS 'Includes a free-access promotion for every signed-in user until 4 Nov 2026 end of day IST.';