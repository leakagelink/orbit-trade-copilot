ALTER TABLE public.profiles ADD COLUMN leaderboard_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN referral_code text UNIQUE DEFAULT upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
ALTER TABLE public.profiles ADD COLUMN onboarding_dismissed boolean NOT NULL DEFAULT false;
UPDATE public.profiles SET referral_code = upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)) WHERE referral_code IS NULL;

CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL,
  referred_id uuid NOT NULL UNIQUE,
  reward_status text NOT NULL DEFAULT 'pending' CHECK (reward_status IN ('pending','granted','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_id <> referred_id)
);
GRANT SELECT ON public.referrals TO authenticated;
GRANT ALL ON public.referrals TO service_role;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY referrals_read ON public.referrals FOR SELECT TO authenticated
  USING (public.account_mfa_allowed() AND (referrer_id = auth.uid() OR referred_id = auth.uid() OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'super_admin')));

CREATE OR REPLACE FUNCTION public.claim_referral(_code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _me uuid := auth.uid(); _ref uuid; _joined timestamptz;
BEGIN
  IF _me IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;
  SELECT created_at INTO _joined FROM auth.users WHERE id = _me;
  IF _joined < now() - interval '7 days' THEN RETURN 'too_late'; END IF;
  SELECT id INTO _ref FROM public.profiles WHERE referral_code = upper(trim(_code));
  IF _ref IS NULL THEN RETURN 'invalid'; END IF;
  IF _ref = _me THEN RETURN 'self'; END IF;
  INSERT INTO public.referrals(referrer_id, referred_id) VALUES (_ref, _me) ON CONFLICT (referred_id) DO NOTHING;
  RETURN 'ok';
END $$;
REVOKE ALL ON FUNCTION public.claim_referral(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.claim_referral(text) TO authenticated;

ALTER TABLE public.strategies ADD COLUMN is_published boolean NOT NULL DEFAULT false;
ALTER TABLE public.strategies ADD COLUMN published_at timestamptz;
ALTER TABLE public.strategies ADD COLUMN clone_count integer NOT NULL DEFAULT 0;
CREATE POLICY strategies_marketplace_read ON public.strategies FOR SELECT TO authenticated USING (is_published AND public.account_mfa_allowed());

CREATE OR REPLACE FUNCTION public.marketplace_strategies() RETURNS TABLE(id uuid, name text, description text, config jsonb, author text, published_at timestamptz, clone_count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.name, s.description, s.config, coalesce(nullif(p.display_name,''),'Trader'), s.published_at, s.clone_count
  FROM public.strategies s LEFT JOIN public.profiles p ON p.id = s.user_id
  WHERE s.is_published AND auth.uid() IS NOT NULL
  ORDER BY s.clone_count DESC, s.published_at DESC LIMIT 100
$$;
REVOKE ALL ON FUNCTION public.marketplace_strategies() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.marketplace_strategies() TO authenticated;

CREATE OR REPLACE FUNCTION public.bump_strategy_clone(_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.strategies SET clone_count = clone_count + 1 WHERE id = _id AND is_published AND user_id <> auth.uid();
$$;
REVOKE ALL ON FUNCTION public.bump_strategy_clone(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.bump_strategy_clone(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.demo_leaderboard() RETURNS TABLE(rank bigint, trader text, net_pnl numeric, trades bigint, win_rate numeric, is_me boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH agg AS (
    SELECT t.user_id, sum(t.realized_pnl - t.fees) AS net, count(*) AS n,
           avg(CASE WHEN t.realized_pnl - t.fees > 0 THEN 1 ELSE 0 END) * 100 AS wr
    FROM public.trades t JOIN public.profiles p ON p.id = t.user_id AND p.leaderboard_opt_in
    WHERE t.mode = 'paper' AND t.closed_at >= now() - interval '30 days'
    GROUP BY t.user_id HAVING count(*) >= 3
  )
  SELECT rank() OVER (ORDER BY a.net DESC), coalesce(nullif(p.display_name,''),'Trader ' || substr(a.user_id::text,1,4)),
         round(a.net,2), a.n, round(a.wr,1), a.user_id = auth.uid()
  FROM agg a JOIN public.profiles p ON p.id = a.user_id
  WHERE auth.uid() IS NOT NULL
  ORDER BY a.net DESC LIMIT 50
$$;
REVOKE ALL ON FUNCTION public.demo_leaderboard() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.demo_leaderboard() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'super_admin')) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN jsonb_build_object(
    'users', (SELECT count(*) FROM auth.users),
    'new_7d', (SELECT count(*) FROM auth.users WHERE created_at >= now() - interval '7 days'),
    'pro', (SELECT count(*) FROM public.subscriptions WHERE plan = 'pro' AND status = 'active'),
    'elite', (SELECT count(*) FROM public.subscriptions WHERE plan IN ('elite','premium') AND status = 'active'),
    'open_tickets', (SELECT count(*) FROM public.support_tickets WHERE status <> 'resolved'),
    'trades_7d', (SELECT count(*) FROM public.trades WHERE created_at >= now() - interval '7 days'),
    'live_bots', (SELECT count(*) FROM public.trading_bots WHERE mode = 'live' AND status = 'running'),
    'referrals', (SELECT count(*) FROM public.referrals)
  );
END $$;
REVOKE ALL ON FUNCTION public.admin_overview() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_overview() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_users(_search text DEFAULT '') RETURNS TABLE(id uuid, email text, display_name text, plan text, joined timestamptz, last_sign_in timestamptz, trades bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'super_admin')) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY SELECT u.id, u.email::text, p.display_name, coalesce(s.plan,'free'), u.created_at, u.last_sign_in_at,
    (SELECT count(*) FROM public.trades t WHERE t.user_id = u.id)
  FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id LEFT JOIN public.subscriptions s ON s.user_id = u.id
  WHERE coalesce(_search,'') = '' OR u.email ILIKE '%' || _search || '%' OR p.display_name ILIKE '%' || _search || '%'
  ORDER BY u.created_at DESC LIMIT 100;
END $$;
REVOKE ALL ON FUNCTION public.admin_users(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_users(text) TO authenticated;