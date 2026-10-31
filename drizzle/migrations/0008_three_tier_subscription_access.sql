ALTER TABLE public.subscriptions DROP CONSTRAINT subscriptions_plan_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_plan_check CHECK (plan IN ('free','pro','elite','premium'));
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS billing_interval text CHECK (billing_interval IN ('monthly','yearly'));
COMMENT ON COLUMN public.subscriptions.plan IS 'free, pro, elite; premium is a deprecated legacy alias for elite.';
CREATE OR REPLACE FUNCTION public.has_pro_access(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
 SELECT EXISTS (SELECT 1 FROM public.subscriptions WHERE user_id = _uid AND plan IN ('pro','elite','premium') AND status IN ('active','trialing') AND (current_period_end IS NULL OR current_period_end > now())) OR public.has_role(_uid,'admin') OR public.has_role(_uid,'super_admin')
$$;
REVOKE EXECUTE ON FUNCTION public.has_pro_access(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.has_pro_access(uuid) TO authenticated, service_role;
CREATE OR REPLACE FUNCTION public.has_elite_access(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
 SELECT EXISTS (SELECT 1 FROM public.subscriptions WHERE user_id = _uid AND plan IN ('elite','premium') AND status IN ('active','trialing') AND (current_period_end IS NULL OR current_period_end > now())) OR public.has_role(_uid,'admin') OR public.has_role(_uid,'super_admin')
$$;
REVOKE EXECUTE ON FUNCTION public.has_elite_access(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.has_elite_access(uuid) TO authenticated, service_role;
ALTER POLICY "Paid users read own arbitrage" ON public.arbitrage_runs USING (auth.uid() = user_id);
COMMENT ON POLICY "Paid users read own arbitrage" ON public.arbitrage_runs IS 'Owner history remains readable after downgrade for reconciliation; new scans/reviews/execution are Elite-only server functions.';