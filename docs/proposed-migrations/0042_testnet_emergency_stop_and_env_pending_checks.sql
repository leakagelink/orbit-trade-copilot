-- =====================================================================================================
-- 0042 — DRAFT ONLY. NOT APPLIED. Requires separate owner approval and a fresh verified export first.
-- Separate Testnet emergency stop + environment-specific Futures pending/limit checks.
--
-- Guarantees
--  * The Testnet stop lives in its own tables and is written only by service-role RPCs; it never reads or
--    writes risk_settings, futures_settings, production positions or production orders.
--  * The production emergency stop (risk_settings.trading_halted) keeps blocking BOTH environments.
--  * Testnet Futures entries use fixed Testnet limits in the database (mirroring TESTNET_FUTURES_LIMITS in
--    src/lib/futures-testnet-limits.ts) and count only Testnet rows; production entries keep using
--    risk_settings limits exactly as before.
--  * Pending orders / unresolved positions block only their own environment; legacy_unknown blocks both.
--  * Exits (idempotency keys containing ':exit:') are never blocked by either stop.
-- =====================================================================================================
BEGIN;

-- 1. Separate Testnet emergency stop -----------------------------------------------------------------
CREATE TABLE public.testnet_emergency_stops (
  user_id     uuid PRIMARY KEY,
  halted      boolean NOT NULL DEFAULT false,
  reason      text,
  halted_at   timestamptz,
  released_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.testnet_emergency_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  action     text NOT NULL CHECK (action IN ('halt', 'release')),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX testnet_emergency_events_user_idx ON public.testnet_emergency_events (user_id, created_at DESC);
CREATE TRIGGER testnet_emergency_events_immutable BEFORE UPDATE OR DELETE ON public.testnet_emergency_events
  FOR EACH ROW EXECUTE FUNCTION public.safety_event_immutable();

ALTER TABLE public.testnet_emergency_stops  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.testnet_emergency_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.testnet_emergency_stops, public.testnet_emergency_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.testnet_emergency_stops, public.testnet_emergency_events TO authenticated;
GRANT ALL ON public.testnet_emergency_stops, public.testnet_emergency_events TO service_role;
CREATE POLICY testnet_stop_owner_read ON public.testnet_emergency_stops FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY testnet_stop_events_owner_read ON public.testnet_emergency_events FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.account_mfa_allowed());

-- Atomic service-role-only switches. They touch ONLY the two Testnet tables.
CREATE FUNCTION public.testnet_emergency_halt(_user uuid, _reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF _user IS NULL THEN RAISE EXCEPTION 'User required'; END IF;
  INSERT INTO public.testnet_emergency_stops(user_id, halted, reason, halted_at, released_at, updated_at)
    VALUES (_user, true, left(_reason, 300), now(), NULL, now())
  ON CONFLICT (user_id) DO UPDATE SET halted = true, reason = left(_reason, 300), halted_at = now(), released_at = NULL, updated_at = now();
  INSERT INTO public.testnet_emergency_events(user_id, action, reason) VALUES (_user, 'halt', left(_reason, 300));
  RETURN true;
END $$;
CREATE FUNCTION public.testnet_emergency_release(_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE public.testnet_emergency_stops SET halted = false, released_at = now(), updated_at = now() WHERE user_id = _user AND halted;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.testnet_emergency_events(user_id, action) VALUES (_user, 'release');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.testnet_emergency_halt(uuid, text), public.testnet_emergency_release(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.testnet_emergency_halt(uuid, text), public.testnet_emergency_release(uuid) TO service_role;

-- Fixed Testnet limits (must equal TESTNET_FUTURES_LIMITS; a test asserts this).
CREATE FUNCTION public.testnet_futures_limits(OUT max_exposure numeric, OUT max_open_positions integer, OUT max_daily_loss numeric)
LANGUAGE sql IMMUTABLE AS $$ SELECT 10::numeric, 1, 2::numeric $$;
REVOKE ALL ON FUNCTION public.testnet_futures_limits() FROM PUBLIC, anon, authenticated;

-- 2. Entry risk gate: production branch byte-equivalent to the current function; Testnet Futures branch added.
CREATE OR REPLACE FUNCTION public.guard_new_entry_intent()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r public.risk_settings%ROWTYPE; exposure numeric; reserved numeric; position_count integer; pending_count integer; pnl numeric; env text; prod_halted boolean; lim record;
BEGIN
 IF NEW.idempotency_key LIKE '%:exit:%' THEN RETURN NEW; END IF;
 IF NEW.price IS NULL OR NEW.price<=0 OR NEW.quantity<=0 THEN RAISE EXCEPTION 'Entry intent requires a positive verified reference price and quantity'; END IF;
 env:=CASE WHEN NEW.market_type='usd_m_futures' THEN NEW.execution_environment ELSE NULL END;
 IF env IS NOT NULL AND env NOT IN ('testnet','production') THEN RAISE EXCEPTION 'Futures environment unavailable'; END IF;
 IF env='testnet' THEN
  -- Production stop covers Testnet (read only; no lock on the production risk row). Serialize on the Testnet stop row.
  SELECT rs.trading_halted INTO prod_halted FROM public.risk_settings rs WHERE rs.user_id=NEW.user_id;
  IF prod_halted IS NULL THEN RAISE EXCEPTION 'Risk settings required before an entry'; END IF;
  IF prod_halted THEN RAISE EXCEPTION 'Trading is halted'; END IF;
  INSERT INTO public.testnet_emergency_stops(user_id) VALUES (NEW.user_id) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM public.testnet_emergency_stops ts WHERE ts.user_id=NEW.user_id AND NOT ts.halted FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Testnet emergency stop is active'; END IF;
  IF EXISTS(SELECT 1 FROM public.positions WHERE user_id=NEW.user_id AND market_type='usd_m_futures' AND is_open AND execution_environment='legacy_unknown') THEN RAISE EXCEPTION 'Legacy Futures exposure requires reconciliation'; END IF;
  SELECT * INTO lim FROM public.testnet_futures_limits();
  SELECT count(*),coalesce(sum(entry_price*quantity),0) INTO position_count,exposure FROM public.positions WHERE user_id=NEW.user_id AND is_open AND execution_environment='testnet';
  SELECT count(*),coalesce(sum(quantity*price),0) INTO pending_count,reserved FROM public.orders WHERE user_id=NEW.user_id AND status IN ('pending','open','partially_filled') AND idempotency_key NOT LIKE '%:exit:%' AND execution_environment='testnet';
  IF position_count+pending_count>=lim.max_open_positions THEN RAISE EXCEPTION 'Testnet position limit reached including pending intents'; END IF;
  IF exposure+reserved+NEW.quantity*NEW.price>lim.max_exposure THEN RAISE EXCEPTION 'Testnet exposure limit reached including pending intents'; END IF;
  SELECT coalesce(sum(net_pnl),0) INTO pnl FROM public.trades WHERE user_id=NEW.user_id AND closed_at>=date_trunc('day',now()) AND execution_environment='testnet';
  SELECT pnl+coalesce(sum(least(unrealized_pnl,0)),0) INTO pnl FROM public.positions WHERE user_id=NEW.user_id AND is_open AND execution_environment='testnet';
  IF pnl<=-lim.max_daily_loss THEN RAISE EXCEPTION 'Testnet loss limit reached'; END IF;
  RETURN NEW;
 END IF;
 -- Unchanged production / non-Futures path.
 SELECT * INTO r FROM public.risk_settings WHERE user_id=NEW.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Risk settings required before an entry'; END IF;
 IF r.trading_halted THEN RAISE EXCEPTION 'Trading is halted'; END IF;
 IF env IS NOT NULL AND EXISTS(SELECT 1 FROM public.positions WHERE user_id=NEW.user_id AND market_type='usd_m_futures' AND is_open AND execution_environment='legacy_unknown') THEN RAISE EXCEPTION 'Legacy Futures exposure requires reconciliation'; END IF;
 SELECT count(*),coalesce(sum(entry_price*quantity),0) INTO position_count,exposure FROM public.positions WHERE user_id=NEW.user_id AND is_open AND (env IS NULL OR execution_environment=env);
 SELECT count(*),coalesce(sum(quantity*price),0) INTO pending_count,reserved FROM public.orders WHERE user_id=NEW.user_id AND status IN ('pending','open','partially_filled') AND idempotency_key NOT LIKE '%:exit:%' AND (env IS NULL OR execution_environment=env);
 IF r.max_total_positions IS NOT NULL AND position_count+pending_count>=r.max_total_positions THEN RAISE EXCEPTION 'Account position limit reached including pending intents'; END IF;
 IF r.max_open_exposure IS NOT NULL AND exposure+reserved+NEW.quantity*NEW.price>r.max_open_exposure THEN RAISE EXCEPTION 'Account exposure limit reached including pending intents'; END IF;
 SELECT coalesce(sum(net_pnl),0) INTO pnl FROM public.trades WHERE user_id=NEW.user_id AND closed_at>=date_trunc('day',now()) AND (env IS NULL OR execution_environment=env);
 SELECT pnl+coalesce(sum(least(unrealized_pnl,0)),0) INTO pnl FROM public.positions WHERE user_id=NEW.user_id AND is_open AND (env IS NULL OR execution_environment=env);
 IF r.max_daily_loss IS NOT NULL AND pnl<=-r.max_daily_loss THEN RAISE EXCEPTION 'Account loss limit reached'; END IF;
 RETURN NEW;
END $function$;

-- 3. Futures gate: environment must match the account; pending/unresolved checks scoped per environment.
CREATE OR REPLACE FUNCTION public.guard_futures_live_intent()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE c public.exchange_connections%ROWTYPE; env text;
BEGIN
 IF NEW.market_type <> 'usd_m_futures' OR NEW.idempotency_key LIKE '%:exit:%' THEN RETURN NEW; END IF;
 SELECT * INTO c FROM public.exchange_connections WHERE id=NEW.exchange_connection_id AND user_id=NEW.user_id;
 IF NOT FOUND OR c.exchange<>'binance' OR c.status<>'connected' THEN RAISE EXCEPTION 'Verified owner Binance connection required'; END IF;
 env:=CASE WHEN c.is_testnet THEN 'testnet' ELSE 'production' END;
 IF NEW.execution_environment IS DISTINCT FROM env THEN RAISE EXCEPTION 'Futures environment does not match the trading account'; END IF;
 IF c.is_testnet THEN
  IF EXISTS (SELECT 1 FROM public.risk_settings WHERE user_id=NEW.user_id AND trading_halted) THEN RAISE EXCEPTION 'Production emergency stop is active; Testnet entries are blocked too'; END IF;
  IF EXISTS (SELECT 1 FROM public.testnet_emergency_stops WHERE user_id=NEW.user_id AND halted) THEN RAISE EXCEPTION 'Testnet emergency stop is active'; END IF;
 ELSIF NOT public.futures_live_authorized(NEW.user_id, c.id) THEN
  RAISE EXCEPTION 'Production Futures requires live opt-in, no halt and a current PASS certification for this account';
 END IF;
 IF EXISTS (SELECT 1 FROM public.positions WHERE user_id=NEW.user_id AND market_type='usd_m_futures' AND is_open AND execution_environment IN (env,'legacy_unknown') AND coalesce(futures_details->>'protection','')<>'confirmed') THEN
  RAISE EXCEPTION 'Unresolved Futures exposure blocks new entries';
 END IF;
 IF EXISTS (SELECT 1 FROM public.orders WHERE user_id=NEW.user_id AND market_type='usd_m_futures' AND status IN ('pending','open','partially_filled') AND execution_environment IN (env,'legacy_unknown')) THEN
  RAISE EXCEPTION 'Unresolved Futures order intent blocks new entries';
 END IF;
 RETURN NEW;
END $function$;

COMMIT;
