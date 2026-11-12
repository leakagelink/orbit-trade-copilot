-- =====================================================================================================
-- 0044 — DRAFT ONLY. NOT APPLIED. Requires separate owner approval.
-- Phase 3: forward paper trading ledger. Every fill recorded here is SIMULATED from public candles; nothing in this
-- migration can reach an exchange, the demo wallet, exchange connections, credentials, real orders, positions,
-- trades, risk_settings, bots, Autopilot or Futures.
--
-- Guarantees
--  * Separate paper accounts, strategies, per-candle signal records, order/fill events and settled trades. No foreign
--    key or trigger touches any real-trading or wallet table.
--  * paper_bars, paper_order_events and paper_trades are append-only for every role (UPDATE, DELETE and TRUNCATE are
--    refused by triggers). Nobody can insert them directly: rows arrive only through paper_commit_bar.
--  * paper_commit_bar (service_role only) commits one closed candle atomically: it locks the paper account then the
--    strategy, requires the cursor the worker read (compare-and-set) and exactly the next candle, refuses candles that
--    have not closed yet, reconciles cash against the sum of fill cash flows, refuses negative cash, refuses entry
--    fills while the strategy is not active or the account is halted, and re-checks account exposure, open positions,
--    maximum position size and realized daily loss. A crash before COMMIT leaves nothing behind.
--  * A paper strategy's identity, frozen strategy config (SHA-256 set by the database), cost assumptions, risk policy,
--    starting capital and start time can never change; its ledger columns change only inside paper_commit_bar; a
--    stopped strategy stays stopped; strategies and accounts can never be deleted.
--  * Browser roles can only read their own rows (MFA-aware); they cannot write anything. service_role may create
--    accounts/strategies and change limits, halt and status only.
-- =====================================================================================================

CREATE TABLE public.paper_accounts (
  user_id uuid PRIMARY KEY,
  max_exposure numeric NOT NULL DEFAULT 1000 CHECK (max_exposure > 0),
  max_daily_loss numeric NOT NULL DEFAULT 50 CHECK (max_daily_loss > 0),
  max_open_positions integer NOT NULL DEFAULT 3 CHECK (max_open_positions BETWEEN 1 AND 50),
  max_position_notional numeric NOT NULL DEFAULT 500 CHECK (max_position_notional > 0),
  halted boolean NOT NULL DEFAULT false,
  halted_at timestamptz,
  halt_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.paper_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.paper_accounts(user_id),
  strategy_id uuid NOT NULL,
  strategy_name text NOT NULL CHECK (length(strategy_name) BETWEEN 1 AND 200),
  config jsonb NOT NULL,
  config_sha256 text NOT NULL,
  engine_version text NOT NULL CHECK (engine_version = 'forward-paper-v1'),
  data_source text NOT NULL CHECK (data_source = 'binance-public-spot-klines'),
  pair text NOT NULL CHECK (pair ~ '^[A-Z0-9]{2,12}/[A-Z0-9]{2,12}$'),
  timeframe text NOT NULL CHECK (timeframe IN ('1m','5m','15m','30m','1h','4h','1d')),
  tf_ms bigint NOT NULL,
  market text NOT NULL DEFAULT 'spot' CHECK (market = 'spot'),
  costs jsonb NOT NULL,
  risk jsonb NOT NULL,
  starting_capital numeric NOT NULL CHECK (starting_capital > 0 AND starting_capital <= 1000000),
  started_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','stopped')),
  status_reason text,
  cursor_t bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  cash numeric NOT NULL DEFAULT 0 CHECK (cash >= 0),
  equity numeric NOT NULL DEFAULT 0,
  open_exposure numeric NOT NULL DEFAULT 0 CHECK (open_exposure >= 0),
  open_positions integer NOT NULL DEFAULT 0 CHECK (open_positions BETWEEN 0 AND 1),
  day_utc date,
  day_net numeric NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  data_status text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX paper_strategies_one_running ON public.paper_strategies (user_id, strategy_id, pair, timeframe) WHERE status <> 'stopped';
CREATE INDEX paper_strategies_user ON public.paper_strategies (user_id);

-- One immutable record per processed closed candle: the market snapshot, the signal and the decision.
CREATE TABLE public.paper_bars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_strategy_id uuid NOT NULL REFERENCES public.paper_strategies(id),
  user_id uuid NOT NULL,
  bar_t bigint NOT NULL,
  candle jsonb NOT NULL,
  signal text NOT NULL CHECK (signal IN ('none','enter_long','exit','rejected','halted')),
  decision jsonb NOT NULL,
  cash numeric NOT NULL,
  equity numeric NOT NULL,
  position_qty numeric NOT NULL CHECK (position_qty >= 0),
  unrealized numeric NOT NULL,
  data_source text NOT NULL,
  data_fetched_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (paper_strategy_id, bar_t)
);
CREATE INDEX paper_bars_user ON public.paper_bars (user_id, paper_strategy_id, bar_t DESC);

-- Every simulated order event: creation, fills, partial fills, cancellations, expiries and rejections.
CREATE TABLE public.paper_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_strategy_id uuid NOT NULL REFERENCES public.paper_strategies(id),
  user_id uuid NOT NULL,
  bar_t bigint NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0),
  order_key text NOT NULL,
  event text NOT NULL CHECK (event IN ('created','filled','partially_filled','cancelled','expired','rejected')),
  intent text NOT NULL CHECK (intent IN ('entry','exit')),
  kind text NOT NULL CHECK (kind IN ('market','limit','stop','take_profit')),
  side text NOT NULL CHECK (side IN ('buy','sell')),
  qty numeric NOT NULL CHECK (qty >= 0),
  price numeric CHECK (price IS NULL OR price > 0),
  fee numeric NOT NULL DEFAULT 0 CHECK (fee >= 0),
  spread_cost numeric NOT NULL DEFAULT 0 CHECK (spread_cost >= 0),
  slippage_cost numeric NOT NULL DEFAULT 0 CHECK (slippage_cost >= 0),
  cash_delta numeric NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT '',
  simulated boolean NOT NULL DEFAULT true CHECK (simulated),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (paper_strategy_id, bar_t, seq),
  CHECK (CASE WHEN event IN ('filled','partially_filled') THEN price IS NOT NULL AND qty > 0 AND cash_delta <> 0 ELSE cash_delta = 0 END)
);
CREATE INDEX paper_order_events_user ON public.paper_order_events (user_id, paper_strategy_id, bar_t DESC);

-- Settled round trips (simulated). net = gross - fees; gross already includes spread and slippage in fill prices.
CREATE TABLE public.paper_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_strategy_id uuid NOT NULL REFERENCES public.paper_strategies(id),
  user_id uuid NOT NULL,
  position_key text NOT NULL UNIQUE,
  opened_bar_t bigint NOT NULL,
  closed_bar_t bigint NOT NULL CHECK (closed_bar_t >= opened_bar_t),
  qty numeric NOT NULL CHECK (qty > 0),
  avg_entry numeric NOT NULL CHECK (avg_entry > 0),
  avg_exit numeric NOT NULL CHECK (avg_exit > 0),
  gross_pnl numeric NOT NULL,
  fees numeric NOT NULL CHECK (fees >= 0),
  spread_cost numeric NOT NULL CHECK (spread_cost >= 0),
  slippage_cost numeric NOT NULL CHECK (slippage_cost >= 0),
  net_pnl numeric NOT NULL,
  close_reason text NOT NULL,
  simulated boolean NOT NULL DEFAULT true CHECK (simulated),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (abs(net_pnl - (gross_pnl - fees)) < 0.000001)
);
CREATE INDEX paper_trades_user ON public.paper_trades (user_id, paper_strategy_id, closed_bar_t DESC);

-- ---------- guards ----------
CREATE FUNCTION public.paper_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  RAISE EXCEPTION 'paper trading history is append-only (% on %)', TG_OP, TG_TABLE_NAME;
END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['paper_bars','paper_order_events','paper_trades'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.paper_history_immutable()', t || '_immutable', t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.paper_history_immutable()', t || '_no_truncate', t);
END LOOP; END $$;
CREATE TRIGGER paper_strategies_no_truncate BEFORE TRUNCATE ON public.paper_strategies FOR EACH STATEMENT EXECUTE FUNCTION public.paper_history_immutable();
CREATE TRIGGER paper_accounts_no_truncate BEFORE TRUNCATE ON public.paper_accounts FOR EACH STATEMENT EXECUTE FUNCTION public.paper_history_immutable();

CREATE FUNCTION public.guard_paper_account() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'paper accounts cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN RAISE EXCEPTION 'paper account owner cannot change'; END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  NEW.updated_at := now();
  IF NEW.halted AND (TG_OP = 'INSERT' OR NOT OLD.halted) THEN NEW.halted_at := now(); END IF;
  IF NOT NEW.halted THEN NEW.halted_at := NULL; NEW.halt_reason := NULL; END IF;
  IF NEW.halted AND TG_OP = 'UPDATE' AND OLD.halted THEN NEW.halted_at := OLD.halted_at; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER paper_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON public.paper_accounts FOR EACH ROW EXECUTE FUNCTION public.guard_paper_account();

CREATE FUNCTION public.guard_paper_strategy() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE v_now bigint := floor(extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'paper strategies cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.tf_ms := CASE NEW.timeframe WHEN '1m' THEN 60000 WHEN '5m' THEN 300000 WHEN '15m' THEN 900000 WHEN '30m' THEN 1800000
                   WHEN '1h' THEN 3600000 WHEN '4h' THEN 14400000 WHEN '1d' THEN 86400000 END;
    NEW.config_sha256 := encode(sha256(convert_to(NEW.config::text, 'UTF8')), 'hex');
    NEW.started_at := now(); NEW.created_at := now(); NEW.status := 'active'; NEW.status_reason := NULL;
    -- First candle it may act on is the first that opens at or after the start: no decision uses an earlier candle.
    NEW.cursor_t := ((v_now + NEW.tf_ms - 1) / NEW.tf_ms) * NEW.tf_ms - NEW.tf_ms;
    NEW.cash := NEW.starting_capital; NEW.equity := NEW.starting_capital; NEW.open_exposure := 0; NEW.open_positions := 0;
    NEW.day_utc := NULL; NEW.day_net := 0; NEW.state_version := 0; NEW.last_checked_at := NULL; NEW.data_status := NULL;
    IF (NEW.state->>'cash')::numeric IS DISTINCT FROM NEW.starting_capital OR NEW.state->'position' <> 'null'::jsonb
       OR jsonb_array_length(NEW.state->'orders') <> 0 THEN
      RAISE EXCEPTION 'a paper strategy must start flat with its starting capital in cash';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.user_id, NEW.strategy_id, NEW.strategy_name, NEW.config, NEW.config_sha256, NEW.engine_version, NEW.data_source,
      NEW.pair, NEW.timeframe, NEW.tf_ms, NEW.market, NEW.costs, NEW.risk, NEW.starting_capital, NEW.started_at, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.strategy_id, OLD.strategy_name, OLD.config, OLD.config_sha256, OLD.engine_version, OLD.data_source,
      OLD.pair, OLD.timeframe, OLD.tf_ms, OLD.market, OLD.costs, OLD.risk, OLD.starting_capital, OLD.started_at, OLD.created_at) THEN
    RAISE EXCEPTION 'paper strategy identity, config, costs and risk policy are frozen';
  END IF;
  IF (NEW.cursor_t, NEW.state, NEW.state_version, NEW.cash, NEW.equity, NEW.open_exposure, NEW.open_positions, NEW.day_utc, NEW.day_net)
     IS DISTINCT FROM (OLD.cursor_t, OLD.state, OLD.state_version, OLD.cash, OLD.equity, OLD.open_exposure, OLD.open_positions, OLD.day_utc, OLD.day_net)
     AND coalesce(current_setting('paper.commit', true), '') <> 'on' THEN
    RAISE EXCEPTION 'paper ledger columns change only through paper_commit_bar';
  END IF;
  IF OLD.status = 'stopped' AND NEW.status <> 'stopped' THEN RAISE EXCEPTION 'a stopped paper strategy cannot restart'; END IF;
  IF NEW.status = 'stopped' AND OLD.status <> 'stopped' AND OLD.open_positions > 0 THEN
    RAISE EXCEPTION 'close the open paper position before stopping';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paper_strategies_guard BEFORE INSERT OR UPDATE OR DELETE ON public.paper_strategies FOR EACH ROW EXECUTE FUNCTION public.guard_paper_strategy();

-- ---------- atomic commit of one closed candle ----------
CREATE FUNCTION public.paper_commit_bar(p_strategy uuid, p_expected_cursor bigint, p_payload jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user uuid; a public.paper_accounts%ROWTYPE; s public.paper_strategies%ROWTYPE;
  b jsonb := p_payload->'bar'; v_bar bigint; v_cash numeric; v_delta numeric; v_entry_fills integer; v_exit_fills integer;
  v_trades integer; v_other_exp numeric; v_other_pos integer; v_other_day numeric; v_day date; v_now bigint := floor(extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  SELECT user_id INTO v_user FROM public.paper_strategies WHERE id = p_strategy;
  IF NOT FOUND THEN RAISE EXCEPTION 'paper_strategy_missing'; END IF;
  -- Lock order everywhere: account, then strategy. All of one owner's strategies commit one at a time.
  SELECT * INTO a FROM public.paper_accounts WHERE user_id = v_user FOR UPDATE;
  SELECT * INTO s FROM public.paper_strategies WHERE id = p_strategy FOR UPDATE;
  IF s.status = 'stopped' THEN RAISE EXCEPTION 'paper_strategy_stopped'; END IF;
  IF s.cursor_t <> p_expected_cursor THEN RAISE EXCEPTION 'paper_cursor_conflict'; END IF;
  v_bar := (b->>'bar_t')::bigint;
  IF v_bar IS DISTINCT FROM s.cursor_t + s.tf_ms THEN RAISE EXCEPTION 'paper_bar_out_of_sequence'; END IF;
  IF v_bar + s.tf_ms > v_now THEN RAISE EXCEPTION 'paper_bar_not_closed'; END IF;
  v_cash := (b->>'cash')::numeric;
  IF v_cash IS NULL OR v_cash < 0 THEN RAISE EXCEPTION 'paper_negative_cash'; END IF;
  IF (p_payload->'state'->>'cash')::numeric IS DISTINCT FROM v_cash THEN RAISE EXCEPTION 'paper_state_mismatch'; END IF;
  SELECT coalesce(sum((x->>'cash_delta')::numeric), 0),
         count(*) FILTER (WHERE x->>'intent' = 'entry' AND x->>'event' IN ('filled','partially_filled')),
         count(*) FILTER (WHERE x->>'intent' = 'exit' AND x->>'event' IN ('filled','partially_filled'))
    INTO v_delta, v_entry_fills, v_exit_fills FROM jsonb_array_elements(coalesce(p_payload->'events', '[]'::jsonb)) x;
  IF abs(s.cash + v_delta - v_cash) > 0.000001 THEN RAISE EXCEPTION 'paper_cash_mismatch'; END IF;
  v_trades := jsonb_array_length(coalesce(p_payload->'trades', '[]'::jsonb));
  IF v_trades > 0 AND v_exit_fills = 0 THEN RAISE EXCEPTION 'paper_settlement_without_exit_fill'; END IF;
  v_day := (b->>'day_utc')::date;
  IF v_entry_fills > 0 THEN
    IF s.status <> 'active' OR a.halted THEN RAISE EXCEPTION 'paper_entry_blocked'; END IF;
    SELECT coalesce(sum(open_exposure), 0), coalesce(sum(open_positions), 0), coalesce(sum(day_net) FILTER (WHERE day_utc = v_day), 0)
      INTO v_other_exp, v_other_pos, v_other_day FROM public.paper_strategies WHERE user_id = v_user AND id <> s.id;
    IF v_other_exp + (b->>'open_exposure')::numeric > a.max_exposure + 0.000001 THEN RAISE EXCEPTION 'paper_risk_conflict: account exposure'; END IF;
    IF v_other_pos + (b->>'open_positions')::integer > a.max_open_positions THEN RAISE EXCEPTION 'paper_risk_conflict: open positions'; END IF;
    IF (b->>'open_exposure')::numeric > a.max_position_notional + 0.000001 THEN RAISE EXCEPTION 'paper_risk_conflict: position size'; END IF;
    IF s.day_utc = v_day THEN v_other_day := v_other_day + s.day_net; END IF;
    IF v_other_day <= -a.max_daily_loss THEN RAISE EXCEPTION 'paper_risk_conflict: daily loss'; END IF;
  END IF;

  INSERT INTO public.paper_bars (paper_strategy_id, user_id, bar_t, candle, signal, decision, cash, equity, position_qty, unrealized, data_source, data_fetched_at)
  VALUES (s.id, s.user_id, v_bar, b->'candle', b->>'signal', b->'decision', v_cash, (b->>'equity')::numeric, (b->>'position_qty')::numeric,
          (b->>'unrealized')::numeric, s.data_source, to_timestamp(((p_payload->>'data_fetched_at')::bigint) / 1000.0));
  INSERT INTO public.paper_order_events (paper_strategy_id, user_id, bar_t, seq, order_key, event, intent, kind, side, qty, price, fee, spread_cost, slippage_cost, cash_delta, reason)
  SELECT s.id, s.user_id, v_bar, x.seq, x.order_key, x.event, x.intent, x.kind, x.side, x.qty, x.price, x.fee, x.spread_cost, x.slippage_cost, x.cash_delta, coalesce(x.reason, '')
    FROM jsonb_to_recordset(coalesce(p_payload->'events', '[]'::jsonb)) AS x(seq integer, order_key text, event text, intent text, kind text, side text, qty numeric, price numeric, fee numeric, spread_cost numeric, slippage_cost numeric, cash_delta numeric, reason text);
  INSERT INTO public.paper_trades (paper_strategy_id, user_id, position_key, opened_bar_t, closed_bar_t, qty, avg_entry, avg_exit, gross_pnl, fees, spread_cost, slippage_cost, net_pnl, close_reason)
  SELECT s.id, s.user_id, x.position_key, x.opened_bar_t, x.closed_bar_t, x.qty, x.avg_entry, x.avg_exit, x.gross_pnl, x.fees, x.spread_cost, x.slippage_cost, x.net_pnl, x.close_reason
    FROM jsonb_to_recordset(coalesce(p_payload->'trades', '[]'::jsonb)) AS x(position_key text, opened_bar_t bigint, closed_bar_t bigint, qty numeric, avg_entry numeric, avg_exit numeric, gross_pnl numeric, fees numeric, spread_cost numeric, slippage_cost numeric, net_pnl numeric, close_reason text);

  PERFORM set_config('paper.commit', 'on', true);
  UPDATE public.paper_strategies SET cursor_t = v_bar, state = p_payload->'state', state_version = state_version + 1, cash = v_cash,
    equity = (b->>'equity')::numeric, open_exposure = (b->>'open_exposure')::numeric, open_positions = (b->>'open_positions')::integer,
    day_utc = v_day, day_net = (b->>'day_net')::numeric, last_checked_at = now()
  WHERE id = s.id;
  PERFORM set_config('paper.commit', 'off', true);
  RETURN v_bar;
END $$;

-- ---------- privileges and row security ----------
REVOKE ALL ON public.paper_accounts, public.paper_strategies, public.paper_bars, public.paper_order_events, public.paper_trades FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.paper_accounts, public.paper_strategies, public.paper_bars, public.paper_order_events, public.paper_trades TO authenticated, service_role;
GRANT INSERT, UPDATE ON public.paper_accounts, public.paper_strategies TO service_role;
ALTER TABLE public.paper_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_strategies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_bars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY paper_accounts_owner_read ON public.paper_accounts FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY paper_strategies_owner_read ON public.paper_strategies FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY paper_bars_owner_read ON public.paper_bars FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY paper_order_events_owner_read ON public.paper_order_events FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY paper_trades_owner_read ON public.paper_trades FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());

REVOKE ALL ON FUNCTION public.paper_history_immutable(), public.guard_paper_account(), public.guard_paper_strategy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.paper_commit_bar(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paper_commit_bar(uuid, bigint, jsonb) TO service_role;
