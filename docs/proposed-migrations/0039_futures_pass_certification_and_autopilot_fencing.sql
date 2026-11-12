-- PROPOSED — NOT APPLIED. Apply only after owner approval, byte-for-byte, together with the matching code.
-- 0039: production USD-M Futures require a current, explicit PASS certification bound to the production account and the
-- execution revision; the legacy testnet_certified_at timestamp no longer authorizes anything. Autopilot runs gain a
-- worker fence and finished runs become immutable. No settings, limits, credentials or certification rows are changed.

-- 1. Append-only certification records (service role writes; owners read their own). Latest record per account wins,
--    so a newer FAIL supersedes an older PASS. Nothing in the app inserts PASS automatically.
CREATE TABLE public.futures_certifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  testnet_connection_id uuid,
  environment text NOT NULL DEFAULT 'production' CHECK (environment = 'production'),
  result text NOT NULL CHECK (result IN ('PASS', 'FAIL')),
  revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 80),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX futures_certifications_account_idx ON public.futures_certifications (user_id, connection_id, created_at DESC, id DESC);
GRANT SELECT ON public.futures_certifications TO authenticated;
GRANT ALL ON public.futures_certifications TO service_role;
ALTER TABLE public.futures_certifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners read their Futures certifications" ON public.futures_certifications
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.validate_futures_certification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.exchange_connections WHERE id = NEW.connection_id AND user_id = NEW.user_id AND exchange = 'binance' AND NOT is_testnet) THEN
  RAISE EXCEPTION 'Certification must bind the owner''s production Binance account';
 END IF;
 IF NEW.testnet_connection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.exchange_connections WHERE id = NEW.testnet_connection_id AND user_id = NEW.user_id AND exchange = 'binance' AND is_testnet) THEN
  RAISE EXCEPTION 'Certification evidence must come from the owner''s Testnet account';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER futures_certification_binding BEFORE INSERT ON public.futures_certifications
  FOR EACH ROW EXECUTE FUNCTION public.validate_futures_certification();
CREATE TRIGGER futures_certifications_immutable BEFORE UPDATE OR DELETE ON public.futures_certifications
  FOR EACH ROW EXECUTE FUNCTION public.prevent_evaluation_mutation();

-- 2. Revision the current execution code requires (mirrors FUTURES_CERTIFICATION_REVISION in src/lib/futures-authorization.ts).
CREATE OR REPLACE FUNCTION public.futures_certification_revision()
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$ SELECT 'futures-exec-2026-11-r1'::text $$;

-- 3. Single database authority for production Futures entries.
CREATE OR REPLACE FUNCTION public.futures_live_authorized(_user uuid, _connection uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE c public.exchange_connections%ROWTYPE; s public.futures_settings%ROWTYPE; halted boolean; cert public.futures_certifications%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.exchange_connections WHERE id = _connection AND user_id = _user;
 IF NOT FOUND OR c.exchange <> 'binance' OR c.status <> 'connected' OR c.is_testnet THEN RETURN false; END IF;
 SELECT * INTO s FROM public.futures_settings WHERE user_id = _user;
 IF NOT FOUND OR NOT s.live_enabled OR s.connection_id IS DISTINCT FROM _connection THEN RETURN false; END IF;
 SELECT trading_halted INTO halted FROM public.risk_settings WHERE user_id = _user;
 IF halted IS NULL OR halted THEN RETURN false; END IF;
 SELECT * INTO cert FROM public.futures_certifications WHERE user_id = _user AND connection_id = _connection ORDER BY created_at DESC, id DESC LIMIT 1;
 IF NOT FOUND OR cert.result <> 'PASS' OR cert.environment <> 'production' OR cert.revision <> public.futures_certification_revision() THEN RETURN false; END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.futures_live_authorized(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.futures_live_authorized(uuid, uuid) TO service_role;

-- 4. Order gate: same body as before except the production branch, which now requires futures_live_authorized.
--    Exit intents (':exit:'), unresolved-exposure and pending-intent checks are unchanged; guard_new_entry_intent is untouched.
CREATE OR REPLACE FUNCTION public.guard_futures_live_intent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE c public.exchange_connections%ROWTYPE;
BEGIN
 IF NEW.market_type <> 'usd_m_futures' OR NEW.idempotency_key LIKE '%:exit:%' THEN RETURN NEW; END IF;
 SELECT * INTO c FROM public.exchange_connections WHERE id=NEW.exchange_connection_id AND user_id=NEW.user_id;
 IF NOT FOUND OR c.exchange<>'binance' OR c.status<>'connected' THEN RAISE EXCEPTION 'Verified owner Binance connection required'; END IF;
 IF NOT c.is_testnet AND NOT public.futures_live_authorized(NEW.user_id, c.id) THEN
  RAISE EXCEPTION 'Production Futures requires live opt-in, no halt and a current PASS certification for this account';
 END IF;
 IF EXISTS (SELECT 1 FROM public.positions WHERE user_id=NEW.user_id AND market_type='usd_m_futures' AND is_open AND coalesce(futures_details->>'protection','')<>'confirmed') THEN
  RAISE EXCEPTION 'Unresolved Futures exposure blocks new entries';
 END IF;
 IF EXISTS (SELECT 1 FROM public.orders WHERE user_id=NEW.user_id AND market_type='usd_m_futures' AND status IN ('pending','open','partially_filled')) THEN
  RAISE EXCEPTION 'Unresolved Futures order intent blocks new entries';
 END IF;
 RETURN NEW;
END $$;

COMMENT ON COLUMN public.futures_settings.testnet_certified_at IS 'DEPRECATED: never authorizes production Futures; replaced by public.futures_certifications PASS records';

-- 5. Autopilot worker fence + terminal-run immutability (a stopped run can never be resurrected).
ALTER TABLE public.autopilot_runs ADD COLUMN lease_holder uuid;
COMMENT ON COLUMN public.autopilot_runs.lease_holder IS 'Worker fence: every runner write compare-and-sets on this holder and an active status';

CREATE OR REPLACE FUNCTION public.guard_autopilot_run_terminal()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
 IF OLD.status IN ('done', 'failed', 'stopped') THEN RAISE EXCEPTION 'Finished Autopilot runs are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER autopilot_run_terminal_guard BEFORE UPDATE ON public.autopilot_runs
  FOR EACH ROW EXECUTE FUNCTION public.guard_autopilot_run_terminal();
