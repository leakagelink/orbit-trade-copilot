-- =====================================================================================================
-- 0045 — DRAFT ONLY. NOT APPLIED. Requires separate owner approval (after a fresh export + practice restore).
-- Phase 4A: Futures PAPER ledger (BTCUSDT, ETHUSDT) and per-strategy risk budgets for the Central Risk Engine.
-- Every Futures paper fill, funding payment and liquidation recorded here is SIMULATED from public market data. Nothing
-- here can reach an exchange, credentials, real orders, positions, trades, risk_settings, futures_settings, the demo
-- wallet, the Spot paper ledger (0044), bots, Autopilot or Live Futures. No foreign key or trigger touches those tables.
--
-- Guarantees
--  * futures_paper_events is append-only for every role (UPDATE/DELETE/TRUNCATE refused). Rows arrive only through
--    futures_paper_commit_bar (service_role only), which locks the account, requires the sequence the worker read
--    (compare-and-set) and a strictly later, already-closed candle, writes consecutive sequence numbers, recomputes the
--    wallet from the previous wallet plus the events' wallet deltas and refuses a mismatch or a negative wallet, and
--    refuses entry events while the account is not active or is halted. A crash before COMMIT leaves nothing behind.
--  * An account's owner, engine version, symbols, timeframe, frozen config (SHA-256 set by the database) and starting
--    balance never change; wallet/sequence/cursor/state change only inside the commit function (a session cannot bypass
--    this by setting the flag itself); a stopped account stays stopped; accounts are never deleted.
--  * strategy_risk_budgets holds one maximum loss per (owner, strategy, environment). Only service_role writes it;
--    owners read their own. It changes no existing limit and is read SELECT-only by the Central Risk Engine.
--  * Browser roles only read their own rows (MFA-aware) and cannot write anything.
-- =====================================================================================================

CREATE TABLE public.futures_paper_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  engine_version text NOT NULL CHECK (engine_version = 'futures-paper-v1'),
  data_source text NOT NULL CHECK (data_source = 'binance-public-usdm'),
  symbols text[] NOT NULL CHECK (cardinality(symbols) BETWEEN 1 AND 2 AND symbols <@ ARRAY['BTCUSDT','ETHUSDT']::text[]),
  timeframe text NOT NULL CHECK (timeframe IN ('1m','5m','15m')),
  tf_ms bigint NOT NULL,
  config jsonb NOT NULL,
  config_sha256 text NOT NULL,
  starting_balance numeric NOT NULL CHECK (starting_balance > 0 AND starting_balance <= 1000000),
  wallet numeric NOT NULL CHECK (wallet >= 0),
  seq bigint NOT NULL DEFAULT 0,
  cursor_t bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','stopped')),
  status_reason text,
  halted boolean NOT NULL DEFAULT false,
  simulated boolean NOT NULL DEFAULT true CHECK (simulated),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX futures_paper_accounts_user ON public.futures_paper_accounts (user_id);

CREATE TABLE public.futures_paper_events (
  account_id uuid NOT NULL REFERENCES public.futures_paper_accounts(id),
  seq bigint NOT NULL CHECK (seq > 0),
  user_id uuid NOT NULL,
  bar_t bigint NOT NULL,
  t bigint NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT','ETHUSDT')),
  kind text NOT NULL CHECK (kind IN ('funding','entry_fill','entry_cancelled','exit_fill','liquidation','order_accepted','order_rejected')),
  side text CHECK (side IN ('LONG','SHORT')),
  qty numeric NOT NULL CHECK (qty >= 0),
  price numeric CHECK (price IS NULL OR price >= 0),
  fee numeric NOT NULL CHECK (fee >= 0),
  pnl numeric NOT NULL,
  wallet_delta numeric NOT NULL,
  margin_delta numeric NOT NULL,
  wallet_after numeric NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  proposal_id text,
  simulated boolean NOT NULL DEFAULT true CHECK (simulated),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, seq)
);
CREATE INDEX futures_paper_events_user ON public.futures_paper_events (user_id, account_id, bar_t DESC);

CREATE TABLE public.strategy_risk_budgets (
  user_id uuid NOT NULL,
  strategy_id text NOT NULL CHECK (length(strategy_id) BETWEEN 1 AND 200),
  environment text NOT NULL CHECK (environment IN ('paper','testnet','production')),
  max_loss numeric NOT NULL CHECK (max_loss > 0 AND max_loss <= 1000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, strategy_id, environment)
);

-- ---------- guards ----------
CREATE FUNCTION public.futures_paper_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  RAISE EXCEPTION 'futures paper history is append-only (% on %)', TG_OP, TG_TABLE_NAME;
END $$;
CREATE TRIGGER futures_paper_events_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_events FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_events_no_truncate BEFORE TRUNCATE ON public.futures_paper_events FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_accounts_no_truncate BEFORE TRUNCATE ON public.futures_paper_accounts FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();

CREATE FUNCTION public.guard_futures_paper_account() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE v_now bigint := floor(extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'futures paper accounts cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.tf_ms := CASE NEW.timeframe WHEN '1m' THEN 60000 WHEN '5m' THEN 300000 WHEN '15m' THEN 900000 END;
    NEW.config_sha256 := encode(sha256(convert_to(NEW.config::text, 'UTF8')), 'hex');
    NEW.created_at := now(); NEW.updated_at := now(); NEW.status := 'active'; NEW.status_reason := NULL; NEW.halted := false;
    NEW.wallet := NEW.starting_balance; NEW.seq := 0;
    -- Forward only: the first candle it may act on opens at or after creation.
    NEW.cursor_t := ((v_now + NEW.tf_ms - 1) / NEW.tf_ms) * NEW.tf_ms - NEW.tf_ms;
    IF (NEW.state->>'wallet')::numeric IS DISTINCT FROM NEW.starting_balance OR NEW.state->'positions' <> '{}'::jsonb OR NEW.state->'pending' <> '{}'::jsonb THEN
      RAISE EXCEPTION 'a futures paper account must start flat with its starting balance';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.user_id, NEW.engine_version, NEW.data_source, NEW.symbols, NEW.timeframe, NEW.tf_ms, NEW.config, NEW.config_sha256, NEW.starting_balance, NEW.created_at, NEW.simulated)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.engine_version, OLD.data_source, OLD.symbols, OLD.timeframe, OLD.tf_ms, OLD.config, OLD.config_sha256, OLD.starting_balance, OLD.created_at, OLD.simulated) THEN
    RAISE EXCEPTION 'futures paper account identity, config and starting balance are frozen';
  END IF;
  IF (NEW.wallet, NEW.seq, NEW.cursor_t, NEW.state) IS DISTINCT FROM (OLD.wallet, OLD.seq, OLD.cursor_t, OLD.state)
     AND NOT (coalesce(current_setting('futures_paper.commit', true), '') = 'on'
              AND current_user NOT IN ('anon', 'authenticated', 'service_role', 'authenticator')) THEN
    RAISE EXCEPTION 'futures paper ledger columns change only through futures_paper_commit_bar';
  END IF;
  IF OLD.status = 'stopped' AND NEW.status <> 'stopped' THEN RAISE EXCEPTION 'a stopped futures paper account stays stopped'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER futures_paper_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON public.futures_paper_accounts FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_account();

CREATE FUNCTION public.guard_strategy_risk_budget() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'strategy risk budgets are not deleted; lower them instead'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id, NEW.strategy_id, NEW.environment, NEW.created_at) IS DISTINCT FROM (OLD.user_id, OLD.strategy_id, OLD.environment, OLD.created_at) THEN
    RAISE EXCEPTION 'strategy risk budget identity is frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER strategy_risk_budgets_guard BEFORE INSERT OR UPDATE OR DELETE ON public.strategy_risk_budgets FOR EACH ROW EXECUTE FUNCTION public.guard_strategy_risk_budget();

-- ---------- atomic per-candle commit ----------
CREATE FUNCTION public.futures_paper_commit_bar(p_account uuid, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  a public.futures_paper_accounts%ROWTYPE;
  v_now bigint := floor(extract(epoch FROM now()) * 1000)::bigint;
  v_wallet numeric; v_seq bigint; e jsonb;
BEGIN
  SELECT * INTO a FROM public.futures_paper_accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'futures paper account not found'; END IF;
  IF a.status = 'stopped' THEN RAISE EXCEPTION 'futures paper account is stopped'; END IF;
  IF a.seq <> p_expected_seq THEN RAISE EXCEPTION 'futures paper sequence moved (expected %, found %)', p_expected_seq, a.seq; END IF;
  IF p_bar_t <= a.cursor_t OR p_bar_t % a.tf_ms <> 0 THEN RAISE EXCEPTION 'candle % is not after the cursor %', p_bar_t, a.cursor_t; END IF;
  IF p_bar_t + a.tf_ms > v_now THEN RAISE EXCEPTION 'candle % has not closed yet', p_bar_t; END IF;
  v_wallet := a.wallet; v_seq := a.seq;
  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'events', '[]'::jsonb)) LOOP
    IF (e->>'seq')::bigint <> v_seq + 1 THEN RAISE EXCEPTION 'event sequence must be consecutive'; END IF;
    IF NOT (e->>'symbol' = ANY (a.symbols)) THEN RAISE EXCEPTION 'symbol % is not part of this account', e->>'symbol'; END IF;
    IF e->>'kind' IN ('entry_fill','order_accepted') AND (a.status <> 'active' OR a.halted) THEN RAISE EXCEPTION 'entries are refused while the account is not active or is halted'; END IF;
    v_seq := v_seq + 1; v_wallet := v_wallet + (e->>'wallet_delta')::numeric;
    IF v_wallet < 0 THEN RAISE EXCEPTION 'simulated wallet would go negative'; END IF;
    INSERT INTO public.futures_paper_events (account_id, seq, user_id, bar_t, t, symbol, kind, side, qty, price, fee, pnl, wallet_delta, margin_delta, wallet_after, reason, proposal_id)
    VALUES (a.id, v_seq, a.user_id, p_bar_t, (e->>'t')::bigint, e->>'symbol', e->>'kind', e->>'side', (e->>'qty')::numeric, (e->>'price')::numeric, (e->>'fee')::numeric,
            (e->>'pnl')::numeric, (e->>'wallet_delta')::numeric, (e->>'margin_delta')::numeric, v_wallet, e->>'reason', e->>'proposal_id');
  END LOOP;
  IF abs(v_wallet - (p_payload->>'wallet')::numeric) > 0.000001 OR abs(v_wallet - (p_payload->'state'->>'wallet')::numeric) > 0.000001 THEN
    RAISE EXCEPTION 'wallet does not reconcile with the event ledger';
  END IF;
  PERFORM set_config('futures_paper.commit', 'on', true);
  UPDATE public.futures_paper_accounts SET wallet = v_wallet, seq = v_seq, cursor_t = p_bar_t, state = p_payload->'state' WHERE id = a.id;
  PERFORM set_config('futures_paper.commit', 'off', true);
  RETURN v_seq;
END $$;

-- ---------- privileges and row security ----------
REVOKE ALL ON public.futures_paper_accounts, public.futures_paper_events, public.strategy_risk_budgets FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.futures_paper_accounts, public.futures_paper_events, public.strategy_risk_budgets TO authenticated, service_role;
GRANT INSERT, UPDATE ON public.futures_paper_accounts, public.strategy_risk_budgets TO service_role;
ALTER TABLE public.futures_paper_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy_risk_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_paper_accounts_owner_read ON public.futures_paper_accounts FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_events_owner_read ON public.futures_paper_events FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY strategy_risk_budgets_owner_read ON public.strategy_risk_budgets FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());

REVOKE ALL ON FUNCTION public.futures_paper_history_immutable(), public.guard_futures_paper_account(), public.guard_strategy_risk_budget() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.futures_paper_commit_bar(uuid, bigint, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.futures_paper_commit_bar(uuid, bigint, bigint, jsonb) TO service_role;
