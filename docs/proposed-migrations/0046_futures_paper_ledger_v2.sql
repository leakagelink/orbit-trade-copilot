-- =====================================================================================================================
-- 0046 — DRAFT ONLY. NOT APPLIED. PROPOSED NUMBER; the final number is assigned at owner approval.
-- Reviewed SUCCESSOR of draft 0045 (Futures paper ledger + strategy budgets). It SUPERSEDES 0045: it is standalone,
-- creates every object itself, and must never be applied together with 0045 (same table names; it fails if 0045 exists).
-- Sequence evidence (12 Nov 2026): Drizzle history ends at 0039_futures_pass_certification_and_autopilot_fencing;
-- drafts 0040–0045 in docs/proposed-migrations are unapplied. 0046 is the next free draft number, not an applied order.
--
-- Everything recorded here is SIMULATED from public market data. Nothing references or can reach an exchange,
-- credentials, real orders/positions/trades, risk_settings, futures_settings, the demo wallet, the Spot paper ledger
-- (0044), bots, Autopilot or Live Futures.
--
-- Corrections relative to 0045 (see docs/phase-4c/migration-0046-design-review.md):
--  1. Null inputs: every argument is required; the sequence check is NULL-safe (IS DISTINCT FROM).
--  2. Wallet/state fields: strict JSON typing (numbers must be JSON numbers, state an object with version, wallet,
--     seq, halted, positions, pending); numeric columns reject NaN/±Infinity; account creation checks missing keys.
--  3. Commit-time strategy budget: every entry fill locks the (owner, strategy, 'paper') budget row and re-checks
--     closed losses + reserved open risk + the fill's risk across ALL the owner's paper accounts. No budget → refused.
--  4/5. Pending fills are re-validated at commit: active + not halted, daily loss (realized today + negative unrealized
--     at supplied marks), account exposure, position count, free margin and strategy budget.
--  6. Atomic valid state: all checks run before COMMIT; any failure rolls back every write of the candle.
--  7. Wallet reconciliation: per-event kind arithmetic is a table CHECK, the database keeps its own position book and the
--     submitted state must match it (side, quantity, margin, strategy) and the ledger wallet and sequence.
--  8. Crash recovery: one commit record per (account, candle) with the payload hash — a retried identical payload
--     returns the original result without writing; a different payload for a committed candle is refused; fills carry
--     unique fill ids so a fill can never be recorded twice.
-- Preserved from 0045: owner-only MFA-aware reads, service-role boundaries, append-only events, duplicate-candle and
-- closed-candle checks, halted-account entry refusal, one-account lock + compare-and-set, production-table isolation.
-- =====================================================================================================================

-- ---------- strict value helpers ----------
CREATE FUNCTION public.fp2_finite(x numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT x IS NOT NULL AND x <> 'NaN'::numeric AND x > '-Infinity'::numeric AND x < 'Infinity'::numeric
$$;
CREATE FUNCTION public.fp2_num(j jsonb, k text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $$
BEGIN
  IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR jsonb_typeof(j->k) IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'futures paper: % must be a JSON number', k USING ERRCODE = '22023';
  END IF;
  RETURN (j->>k)::numeric;
END $$;
CREATE FUNCTION public.fp2_int(j jsonb, k text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $$
DECLARE v numeric := public.fp2_num(j, k);
BEGIN
  IF v <> trunc(v) THEN RAISE EXCEPTION 'futures paper: % must be an integer', k USING ERRCODE = '22023'; END IF;
  RETURN v::bigint;
END $$;
CREATE FUNCTION public.fp2_txt(j jsonb, k text, nullable boolean) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $$
BEGIN
  IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'futures paper: object expected for %', k USING ERRCODE = '22023'; END IF;
  IF nullable AND (j->k IS NULL OR jsonb_typeof(j->k) = 'null') THEN RETURN NULL; END IF;
  IF jsonb_typeof(j->k) IS DISTINCT FROM 'string' OR length(j->>k) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'futures paper: % must be a non-empty string', k USING ERRCODE = '22023';
  END IF;
  RETURN j->>k;
END $$;

-- ---------- tables ----------
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
  starting_balance numeric NOT NULL CHECK (public.fp2_finite(starting_balance) AND starting_balance > 0 AND starting_balance <= 1000000),
  limit_max_daily_loss numeric NOT NULL CHECK (public.fp2_finite(limit_max_daily_loss) AND limit_max_daily_loss > 0),
  limit_max_exposure numeric NOT NULL CHECK (public.fp2_finite(limit_max_exposure) AND limit_max_exposure > 0),
  limit_max_positions integer NOT NULL CHECK (limit_max_positions BETWEEN 1 AND 2),
  wallet numeric NOT NULL CHECK (public.fp2_finite(wallet) AND wallet >= 0),
  seq bigint NOT NULL DEFAULT 0 CHECK (seq >= 0),
  cursor_t bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','stopped')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
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
  qty numeric NOT NULL,
  price numeric,
  fee numeric NOT NULL,
  pnl numeric NOT NULL,
  wallet_delta numeric NOT NULL,
  margin_delta numeric NOT NULL,
  wallet_after numeric NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  proposal_id text,
  strategy_id text CHECK (strategy_id IS NULL OR length(strategy_id) BETWEEN 1 AND 200),
  fill_id text CHECK (fill_id IS NULL OR length(fill_id) BETWEEN 1 AND 300),
  risk_amount numeric,
  simulated boolean NOT NULL DEFAULT true CHECK (simulated),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, seq),
  CONSTRAINT futures_paper_event_numbers CHECK (
    public.fp2_finite(qty) AND qty >= 0 AND public.fp2_finite(fee) AND fee >= 0 AND public.fp2_finite(pnl)
    AND public.fp2_finite(wallet_delta) AND public.fp2_finite(margin_delta) AND public.fp2_finite(wallet_after) AND wallet_after >= 0
    AND (price IS NULL OR (public.fp2_finite(price) AND price > 0))
    AND (risk_amount IS NULL OR (public.fp2_finite(risk_amount) AND risk_amount >= 0))),
  -- Per-kind cash arithmetic (relative tolerance 1e-9 for binary floating-point input).
  CONSTRAINT futures_paper_event_kind_shape CHECK (CASE kind
    WHEN 'entry_fill' THEN side IS NOT NULL AND qty > 0 AND price IS NOT NULL AND pnl = 0 AND margin_delta > 0
      AND abs(wallet_delta + fee) <= 1e-9 * greatest(1, fee)
      AND strategy_id IS NOT NULL AND proposal_id IS NOT NULL AND fill_id IS NOT NULL AND risk_amount IS NOT NULL
    WHEN 'exit_fill' THEN side IS NOT NULL AND qty > 0 AND price IS NOT NULL AND margin_delta <= 0
      AND abs(wallet_delta - (pnl - fee)) <= 1e-9 * greatest(1, abs(pnl), fee) AND strategy_id IS NOT NULL AND fill_id IS NOT NULL AND risk_amount IS NULL
    WHEN 'liquidation' THEN side IS NOT NULL AND qty > 0 AND fee = 0 AND pnl <= 0
      AND abs(wallet_delta - pnl) <= 1e-9 * greatest(1, abs(pnl)) AND abs(margin_delta - pnl) <= 1e-9 * greatest(1, abs(pnl))
      AND strategy_id IS NOT NULL AND fill_id IS NOT NULL AND risk_amount IS NULL
    WHEN 'funding' THEN side IS NOT NULL AND qty > 0 AND fee = 0 AND pnl = 0
      AND abs(wallet_delta - margin_delta) <= 1e-9 * greatest(1, abs(wallet_delta)) AND strategy_id IS NOT NULL AND fill_id IS NULL AND risk_amount IS NULL
    ELSE wallet_delta = 0 AND margin_delta = 0 AND fee = 0 AND pnl = 0 AND fill_id IS NULL AND risk_amount IS NULL END)
);
CREATE INDEX futures_paper_events_user ON public.futures_paper_events (user_id, account_id, bar_t DESC);
CREATE INDEX futures_paper_events_bar ON public.futures_paper_events (account_id, bar_t);
CREATE INDEX futures_paper_events_strategy ON public.futures_paper_events (user_id, strategy_id, account_id, proposal_id);
CREATE UNIQUE INDEX futures_paper_events_fill_once ON public.futures_paper_events (account_id, fill_id) WHERE fill_id IS NOT NULL;

-- The database's own position book (one-way mode: at most one position per symbol). Written only by the commit function.
CREATE TABLE public.futures_paper_positions (
  account_id uuid NOT NULL REFERENCES public.futures_paper_accounts(id),
  user_id uuid NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT','ETHUSDT')),
  side text NOT NULL CHECK (side IN ('LONG','SHORT')),
  qty numeric NOT NULL CHECK (public.fp2_finite(qty) AND qty > 0),
  entry_price numeric NOT NULL CHECK (public.fp2_finite(entry_price) AND entry_price > 0),
  margin numeric NOT NULL CHECK (public.fp2_finite(margin)),
  risk_reserved numeric NOT NULL CHECK (public.fp2_finite(risk_reserved) AND risk_reserved >= 0),
  strategy_id text NOT NULL,
  proposal_id text NOT NULL,
  opened_bar_t bigint NOT NULL,
  updated_seq bigint NOT NULL,
  PRIMARY KEY (account_id, symbol)
);
CREATE INDEX futures_paper_positions_strategy ON public.futures_paper_positions (user_id, strategy_id);

-- One record per committed candle: crash-recovery idempotency (payload hash) and an audit trail.
CREATE TABLE public.futures_paper_commits (
  account_id uuid NOT NULL REFERENCES public.futures_paper_accounts(id),
  bar_t bigint NOT NULL,
  user_id uuid NOT NULL,
  expected_seq bigint NOT NULL,
  seq_to bigint NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, bar_t)
);

CREATE TABLE public.strategy_risk_budgets (
  user_id uuid NOT NULL,
  strategy_id text NOT NULL CHECK (length(strategy_id) BETWEEN 1 AND 200),
  environment text NOT NULL CHECK (environment IN ('paper','testnet','production')),
  max_loss numeric NOT NULL CHECK (public.fp2_finite(max_loss) AND max_loss > 0 AND max_loss <= 1000000),
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
CREATE TRIGGER futures_paper_commits_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_commits FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_commits_no_truncate BEFORE TRUNCATE ON public.futures_paper_commits FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_accounts_no_truncate BEFORE TRUNCATE ON public.futures_paper_accounts FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_positions_no_truncate BEFORE TRUNCATE ON public.futures_paper_positions FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();

-- True only inside futures_paper_commit_bar_v2 (the function owner sets a transaction-local flag; API roles cannot).
CREATE FUNCTION public.futures_paper_in_commit() RETURNS boolean
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT coalesce(current_setting('futures_paper.commit', true), '') = 'on'
     AND current_user NOT IN ('anon', 'authenticated', 'service_role', 'authenticator')
$$;

CREATE FUNCTION public.guard_futures_paper_account() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE v_now bigint := floor(extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'futures paper accounts cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF jsonb_typeof(NEW.config) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.config->'limits') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'futures paper config must be an object with limits';
    END IF;
    IF public.fp2_num(NEW.config, 'startingBalance') IS DISTINCT FROM NEW.starting_balance THEN RAISE EXCEPTION 'config.startingBalance must equal starting_balance'; END IF;
    NEW.limit_max_daily_loss := public.fp2_num(NEW.config->'limits', 'maxDailyLoss');
    NEW.limit_max_exposure := public.fp2_num(NEW.config->'limits', 'maxExposure');
    NEW.limit_max_positions := public.fp2_int(NEW.config->'limits', 'maxPositions');
    NEW.tf_ms := CASE NEW.timeframe WHEN '1m' THEN 60000 WHEN '5m' THEN 300000 WHEN '15m' THEN 900000 END;
    NEW.config_sha256 := encode(sha256(convert_to(NEW.config::text, 'UTF8')), 'hex');
    NEW.created_at := now(); NEW.updated_at := now(); NEW.status := 'active'; NEW.status_reason := NULL; NEW.halted := false;
    NEW.wallet := NEW.starting_balance; NEW.seq := 0;
    NEW.cursor_t := ((v_now + NEW.tf_ms - 1) / NEW.tf_ms) * NEW.tf_ms - NEW.tf_ms; -- forward only
    -- Missing keys are refused (0045 compared with <>, which let a missing key through as NULL).
    IF jsonb_typeof(NEW.state) IS DISTINCT FROM 'object'
       OR NEW.state->>'version' IS DISTINCT FROM NEW.engine_version
       OR public.fp2_num(NEW.state, 'wallet') IS DISTINCT FROM NEW.starting_balance
       OR public.fp2_int(NEW.state, 'seq') IS DISTINCT FROM 0
       OR NEW.state->'halted' IS DISTINCT FROM 'false'::jsonb
       OR NEW.state->'positions' IS DISTINCT FROM '{}'::jsonb
       OR NEW.state->'pending' IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'a futures paper account must start flat with its starting balance';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.user_id, NEW.engine_version, NEW.data_source, NEW.symbols, NEW.timeframe, NEW.tf_ms, NEW.config, NEW.config_sha256, NEW.starting_balance,
      NEW.limit_max_daily_loss, NEW.limit_max_exposure, NEW.limit_max_positions, NEW.created_at, NEW.simulated)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.engine_version, OLD.data_source, OLD.symbols, OLD.timeframe, OLD.tf_ms, OLD.config, OLD.config_sha256, OLD.starting_balance,
      OLD.limit_max_daily_loss, OLD.limit_max_exposure, OLD.limit_max_positions, OLD.created_at, OLD.simulated) THEN
    RAISE EXCEPTION 'futures paper account identity, config, limits and starting balance are frozen';
  END IF;
  IF (NEW.wallet, NEW.seq, NEW.cursor_t, NEW.state) IS DISTINCT FROM (OLD.wallet, OLD.seq, OLD.cursor_t, OLD.state) AND NOT public.futures_paper_in_commit() THEN
    RAISE EXCEPTION 'futures paper ledger columns change only through futures_paper_commit_bar_v2';
  END IF;
  IF OLD.status = 'stopped' AND NEW.status <> 'stopped' THEN RAISE EXCEPTION 'a stopped futures paper account stays stopped'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER futures_paper_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON public.futures_paper_accounts FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_account();

CREATE FUNCTION public.guard_futures_paper_book() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.futures_paper_in_commit() THEN RAISE EXCEPTION 'the futures paper position book changes only through futures_paper_commit_bar_v2'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER futures_paper_positions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.futures_paper_positions FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_book();
CREATE TRIGGER futures_paper_commits_guard BEFORE INSERT ON public.futures_paper_commits FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_book();

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
CREATE TRIGGER strategy_risk_budgets_no_truncate BEFORE TRUNCATE ON public.strategy_risk_budgets FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();

-- ---------- atomic, re-validating, idempotent per-candle commit ----------
CREATE FUNCTION public.futures_paper_commit_bar_v2(p_account uuid, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  a public.futures_paper_accounts%ROWTYPE;
  b public.futures_paper_positions%ROWTYPE;
  c public.futures_paper_commits%ROWTYPE;
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  tol constant numeric := 0.000001;
  v_hash text; st jsonb; mk jsonb; e jsonb; pj jsonb; k text;
  v_wallet numeric; v_seq bigint; v_found boolean;
  v_kind text; v_sym text; v_side text; v_qty numeric; v_price numeric; v_fee numeric; v_pnl numeric; v_wd numeric; v_md numeric; v_t bigint;
  v_strat text; v_prop text; v_fill text; v_risk numeric;
  v_day numeric; v_unreal numeric; v_expo numeric; v_count bigint; v_used numeric; v_reserved numeric; v_budget numeric; v_margin numeric;
BEGIN
  IF p_account IS NULL OR p_expected_seq IS NULL OR p_bar_t IS NULL OR p_payload IS NULL THEN
    RAISE EXCEPTION 'futures paper commit: account, expected sequence, candle and payload are all required';
  END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'events') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_payload->'state') IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'marks') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'futures paper commit: payload must contain events[], state{} and marks{}';
  END IF;
  SELECT * INTO a FROM public.futures_paper_accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'futures paper account not found'; END IF;

  -- Crash recovery: the same candle with the same payload returns the committed result and writes nothing.
  v_hash := encode(sha256(convert_to(p_expected_seq::text || ':' || p_bar_t::text || ':' || p_payload::text, 'UTF8')), 'hex');
  SELECT * INTO c FROM public.futures_paper_commits WHERE account_id = a.id AND bar_t = p_bar_t;
  IF FOUND THEN
    IF c.payload_sha256 = v_hash THEN RETURN c.seq_to; END IF;
    RAISE EXCEPTION 'candle % was already committed with a different payload', p_bar_t;
  END IF;

  IF a.status = 'stopped' THEN RAISE EXCEPTION 'futures paper account is stopped'; END IF;
  IF a.seq IS DISTINCT FROM p_expected_seq THEN RAISE EXCEPTION 'futures paper sequence moved (expected %, found %)', p_expected_seq, a.seq; END IF;
  IF p_bar_t <= a.cursor_t OR p_bar_t % a.tf_ms <> 0 THEN RAISE EXCEPTION 'candle % is not after the cursor %', p_bar_t, a.cursor_t; END IF;
  IF p_bar_t + a.tf_ms > v_now THEN RAISE EXCEPTION 'candle % has not closed yet', p_bar_t; END IF;
  st := p_payload->'state'; mk := p_payload->'marks';
  FOR k, pj IN SELECT * FROM jsonb_each(mk) LOOP
    IF NOT (k = ANY (a.symbols)) OR jsonb_typeof(pj) IS DISTINCT FROM 'number' OR (pj #>> '{}')::numeric <= 0 THEN
      RAISE EXCEPTION 'mark for % must be a positive number for an account symbol', k;
    END IF;
  END LOOP;

  -- Lock every strategy budget an entry fill will consume, in a fixed order (account row first, then budgets).
  PERFORM 1 FROM public.strategy_risk_budgets
   WHERE user_id = a.user_id AND environment = 'paper'
     AND strategy_id IN (SELECT x->>'strategy_id' FROM jsonb_array_elements(p_payload->'events') x WHERE x->>'kind' = 'entry_fill')
   ORDER BY strategy_id FOR UPDATE;

  v_wallet := a.wallet; v_seq := a.seq;
  PERFORM set_config('futures_paper.commit', 'on', true);
  FOR e IN SELECT * FROM jsonb_array_elements(p_payload->'events') LOOP
    IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'every event must be an object'; END IF;
    IF public.fp2_int(e, 'seq') IS DISTINCT FROM v_seq + 1 THEN RAISE EXCEPTION 'event sequence must be consecutive'; END IF;
    v_sym := public.fp2_txt(e, 'symbol', false);
    IF NOT (v_sym = ANY (a.symbols)) THEN RAISE EXCEPTION 'symbol % is not part of this account', v_sym; END IF;
    v_kind := public.fp2_txt(e, 'kind', false); v_side := public.fp2_txt(e, 'side', true);
    v_t := public.fp2_int(e, 't'); v_qty := public.fp2_num(e, 'qty'); v_fee := public.fp2_num(e, 'fee'); v_pnl := public.fp2_num(e, 'pnl');
    v_wd := public.fp2_num(e, 'wallet_delta'); v_md := public.fp2_num(e, 'margin_delta');
    v_price := CASE WHEN e->'price' IS NULL OR jsonb_typeof(e->'price') = 'null' THEN NULL ELSE public.fp2_num(e, 'price') END;
    v_prop := public.fp2_txt(e, 'proposal_id', true); v_fill := public.fp2_txt(e, 'fill_id', true); v_strat := public.fp2_txt(e, 'strategy_id', true);
    v_risk := CASE WHEN v_kind = 'entry_fill' THEN public.fp2_num(e, 'risk_amount') ELSE NULL END;
    IF v_t < p_bar_t OR v_t > p_bar_t + a.tf_ms THEN RAISE EXCEPTION 'event time % is outside candle %', v_t, p_bar_t; END IF;
    IF v_kind IN ('entry_fill', 'order_accepted') AND (a.status <> 'active' OR a.halted) THEN
      RAISE EXCEPTION 'entries are refused while the account is not active or is halted';
    END IF;
    SELECT * INTO b FROM public.futures_paper_positions WHERE account_id = a.id AND symbol = v_sym;
    v_found := FOUND;

    IF v_kind = 'entry_fill' THEN
      IF v_found AND (b.side IS DISTINCT FROM v_side OR b.strategy_id IS DISTINCT FROM v_strat OR b.proposal_id IS DISTINCT FROM v_prop) THEN
        RAISE EXCEPTION 'entry fill does not match the open % position', v_sym;
      END IF;
      -- Pending-fill re-validation 1: daily loss (today's realized cash incl. this candle so far + negative unrealized).
      SELECT coalesce(sum(wallet_delta), 0) INTO v_day FROM public.futures_paper_events WHERE account_id = a.id AND bar_t / 86400000 = p_bar_t / 86400000;
      SELECT coalesce(sum(least(0, (CASE p.side WHEN 'LONG' THEN 1 ELSE -1 END) * (public.fp2_num(mk, p.symbol) - p.entry_price) * p.qty)), 0)
        INTO v_unreal FROM public.futures_paper_positions p WHERE p.account_id = a.id;
      IF a.limit_max_daily_loss + least(0, v_day + v_unreal) <= 0 THEN RAISE EXCEPTION 'daily loss limit reached: entry fill refused'; END IF;
      -- Pending-fill re-validation 2: strategy budget across ALL the owner's paper accounts (row locked above).
      SELECT max_loss INTO v_budget FROM public.strategy_risk_budgets WHERE user_id = a.user_id AND strategy_id = v_strat AND environment = 'paper';
      IF NOT FOUND THEN RAISE EXCEPTION 'no paper risk budget for strategy %: entry fill refused', v_strat; END IF;
      SELECT coalesce(sum(greatest(0, -q.net)), 0) INTO v_used FROM (
        SELECT sum(ev.wallet_delta) AS net FROM public.futures_paper_events ev
         WHERE ev.user_id = a.user_id AND ev.strategy_id = v_strat AND ev.proposal_id IS NOT NULL
         GROUP BY ev.account_id, ev.proposal_id HAVING bool_or(ev.kind IN ('exit_fill', 'liquidation'))) q;
      SELECT coalesce(sum(p.risk_reserved), 0) INTO v_reserved FROM public.futures_paper_positions p WHERE p.user_id = a.user_id AND p.strategy_id = v_strat;
      IF v_used + v_reserved + v_risk > v_budget + tol THEN
        RAISE EXCEPTION 'strategy % budget % would be exceeded at fill (used %, reserved %, fill risk %)', v_strat, v_budget, v_used, v_reserved, v_risk;
      END IF;
    ELSIF v_kind IN ('funding', 'exit_fill', 'liquidation') THEN
      IF NOT v_found OR b.side IS DISTINCT FROM v_side THEN RAISE EXCEPTION '% event without a matching open % position', v_kind, v_sym; END IF;
      IF v_strat IS NOT NULL AND v_strat IS DISTINCT FROM b.strategy_id THEN RAISE EXCEPTION 'event strategy differs from the position strategy'; END IF;
      v_strat := b.strategy_id;
    END IF;

    v_seq := v_seq + 1; v_wallet := v_wallet + v_wd;
    IF v_wallet < 0 THEN RAISE EXCEPTION 'simulated wallet would go negative'; END IF;
    INSERT INTO public.futures_paper_events (account_id, seq, user_id, bar_t, t, symbol, kind, side, qty, price, fee, pnl, wallet_delta, margin_delta, wallet_after, reason, proposal_id, strategy_id, fill_id, risk_amount)
    VALUES (a.id, v_seq, a.user_id, p_bar_t, v_t, v_sym, v_kind, v_side, v_qty, v_price, v_fee, v_pnl, v_wd, v_md, v_wallet, public.fp2_txt(e, 'reason', false), v_prop,
            CASE WHEN v_kind IN ('entry_fill', 'funding', 'exit_fill', 'liquidation') THEN v_strat ELSE NULL END, v_fill, v_risk);

    IF v_kind = 'entry_fill' THEN
      IF v_found THEN
        UPDATE public.futures_paper_positions SET entry_price = (entry_price * qty + v_price * v_qty) / (qty + v_qty), qty = qty + v_qty,
               margin = margin + v_md, risk_reserved = risk_reserved + v_risk, updated_seq = v_seq WHERE account_id = a.id AND symbol = v_sym;
      ELSE
        INSERT INTO public.futures_paper_positions (account_id, user_id, symbol, side, qty, entry_price, margin, risk_reserved, strategy_id, proposal_id, opened_bar_t, updated_seq)
        VALUES (a.id, a.user_id, v_sym, v_side, v_qty, v_price, v_md, v_risk, v_strat, v_prop, p_bar_t, v_seq);
      END IF;
      -- Pending-fill re-validation 3: exposure, position count and free margin after the fill, at the supplied marks.
      SELECT coalesce(sum(p.qty * public.fp2_num(mk, p.symbol)), 0), count(*), coalesce(sum(p.margin), 0) INTO v_expo, v_count, v_margin
        FROM public.futures_paper_positions p WHERE p.account_id = a.id;
      IF v_expo > a.limit_max_exposure + tol THEN RAISE EXCEPTION 'exposure % would exceed % at fill', v_expo, a.limit_max_exposure; END IF;
      IF v_count > a.limit_max_positions THEN RAISE EXCEPTION 'position limit % exceeded at fill', a.limit_max_positions; END IF;
      IF v_wallet - v_margin < -tol THEN RAISE EXCEPTION 'free margin would be negative at fill'; END IF;
    ELSIF v_kind = 'funding' THEN
      UPDATE public.futures_paper_positions SET margin = margin + v_md, updated_seq = v_seq WHERE account_id = a.id AND symbol = v_sym;
    ELSIF v_kind IN ('exit_fill', 'liquidation') THEN
      IF abs(v_qty - b.qty) > tol * greatest(1, b.qty) THEN RAISE EXCEPTION 'close quantity % differs from the open quantity %', v_qty, b.qty; END IF;
      IF abs(v_md + b.margin) > tol * greatest(1, abs(b.margin)) THEN RAISE EXCEPTION 'close must release exactly the position margin'; END IF;
      DELETE FROM public.futures_paper_positions WHERE account_id = a.id AND symbol = v_sym;
    END IF;
  END LOOP;

  -- Submitted state must reconcile with the ledger and the database's own book.
  IF st->>'version' IS DISTINCT FROM a.engine_version OR jsonb_typeof(st->'positions') IS DISTINCT FROM 'object'
     OR jsonb_typeof(st->'pending') IS DISTINCT FROM 'object' OR jsonb_typeof(st->'halted') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'state must carry version, positions{}, pending{} and halted';
  END IF;
  IF (st->>'halted')::boolean IS DISTINCT FROM a.halted THEN RAISE EXCEPTION 'state halted flag differs from the account'; END IF;
  IF public.fp2_int(st, 'seq') IS DISTINCT FROM v_seq THEN RAISE EXCEPTION 'state sequence does not match the ledger'; END IF;
  IF abs(v_wallet - public.fp2_num(p_payload, 'wallet')) > tol OR abs(v_wallet - public.fp2_num(st, 'wallet')) > tol THEN
    RAISE EXCEPTION 'wallet does not reconcile with the event ledger';
  END IF;
  FOR k IN SELECT jsonb_object_keys(st->'positions') LOOP
    SELECT * INTO b FROM public.futures_paper_positions WHERE account_id = a.id AND symbol = k;
    IF NOT FOUND THEN RAISE EXCEPTION 'state has a % position the ledger does not', k; END IF;
    pj := st->'positions'->k;
    IF pj->>'side' IS DISTINCT FROM b.side OR pj->>'strategyId' IS DISTINCT FROM b.strategy_id
       OR abs(public.fp2_num(pj, 'qty') - b.qty) > tol * greatest(1, b.qty) OR abs(public.fp2_num(pj, 'margin') - b.margin) > tol * greatest(1, abs(b.margin)) THEN
      RAISE EXCEPTION 'state position % does not reconcile with the ledger', k;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.futures_paper_positions WHERE account_id = a.id) <> (SELECT count(*) FROM jsonb_object_keys(st->'positions')) THEN
    RAISE EXCEPTION 'the ledger has a position the state does not';
  END IF;
  FOR k IN SELECT jsonb_object_keys(st->'pending') LOOP
    IF NOT (k = ANY (a.symbols)) THEN RAISE EXCEPTION 'pending entry on a foreign symbol %', k; END IF;
  END LOOP;
  IF a.halted AND st->'pending' <> '{}'::jsonb THEN RAISE EXCEPTION 'a halted account cannot keep pending entries'; END IF;

  UPDATE public.futures_paper_accounts SET wallet = v_wallet, seq = v_seq, cursor_t = p_bar_t, state = st WHERE id = a.id;
  INSERT INTO public.futures_paper_commits (account_id, bar_t, user_id, expected_seq, seq_to, payload_sha256) VALUES (a.id, p_bar_t, a.user_id, p_expected_seq, v_seq, v_hash);
  PERFORM set_config('futures_paper.commit', 'off', true);
  RETURN v_seq;
END $$;

-- ---------- privileges and row security ----------
REVOKE ALL ON public.futures_paper_accounts, public.futures_paper_events, public.futures_paper_positions, public.futures_paper_commits, public.strategy_risk_budgets FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.futures_paper_accounts, public.futures_paper_events, public.futures_paper_positions, public.futures_paper_commits, public.strategy_risk_budgets TO authenticated, service_role;
GRANT INSERT, UPDATE ON public.futures_paper_accounts, public.strategy_risk_budgets TO service_role;
ALTER TABLE public.futures_paper_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy_risk_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_paper_accounts_owner_read ON public.futures_paper_accounts FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_events_owner_read ON public.futures_paper_events FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_positions_owner_read ON public.futures_paper_positions FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_commits_owner_read ON public.futures_paper_commits FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY strategy_risk_budgets_owner_read ON public.strategy_risk_budgets FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());

REVOKE ALL ON FUNCTION public.fp2_finite(numeric), public.fp2_num(jsonb, text), public.fp2_int(jsonb, text), public.fp2_txt(jsonb, text, boolean), public.futures_paper_in_commit(),
  public.futures_paper_history_immutable(), public.guard_futures_paper_account(), public.guard_futures_paper_book(), public.guard_strategy_risk_budget() FROM PUBLIC, anon, authenticated;
-- service_role writes accounts and budgets, whose CHECK constraints and INSERT trigger call these helpers.
GRANT EXECUTE ON FUNCTION public.fp2_finite(numeric), public.fp2_num(jsonb, text), public.fp2_int(jsonb, text), public.futures_paper_in_commit() TO service_role;
REVOKE ALL ON FUNCTION public.futures_paper_commit_bar_v2(uuid, bigint, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.futures_paper_commit_bar_v2(uuid, bigint, bigint, jsonb) TO service_role;
