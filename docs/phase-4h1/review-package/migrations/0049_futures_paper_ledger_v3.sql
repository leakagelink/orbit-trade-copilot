-- =====================================================================================================================
-- 0049 — DRAFT ONLY. NOT APPLIED. PROPOSED NUMBER; the final number is assigned at owner approval.
-- Replacement SUCCESSOR of draft 0046 (which the owner did NOT approve on 13 Nov 2026). It SUPERSEDES 0046 and 0045:
-- standalone, same table and helper names — it fails if 0045 or 0046 exists, and must never be applied with either.
--
-- Everything recorded here is SIMULATED from public market data. Nothing references or can reach an exchange,
-- credentials, real orders/positions/trades, risk_settings, futures_settings, the demo wallet, the Spot paper ledger
-- (0044), bots, Autopilot or Live Futures.
--
-- What 0049 fixes (owner decision 13 Nov 2026; findings C6/C7 in docs/phase-4e/paper-engine-accounting-review.md):
--  R1 (C6) The database never trusts a worker-supplied risk figure. A payload carrying `risk_amount` or `fill_id` is
--     refused. Approval risk, fill risk, fees, margin, funding cash, exit P&L and liquidation loss are RECOMPUTED here
--     from database-held data only: the account's frozen config (limits, costs, lot rules, maintenance margin), the
--     candle recorded in this same commit, the approval row and the database's own position book.
--  R2 (C7) No fill without a valid, matching risk approval. `order_accepted` creates an approval row only after the
--     database re-runs the risk checks itself; every `entry_fill` must match an OPEN approval of the same account,
--     proposal, strategy, symbol and side, approved in an EARLIER candle and not expired; Σ fills ≤ approved quantity;
--     the fill price must equal the taker price derived from the recorded candle open; a cancelled or filled approval
--     can never fill again. Pending entries in the submitted state must equal the open approvals exactly.
--  R3 Expiry, identity, quantity and price constraints: approval expiry = approval time + the account's maximum proposal
--     age; proposal age and price age are re-checked; quantities must be lot-size multiples above the minimum notional;
--     leverage is an integer within the account maximum; stop on the correct side with the liquidation buffer met.
--  R4 Account-level risk budgeting (owner decision 4): one central account budget per owner with separate Research and
--     Scalping sub-budgets; each strategy belongs to exactly one sub-budget. Usage = cumulative closed losses (wins do
--     not refill) + reserved risk of open positions + risk of PENDING approval remainders. Every approval and fill must
--     keep strategy ≤ strategy budget, sub-budget usage ≤ sub-budget and account usage ≤ account budget; statically,
--     Σ sub-budgets ≤ account budget and Σ strategy budgets of a sub-budget ≤ that sub-budget, so independently
--     additive strategy budgets can never exceed the central budget. Exposure, position count and free margin include
--     open AND pending exposure.
--  R5 Trading-cost assumption configurable per instrument/strategy (owner decision 3): an override table, resolved
--     exact → strategy-wide → symbol-wide → account default, frozen on each approval at approval time.
--  R6 Transactional, idempotent, concurrency-safe: one function call per candle commits everything or nothing; lock order
--     account row → owner's account budget row → strategy budget rows (sorted) → approval rows; identical retried
--     payloads return the original result without writing; fill ids are derived by the database and unique.
-- Preserved from 0046: strict JSON typing, owner-only MFA-aware reads, service-role boundaries, append-only history,
-- duplicate/closed-candle checks, halted-account entry refusal, compare-and-set sequence, production-table isolation.
-- Every policy value (liquidation buffer, price age, proposal expiry, costs, budgets) is CALLER CONFIG frozen per
-- account; none is approved policy (docs/phase-4e/owner-decision-register.md).
-- =====================================================================================================================

-- ---------- strict value helpers (same contracts as 0046) ----------
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
-- Relative closeness for values recomputed here from JSON numbers the engine produced in binary floating point.
CREATE FUNCTION public.fp3_near(a numeric, b numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT a IS NOT NULL AND b IS NOT NULL AND abs(a - b) <= 0.000000001 * greatest(1, abs(a), abs(b))
$$;

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
  -- Frozen from config at creation (caller config, NOT approved policy). All required: a missing value refuses the account.
  limit_max_daily_loss numeric NOT NULL CHECK (public.fp2_finite(limit_max_daily_loss) AND limit_max_daily_loss > 0),
  limit_max_exposure numeric NOT NULL CHECK (public.fp2_finite(limit_max_exposure) AND limit_max_exposure > 0),
  limit_max_positions integer NOT NULL CHECK (limit_max_positions BETWEEN 1 AND 2),
  limit_max_loss_per_trade numeric NOT NULL CHECK (public.fp2_finite(limit_max_loss_per_trade) AND limit_max_loss_per_trade > 0),
  limit_max_margin_per_trade numeric NOT NULL CHECK (public.fp2_finite(limit_max_margin_per_trade) AND limit_max_margin_per_trade > 0),
  limit_max_leverage integer NOT NULL CHECK (limit_max_leverage BETWEEN 1 AND 125),
  limit_liquidation_buffer_pct numeric NOT NULL CHECK (public.fp2_finite(limit_liquidation_buffer_pct) AND limit_liquidation_buffer_pct >= 0 AND limit_liquidation_buffer_pct < 100),
  limit_max_data_age_ms bigint NOT NULL CHECK (limit_max_data_age_ms BETWEEN 0 AND 3600000),
  limit_max_proposal_age_ms bigint NOT NULL CHECK (limit_max_proposal_age_ms BETWEEN 1000 AND 3600000),
  limit_round_trip_cost_pct numeric NOT NULL CHECK (public.fp2_finite(limit_round_trip_cost_pct) AND limit_round_trip_cost_pct >= 0 AND limit_round_trip_cost_pct <= 5),
  cost_taker_fee_pct numeric NOT NULL CHECK (public.fp2_finite(cost_taker_fee_pct) AND cost_taker_fee_pct >= 0 AND cost_taker_fee_pct <= 1),
  cost_spread_pct numeric NOT NULL CHECK (public.fp2_finite(cost_spread_pct) AND cost_spread_pct >= 0 AND cost_spread_pct <= 1),
  cost_slippage_pct numeric NOT NULL CHECK (public.fp2_finite(cost_slippage_pct) AND cost_slippage_pct >= 0 AND cost_slippage_pct <= 1),
  max_basis_pct numeric NOT NULL CHECK (public.fp2_finite(max_basis_pct) AND max_basis_pct > 0 AND max_basis_pct <= 10),
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

-- Central account budget per owner (paper only), split into Research and Scalping sub-budgets.
CREATE TABLE public.account_risk_budgets (
  user_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment = 'paper'),
  max_loss numeric NOT NULL CHECK (public.fp2_finite(max_loss) AND max_loss > 0 AND max_loss <= 1000000),
  research_max_loss numeric NOT NULL CHECK (public.fp2_finite(research_max_loss) AND research_max_loss >= 0),
  scalping_max_loss numeric NOT NULL CHECK (public.fp2_finite(scalping_max_loss) AND scalping_max_loss >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, environment),
  CONSTRAINT account_risk_budgets_sub_budgets_fit CHECK (research_max_loss + scalping_max_loss <= max_loss)
);

CREATE TABLE public.strategy_risk_budgets (
  user_id uuid NOT NULL,
  strategy_id text NOT NULL CHECK (length(strategy_id) BETWEEN 1 AND 200 AND strategy_id ~ '^[A-Za-z0-9._:-]+$'),
  environment text NOT NULL CHECK (environment = 'paper'),
  engine text NOT NULL CHECK (engine IN ('research', 'scalping')),
  max_loss numeric NOT NULL CHECK (public.fp2_finite(max_loss) AND max_loss > 0 AND max_loss <= 1000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, strategy_id, environment)
);
CREATE INDEX strategy_risk_budgets_engine ON public.strategy_risk_budgets (user_id, environment, engine);

-- Round-trip cost overrides ('*' = any). Informational validation flag; an approval freezes the value it used.
CREATE TABLE public.futures_paper_cost_assumptions (
  user_id uuid NOT NULL,
  strategy_id text NOT NULL DEFAULT '*' CHECK (strategy_id = '*' OR (length(strategy_id) BETWEEN 1 AND 200 AND strategy_id ~ '^[A-Za-z0-9._:-]+$')),
  symbol text NOT NULL DEFAULT '*' CHECK (symbol IN ('*', 'BTCUSDT', 'ETHUSDT')),
  round_trip_cost_pct numeric NOT NULL CHECK (public.fp2_finite(round_trip_cost_pct) AND round_trip_cost_pct >= 0 AND round_trip_cost_pct <= 5),
  validation_status text NOT NULL DEFAULT 'unvalidated' CHECK (validation_status IN ('unvalidated', 'validated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, strategy_id, symbol)
);

-- The public candle each commit was computed from (append-only). Every recomputation reads it, never a worker figure.
CREATE TABLE public.futures_paper_candles (
  account_id uuid NOT NULL REFERENCES public.futures_paper_accounts(id),
  bar_t bigint NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT','ETHUSDT')),
  user_id uuid NOT NULL,
  trade_o numeric NOT NULL, trade_h numeric NOT NULL, trade_l numeric NOT NULL, trade_c numeric NOT NULL, volume numeric NOT NULL,
  mark_o numeric NOT NULL, mark_h numeric NOT NULL, mark_l numeric NOT NULL, mark_c numeric NOT NULL,
  index_c numeric,
  funding jsonb NOT NULL,
  PRIMARY KEY (account_id, bar_t, symbol),
  CONSTRAINT futures_paper_candle_shape CHECK (
    public.fp2_finite(trade_o) AND public.fp2_finite(trade_h) AND public.fp2_finite(trade_l) AND public.fp2_finite(trade_c) AND public.fp2_finite(volume)
    AND public.fp2_finite(mark_o) AND public.fp2_finite(mark_h) AND public.fp2_finite(mark_l) AND public.fp2_finite(mark_c)
    AND least(trade_o, trade_h, trade_l, trade_c, mark_o, mark_h, mark_l, mark_c) > 0 AND volume >= 0
    AND trade_h >= greatest(trade_o, trade_c) AND trade_l <= least(trade_o, trade_c)
    AND mark_h >= greatest(mark_o, mark_c) AND mark_l <= least(mark_o, mark_c)
    AND (index_c IS NULL OR (public.fp2_finite(index_c) AND index_c > 0)) AND jsonb_typeof(funding) = 'array')
);

-- Risk approvals: written only by the commit function after its own risk checks. Identity is frozen; status moves
-- open → filled | cancelled exactly once; filled quantity only grows and never exceeds the approved quantity.
CREATE TABLE public.futures_paper_risk_approvals (
  account_id uuid NOT NULL REFERENCES public.futures_paper_accounts(id),
  proposal_id text NOT NULL CHECK (length(proposal_id) BETWEEN 1 AND 200),
  user_id uuid NOT NULL,
  strategy_id text NOT NULL,
  budget_engine text NOT NULL CHECK (budget_engine IN ('research', 'scalping')),
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT','ETHUSDT')),
  side text NOT NULL CHECK (side IN ('LONG','SHORT')),
  approved_qty numeric NOT NULL CHECK (public.fp2_finite(approved_qty) AND approved_qty > 0),
  filled_qty numeric NOT NULL DEFAULT 0 CHECK (public.fp2_finite(filled_qty) AND filled_qty >= 0),
  leverage integer NOT NULL CHECK (leverage >= 1),
  reference_price numeric NOT NULL CHECK (public.fp2_finite(reference_price) AND reference_price > 0),
  reference_t bigint NOT NULL,
  stop_price numeric NOT NULL CHECK (public.fp2_finite(stop_price) AND stop_price > 0),
  stop_dist numeric NOT NULL CHECK (public.fp2_finite(stop_dist) AND stop_dist > 0),
  cost_pct numeric NOT NULL CHECK (public.fp2_finite(cost_pct) AND cost_pct >= 0),
  liquidation_price numeric NOT NULL CHECK (public.fp2_finite(liquidation_price)),
  liquidation_gap_pct numeric NOT NULL CHECK (public.fp2_finite(liquidation_gap_pct)),
  risk_amount numeric NOT NULL CHECK (public.fp2_finite(risk_amount) AND risk_amount > 0),
  margin_estimate numeric NOT NULL CHECK (public.fp2_finite(margin_estimate) AND margin_estimate > 0),
  proposal_created_t bigint NOT NULL,
  approved_bar_t bigint NOT NULL,
  approved_seq bigint NOT NULL,
  expires_t bigint NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
  closed_seq bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, proposal_id),
  UNIQUE (user_id, proposal_id),
  CONSTRAINT futures_paper_approval_fill_bound CHECK (filled_qty <= approved_qty * 1.000000001),
  CONSTRAINT futures_paper_approval_closed CHECK ((status = 'open') = (closed_seq IS NULL))
);
CREATE UNIQUE INDEX futures_paper_risk_approvals_one_open ON public.futures_paper_risk_approvals (account_id, symbol) WHERE status = 'open';
CREATE INDEX futures_paper_risk_approvals_usage ON public.futures_paper_risk_approvals (user_id, strategy_id) WHERE status = 'open';

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
  risk_amount numeric,          -- database-computed (order_accepted: approval risk; entry_fill: reserved fill risk)
  simulated boolean NOT NULL DEFAULT true CHECK (simulated),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, seq),
  CONSTRAINT futures_paper_event_numbers CHECK (
    public.fp2_finite(qty) AND qty >= 0 AND public.fp2_finite(fee) AND fee >= 0 AND public.fp2_finite(pnl)
    AND public.fp2_finite(wallet_delta) AND public.fp2_finite(margin_delta) AND public.fp2_finite(wallet_after) AND wallet_after >= 0
    AND (price IS NULL OR (public.fp2_finite(price) AND price > 0))
    AND (risk_amount IS NULL OR (public.fp2_finite(risk_amount) AND risk_amount >= 0))),
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
    WHEN 'order_accepted' THEN side IS NOT NULL AND qty > 0 AND price IS NULL AND wallet_delta = 0 AND margin_delta = 0 AND fee = 0 AND pnl = 0
      AND proposal_id IS NOT NULL AND strategy_id IS NOT NULL AND fill_id IS NULL AND risk_amount IS NOT NULL
    ELSE wallet_delta = 0 AND margin_delta = 0 AND fee = 0 AND pnl = 0 AND fill_id IS NULL AND risk_amount IS NULL END)
);
CREATE INDEX futures_paper_events_user ON public.futures_paper_events (user_id, account_id, bar_t DESC);
CREATE INDEX futures_paper_events_bar ON public.futures_paper_events (account_id, bar_t);
CREATE INDEX futures_paper_events_strategy ON public.futures_paper_events (user_id, strategy_id, account_id, proposal_id);
CREATE UNIQUE INDEX futures_paper_events_fill_once ON public.futures_paper_events (account_id, fill_id) WHERE fill_id IS NOT NULL;

CREATE TABLE public.futures_paper_positions (
  account_id uuid NOT NULL REFERENCES public.futures_paper_accounts(id),
  user_id uuid NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT','ETHUSDT')),
  side text NOT NULL CHECK (side IN ('LONG','SHORT')),
  qty numeric NOT NULL CHECK (public.fp2_finite(qty) AND qty > 0),
  entry_price numeric NOT NULL CHECK (public.fp2_finite(entry_price) AND entry_price > 0),
  margin numeric NOT NULL CHECK (public.fp2_finite(margin)),
  leverage integer NOT NULL CHECK (leverage >= 1),
  stop_dist numeric NOT NULL CHECK (public.fp2_finite(stop_dist) AND stop_dist > 0),
  risk_reserved numeric NOT NULL CHECK (public.fp2_finite(risk_reserved) AND risk_reserved >= 0),
  strategy_id text NOT NULL,
  proposal_id text NOT NULL,
  opened_bar_t bigint NOT NULL,
  updated_seq bigint NOT NULL,
  PRIMARY KEY (account_id, symbol)
);
CREATE INDEX futures_paper_positions_strategy ON public.futures_paper_positions (user_id, strategy_id);

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
CREATE TRIGGER futures_paper_candles_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_candles FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_candles_no_truncate BEFORE TRUNCATE ON public.futures_paper_candles FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_accounts_no_truncate BEFORE TRUNCATE ON public.futures_paper_accounts FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_positions_no_truncate BEFORE TRUNCATE ON public.futures_paper_positions FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_approvals_no_truncate BEFORE TRUNCATE ON public.futures_paper_risk_approvals FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER account_risk_budgets_no_truncate BEFORE TRUNCATE ON public.account_risk_budgets FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER strategy_risk_budgets_no_truncate BEFORE TRUNCATE ON public.strategy_risk_budgets FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();

-- True only inside futures_paper_commit_bar_v3 (the function owner sets a transaction-local flag; API roles cannot).
CREATE FUNCTION public.futures_paper_in_commit() RETURNS boolean
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT coalesce(current_setting('futures_paper.commit', true), '') = 'on'
     AND current_user NOT IN ('anon', 'authenticated', 'service_role', 'authenticator')
$$;

CREATE FUNCTION public.guard_futures_paper_account() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE v_now bigint := floor(extract(epoch FROM now()) * 1000)::bigint; l jsonb; c jsonb; s text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'futures paper accounts cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF jsonb_typeof(NEW.config) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.config->'limits') IS DISTINCT FROM 'object'
       OR jsonb_typeof(NEW.config->'costs') IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.config->'specs') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'futures paper config must be an object with limits, costs and specs';
    END IF;
    IF public.fp2_num(NEW.config, 'startingBalance') IS DISTINCT FROM NEW.starting_balance THEN RAISE EXCEPTION 'config.startingBalance must equal starting_balance'; END IF;
    l := NEW.config->'limits'; c := NEW.config->'costs';
    NEW.limit_max_daily_loss := public.fp2_num(l, 'maxDailyLoss');
    NEW.limit_max_exposure := public.fp2_num(l, 'maxExposure');
    NEW.limit_max_positions := public.fp2_int(l, 'maxPositions');
    NEW.limit_max_loss_per_trade := public.fp2_num(l, 'maxLossPerTrade');
    NEW.limit_max_margin_per_trade := public.fp2_num(l, 'maxMarginPerTrade');
    NEW.limit_max_leverage := public.fp2_int(l, 'maxLeverage');
    NEW.limit_liquidation_buffer_pct := public.fp2_num(l, 'liquidationBufferPct');
    NEW.limit_max_data_age_ms := public.fp2_int(l, 'maxDataAgeMs');
    NEW.limit_max_proposal_age_ms := public.fp2_int(l, 'maxProposalAgeMs');
    NEW.limit_round_trip_cost_pct := public.fp2_num(l, 'roundTripCostPct');
    NEW.cost_taker_fee_pct := public.fp2_num(c, 'takerFeePct');
    NEW.cost_spread_pct := public.fp2_num(c, 'spreadPct');
    NEW.cost_slippage_pct := public.fp2_num(c, 'slippagePct');
    NEW.max_basis_pct := public.fp2_num(NEW.config, 'maxBasisPct');
    FOREACH s IN ARRAY NEW.symbols LOOP
      IF NOT (public.fp2_num(NEW.config->'specs'->s, 'stepSize') > 0) OR public.fp2_num(NEW.config->'specs'->s, 'minNotional') < 0
         OR NOT (public.fp2_num(NEW.config->'specs'->s, 'maintenanceMarginRate') BETWEEN 0 AND 0.5) THEN
        RAISE EXCEPTION 'futures paper config: lot size, minimum notional and maintenance margin rate are required for %', s;
      END IF;
    END LOOP;
    NEW.tf_ms := CASE NEW.timeframe WHEN '1m' THEN 60000 WHEN '5m' THEN 300000 WHEN '15m' THEN 900000 END;
    NEW.config_sha256 := encode(sha256(convert_to(NEW.config::text, 'UTF8')), 'hex');
    NEW.created_at := now(); NEW.updated_at := now(); NEW.status := 'active'; NEW.status_reason := NULL; NEW.halted := false;
    NEW.wallet := NEW.starting_balance; NEW.seq := 0;
    NEW.cursor_t := ((v_now + NEW.tf_ms - 1) / NEW.tf_ms) * NEW.tf_ms - NEW.tf_ms; -- forward only
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
      NEW.limit_max_daily_loss, NEW.limit_max_exposure, NEW.limit_max_positions, NEW.limit_max_loss_per_trade, NEW.limit_max_margin_per_trade,
      NEW.limit_max_leverage, NEW.limit_liquidation_buffer_pct, NEW.limit_max_data_age_ms, NEW.limit_max_proposal_age_ms, NEW.limit_round_trip_cost_pct,
      NEW.cost_taker_fee_pct, NEW.cost_spread_pct, NEW.cost_slippage_pct, NEW.max_basis_pct, NEW.created_at, NEW.simulated)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.engine_version, OLD.data_source, OLD.symbols, OLD.timeframe, OLD.tf_ms, OLD.config, OLD.config_sha256, OLD.starting_balance,
      OLD.limit_max_daily_loss, OLD.limit_max_exposure, OLD.limit_max_positions, OLD.limit_max_loss_per_trade, OLD.limit_max_margin_per_trade,
      OLD.limit_max_leverage, OLD.limit_liquidation_buffer_pct, OLD.limit_max_data_age_ms, OLD.limit_max_proposal_age_ms, OLD.limit_round_trip_cost_pct,
      OLD.cost_taker_fee_pct, OLD.cost_spread_pct, OLD.cost_slippage_pct, OLD.max_basis_pct, OLD.created_at, OLD.simulated) THEN
    RAISE EXCEPTION 'futures paper account identity, config, limits and starting balance are frozen';
  END IF;
  IF (NEW.wallet, NEW.seq, NEW.cursor_t, NEW.state) IS DISTINCT FROM (OLD.wallet, OLD.seq, OLD.cursor_t, OLD.state) AND NOT public.futures_paper_in_commit() THEN
    RAISE EXCEPTION 'futures paper ledger columns change only through futures_paper_commit_bar_v3';
  END IF;
  IF OLD.status = 'stopped' AND NEW.status <> 'stopped' THEN RAISE EXCEPTION 'a stopped futures paper account stays stopped'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER futures_paper_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON public.futures_paper_accounts FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_account();

CREATE FUNCTION public.guard_futures_paper_book() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.futures_paper_in_commit() THEN RAISE EXCEPTION 'the futures paper book changes only through futures_paper_commit_bar_v3 (% on %)', TG_OP, TG_TABLE_NAME; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER futures_paper_positions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.futures_paper_positions FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_book();
CREATE TRIGGER futures_paper_commits_guard BEFORE INSERT ON public.futures_paper_commits FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_book();
CREATE TRIGGER futures_paper_candles_guard BEFORE INSERT ON public.futures_paper_candles FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_book();

CREATE FUNCTION public.guard_futures_paper_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.futures_paper_in_commit() THEN RAISE EXCEPTION 'risk approvals change only through futures_paper_commit_bar_v3'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'risk approvals are never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.filled_qty <> 0 OR NEW.closed_seq IS NOT NULL THEN RAISE EXCEPTION 'a risk approval starts open and unfilled'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.account_id, NEW.proposal_id, NEW.user_id, NEW.strategy_id, NEW.budget_engine, NEW.symbol, NEW.side, NEW.approved_qty, NEW.leverage, NEW.reference_price,
      NEW.reference_t, NEW.stop_price, NEW.stop_dist, NEW.cost_pct, NEW.liquidation_price, NEW.liquidation_gap_pct, NEW.risk_amount, NEW.margin_estimate,
      NEW.proposal_created_t, NEW.approved_bar_t, NEW.approved_seq, NEW.expires_t, NEW.created_at)
     IS DISTINCT FROM (OLD.account_id, OLD.proposal_id, OLD.user_id, OLD.strategy_id, OLD.budget_engine, OLD.symbol, OLD.side, OLD.approved_qty, OLD.leverage, OLD.reference_price,
      OLD.reference_t, OLD.stop_price, OLD.stop_dist, OLD.cost_pct, OLD.liquidation_price, OLD.liquidation_gap_pct, OLD.risk_amount, OLD.margin_estimate,
      OLD.proposal_created_t, OLD.approved_bar_t, OLD.approved_seq, OLD.expires_t, OLD.created_at) THEN
    RAISE EXCEPTION 'risk approval identity and terms are frozen';
  END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'risk approval % is already %', OLD.proposal_id, OLD.status; END IF;
  IF NEW.filled_qty < OLD.filled_qty THEN RAISE EXCEPTION 'risk approval filled quantity cannot decrease'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER futures_paper_approvals_guard BEFORE INSERT OR UPDATE OR DELETE ON public.futures_paper_risk_approvals FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_approval();

-- Budget configuration: static nesting (Σ sub-budgets ≤ account; Σ strategy budgets of a sub-budget ≤ that sub-budget).
-- Every write locks the owner's account budget row first, so concurrent configuration writes serialize.
CREATE FUNCTION public.guard_account_risk_budget() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE v_r numeric; v_s numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'account risk budgets are not deleted; lower them instead'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id, NEW.environment, NEW.created_at) IS DISTINCT FROM (OLD.user_id, OLD.environment, OLD.created_at) THEN
    RAISE EXCEPTION 'account risk budget identity is frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  SELECT coalesce(sum(max_loss) FILTER (WHERE engine = 'research'), 0), coalesce(sum(max_loss) FILTER (WHERE engine = 'scalping'), 0)
    INTO v_r, v_s FROM public.strategy_risk_budgets WHERE user_id = NEW.user_id AND environment = NEW.environment;
  IF v_r > NEW.research_max_loss OR v_s > NEW.scalping_max_loss THEN
    RAISE EXCEPTION 'sub-budget below the sum of its strategy budgets (research %/% , scalping %/%)', v_r, NEW.research_max_loss, v_s, NEW.scalping_max_loss;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER account_risk_budgets_guard BEFORE INSERT OR UPDATE OR DELETE ON public.account_risk_budgets FOR EACH ROW EXECUTE FUNCTION public.guard_account_risk_budget();

CREATE FUNCTION public.guard_strategy_risk_budget() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE acct public.account_risk_budgets%ROWTYPE; v_sum numeric; v_cap numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'strategy risk budgets are not deleted; lower them instead'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id, NEW.strategy_id, NEW.environment, NEW.engine, NEW.created_at) IS DISTINCT FROM (OLD.user_id, OLD.strategy_id, OLD.environment, OLD.engine, OLD.created_at) THEN
    RAISE EXCEPTION 'strategy risk budget identity and sub-budget are frozen';
  END IF;
  SELECT * INTO acct FROM public.account_risk_budgets WHERE user_id = NEW.user_id AND environment = NEW.environment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'create the account risk budget before strategy budgets'; END IF;
  SELECT coalesce(sum(max_loss), 0) INTO v_sum FROM public.strategy_risk_budgets
   WHERE user_id = NEW.user_id AND environment = NEW.environment AND engine = NEW.engine AND strategy_id <> NEW.strategy_id;
  v_cap := (CASE NEW.engine WHEN 'research' THEN acct.research_max_loss ELSE acct.scalping_max_loss END);
  IF v_sum + NEW.max_loss > v_cap THEN
    RAISE EXCEPTION 'strategy budgets of the % sub-budget would total % (sub-budget %)', NEW.engine, v_sum + NEW.max_loss, v_cap;
  END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER strategy_risk_budgets_guard BEFORE INSERT OR UPDATE OR DELETE ON public.strategy_risk_budgets FOR EACH ROW EXECUTE FUNCTION public.guard_strategy_risk_budget();

CREATE FUNCTION public.guard_futures_paper_cost() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cost assumptions are not deleted; restate them instead'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id, NEW.strategy_id, NEW.symbol, NEW.created_at) IS DISTINCT FROM (OLD.user_id, OLD.strategy_id, OLD.symbol, OLD.created_at) THEN
    RAISE EXCEPTION 'cost assumption identity is frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER futures_paper_cost_guard BEFORE INSERT OR UPDATE OR DELETE ON public.futures_paper_cost_assumptions FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_cost();
CREATE TRIGGER futures_paper_cost_no_truncate BEFORE TRUNCATE ON public.futures_paper_cost_assumptions FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();

-- ---------- database-side risk arithmetic ----------
CREATE FUNCTION public.fp3_cost(p_user uuid, p_strategy text, p_symbol text, p_default numeric) RETURNS numeric
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT coalesce((SELECT round_trip_cost_pct FROM public.futures_paper_cost_assumptions c
                    WHERE c.user_id = p_user AND c.strategy_id IN (p_strategy, '*') AND c.symbol IN (p_symbol, '*')
                    ORDER BY (c.strategy_id = '*'), (c.symbol = '*') LIMIT 1), p_default)
$$;

-- Budget usage across ALL the owner's paper accounts: cumulative closed losses (per proposal; wins never refill)
-- + reserved risk of open positions + risk of pending approval remainders. Filter: one strategy, one sub-budget, or all.
CREATE FUNCTION public.fp3_usage(p_user uuid, p_strategy text, p_engine text) RETURNS numeric
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  WITH s AS (SELECT strategy_id FROM public.strategy_risk_budgets
              WHERE user_id = p_user AND environment = 'paper'
                AND (p_strategy IS NULL OR strategy_id = p_strategy) AND (p_engine IS NULL OR engine = p_engine))
  SELECT
    coalesce((SELECT sum(greatest(0, -q.net)) FROM (
      SELECT sum(ev.wallet_delta) AS net FROM public.futures_paper_events ev
       WHERE ev.user_id = p_user AND ev.strategy_id IN (SELECT strategy_id FROM s) AND ev.proposal_id IS NOT NULL
       GROUP BY ev.account_id, ev.proposal_id HAVING bool_or(ev.kind IN ('exit_fill', 'liquidation'))) q), 0)
  + coalesce((SELECT sum(p.risk_reserved) FROM public.futures_paper_positions p WHERE p.user_id = p_user AND p.strategy_id IN (SELECT strategy_id FROM s)), 0)
  + coalesce((SELECT sum((r.approved_qty - r.filled_qty) * (r.stop_dist + r.reference_price * r.cost_pct / 100))
                FROM public.futures_paper_risk_approvals r WHERE r.user_id = p_user AND r.status = 'open' AND r.strategy_id IN (SELECT strategy_id FROM s)), 0)
$$;

CREATE FUNCTION public.fp3_mark(p_candles jsonb, p_sym text, p_which text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $$
BEGIN
  IF jsonb_typeof(p_candles->p_sym) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'futures paper: no candle for % (held, pending or traded symbol)', p_sym; END IF;
  RETURN public.fp2_num(p_candles->p_sym->'mark', p_which);
END $$;

-- Shared account checks after an approval or a fill has been written (any failure rolls back the whole candle).
-- Messages for fills keep the 0046 wording so the existing refusal planner classifies them.
CREATE FUNCTION public.fp3_check_account(p_account uuid, p_candles jsonb, p_which text, p_wallet numeric, p_strategy text, p_ctx text) RETURNS void
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  a public.futures_paper_accounts%ROWTYPE; ab public.account_risk_budgets%ROWTYPE; sb public.strategy_risk_budgets%ROWTYPE;
  tol constant numeric := 0.000001; v numeric; v_expo numeric; v_cnt bigint; v_margin numeric; v_sub numeric;
BEGIN
  SELECT * INTO a FROM public.futures_paper_accounts WHERE id = p_account;
  SELECT * INTO ab FROM public.account_risk_budgets WHERE user_id = a.user_id AND environment = 'paper';
  IF NOT FOUND THEN RAISE EXCEPTION 'no paper account risk budget: % refused', p_ctx; END IF;
  SELECT * INTO sb FROM public.strategy_risk_budgets WHERE user_id = a.user_id AND strategy_id = p_strategy AND environment = 'paper';
  IF NOT FOUND THEN RAISE EXCEPTION 'no paper risk budget for strategy %: entry fill refused', p_strategy; END IF;
  v := public.fp3_usage(a.user_id, p_strategy, NULL);
  IF v > sb.max_loss + tol THEN RAISE EXCEPTION 'strategy % budget % would be exceeded at % (usage %)', p_strategy, sb.max_loss, p_ctx, v; END IF;
  v_sub := CASE sb.engine WHEN 'research' THEN ab.research_max_loss ELSE ab.scalping_max_loss END;
  v := public.fp3_usage(a.user_id, NULL, sb.engine);
  IF v > v_sub + tol THEN RAISE EXCEPTION 'strategy % budget %-sub-budget:% would be exceeded at % (usage %)', p_strategy, sb.engine, v_sub, p_ctx, v; END IF;
  v := public.fp3_usage(a.user_id, NULL, NULL);
  IF v > ab.max_loss + tol THEN RAISE EXCEPTION 'strategy % budget account:% would be exceeded at % (usage %)', p_strategy, ab.max_loss, p_ctx, v; END IF;
  -- Open AND pending exposure, positions, margin at this candle's marks.
  SELECT coalesce(sum(x.q * public.fp3_mark(p_candles, x.symbol, p_which)), 0), count(DISTINCT x.symbol), coalesce(sum(x.m), 0) INTO v_expo, v_cnt, v_margin FROM (
    SELECT p.symbol, p.qty AS q, p.margin AS m FROM public.futures_paper_positions p WHERE p.account_id = a.id
    UNION ALL
    SELECT r.symbol, r.approved_qty - r.filled_qty, (r.approved_qty - r.filled_qty) * public.fp3_mark(p_candles, r.symbol, p_which) / r.leverage
      FROM public.futures_paper_risk_approvals r WHERE r.account_id = a.id AND r.status = 'open') x;
  IF v_expo > a.limit_max_exposure + tol THEN RAISE EXCEPTION 'exposure % would exceed % at %', v_expo, a.limit_max_exposure, p_ctx; END IF;
  IF v_cnt > a.limit_max_positions THEN RAISE EXCEPTION 'position limit % exceeded at %', a.limit_max_positions, p_ctx; END IF;
  IF p_wallet - v_margin < -tol THEN RAISE EXCEPTION 'free margin would be negative at %', p_ctx; END IF;
END $$;

-- Daily loss before an entry: today's realized cash (this candle so far included) + negative unrealized at the marks.
CREATE FUNCTION public.fp3_daily_left(p_account uuid, p_bar_t bigint, p_candles jsonb, p_which text) RETURNS numeric
LANGUAGE sql SET search_path TO 'public' AS $$
  SELECT a.limit_max_daily_loss + least(0,
      coalesce((SELECT sum(e.wallet_delta) FROM public.futures_paper_events e WHERE e.account_id = a.id AND e.bar_t / 86400000 = p_bar_t / 86400000), 0)
    + coalesce((SELECT sum(least(0, (CASE p.side WHEN 'LONG' THEN 1 ELSE -1 END) * (public.fp3_mark(p_candles, p.symbol, p_which) - p.entry_price) * p.qty))
                  FROM public.futures_paper_positions p WHERE p.account_id = a.id), 0))
  FROM public.futures_paper_accounts a WHERE a.id = p_account
$$;

-- ---------- atomic, recomputing, idempotent per-candle commit ----------
CREATE FUNCTION public.futures_paper_commit_bar_v3(p_account uuid, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  a public.futures_paper_accounts%ROWTYPE;
  b public.futures_paper_positions%ROWTYPE;
  r public.futures_paper_risk_approvals%ROWTYPE;
  c public.futures_paper_commits%ROWTYPE;
  sb public.strategy_risk_budgets%ROWTYPE;
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  tol constant numeric := 0.000001;
  v_hash text; st jsonb; cs jsonb; cd jsonb; e jsonb; pj jsonb; f jsonb; k text;
  v_wallet numeric; v_seq bigint; v_found boolean; v_dir integer;
  v_kind text; v_sym text; v_side text; v_qty numeric; v_price numeric; v_fee numeric; v_pnl numeric; v_wd numeric; v_md numeric; v_t bigint;
  v_strat text; v_prop text; v_fill text; v_risk numeric;
  v_step numeric; v_minnot numeric; v_mmr numeric; v_adj numeric; v_ref numeric; v_stop numeric; v_dist numeric; v_lev bigint; v_cost numeric;
  v_liq numeric; v_gap numeric; v_margin numeric; v_created bigint; v_expected numeric; v_lo numeric; v_hi numeric; v_rate numeric;
BEGIN
  IF p_account IS NULL OR p_expected_seq IS NULL OR p_bar_t IS NULL OR p_payload IS NULL THEN
    RAISE EXCEPTION 'futures paper commit: account, expected sequence, candle and payload are all required';
  END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'events') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_payload->'state') IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'candles') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'futures paper commit: payload must contain events[], state{} and candles{}';
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
  st := p_payload->'state'; cs := p_payload->'candles';

  -- Record the candle of every supplied symbol (strict shape; the table CHECK repeats the OHLC sanity rules).
  PERFORM set_config('futures_paper.commit', 'on', true);
  FOR k, cd IN SELECT * FROM jsonb_each(cs) LOOP
    IF NOT (k = ANY (a.symbols)) OR jsonb_typeof(cd) IS DISTINCT FROM 'object' OR jsonb_typeof(cd->'trade') IS DISTINCT FROM 'object'
       OR jsonb_typeof(cd->'mark') IS DISTINCT FROM 'object' OR jsonb_typeof(cd->'funding') IS DISTINCT FROM 'array'
       OR (cd->'index_c' IS NOT NULL AND jsonb_typeof(cd->'index_c') NOT IN ('number', 'null')) THEN
      RAISE EXCEPTION 'candle for % must be an account symbol with trade{}, mark{}, index_c and funding[]', k;
    END IF;
    FOR f IN SELECT * FROM jsonb_array_elements(cd->'funding') LOOP
      IF public.fp2_int(f, 't') < p_bar_t OR public.fp2_int(f, 't') >= p_bar_t + a.tf_ms OR abs(public.fp2_num(f, 'rate')) > 0.05 THEN
        RAISE EXCEPTION 'funding entry for % is outside the candle or out of range', k;
      END IF;
    END LOOP;
    INSERT INTO public.futures_paper_candles (account_id, bar_t, symbol, user_id, trade_o, trade_h, trade_l, trade_c, volume, mark_o, mark_h, mark_l, mark_c, index_c, funding)
    VALUES (a.id, p_bar_t, k, a.user_id, public.fp2_num(cd->'trade', 'o'), public.fp2_num(cd->'trade', 'h'), public.fp2_num(cd->'trade', 'l'), public.fp2_num(cd->'trade', 'c'),
            public.fp2_num(cd->'trade', 'v'), public.fp2_num(cd->'mark', 'o'), public.fp2_num(cd->'mark', 'h'), public.fp2_num(cd->'mark', 'l'), public.fp2_num(cd->'mark', 'c'),
            CASE WHEN jsonb_typeof(cd->'index_c') = 'number' THEN (cd->>'index_c')::numeric ELSE NULL END, cd->'funding');
  END LOOP;
  -- Every held or pending symbol needs this candle (nothing is valued at a fallback price).
  FOR k IN SELECT symbol FROM public.futures_paper_positions WHERE account_id = a.id UNION SELECT symbol FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND status = 'open' LOOP
    IF jsonb_typeof(cs->k) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'futures paper: no candle for % (held, pending or traded symbol)', k; END IF;
  END LOOP;

  -- Lock order: account (above) → owner's account budget → strategy budgets touched by approvals/fills (sorted).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'events') x WHERE x->>'kind' IN ('order_accepted', 'entry_fill')) THEN
    PERFORM 1 FROM public.account_risk_budgets WHERE user_id = a.user_id AND environment = 'paper' FOR UPDATE;
    PERFORM 1 FROM public.strategy_risk_budgets
     WHERE user_id = a.user_id AND environment = 'paper'
       AND strategy_id IN (SELECT x->>'strategy_id' FROM jsonb_array_elements(p_payload->'events') x WHERE x->>'kind' = 'order_accepted'
                           UNION SELECT ap.strategy_id FROM public.futures_paper_risk_approvals ap
                                  WHERE ap.account_id = a.id AND ap.proposal_id IN (SELECT x->>'proposal_id' FROM jsonb_array_elements(p_payload->'events') x WHERE x->>'kind' = 'entry_fill'))
     ORDER BY strategy_id FOR UPDATE;
  END IF;

  v_wallet := a.wallet; v_seq := a.seq;
  v_adj := a.cost_spread_pct / 200 + a.cost_slippage_pct / 100;
  FOR e IN SELECT * FROM jsonb_array_elements(p_payload->'events') LOOP
    IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'every event must be an object'; END IF;
    IF e ? 'risk_amount' OR e ? 'fill_id' THEN RAISE EXCEPTION 'risk_amount and fill_id are computed by the database; a worker-supplied value is refused'; END IF;
    IF public.fp2_int(e, 'seq') IS DISTINCT FROM v_seq + 1 THEN RAISE EXCEPTION 'event sequence must be consecutive'; END IF;
    v_sym := public.fp2_txt(e, 'symbol', false);
    IF NOT (v_sym = ANY (a.symbols)) THEN RAISE EXCEPTION 'symbol % is not part of this account', v_sym; END IF;
    IF jsonb_typeof(cs->v_sym) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'futures paper: no candle for % (held, pending or traded symbol)', v_sym; END IF;
    cd := cs->v_sym;
    v_kind := public.fp2_txt(e, 'kind', false); v_side := public.fp2_txt(e, 'side', true);
    v_t := public.fp2_int(e, 't'); v_qty := public.fp2_num(e, 'qty'); v_fee := public.fp2_num(e, 'fee'); v_pnl := public.fp2_num(e, 'pnl');
    v_wd := public.fp2_num(e, 'wallet_delta'); v_md := public.fp2_num(e, 'margin_delta');
    v_price := CASE WHEN e->'price' IS NULL OR jsonb_typeof(e->'price') = 'null' THEN NULL ELSE public.fp2_num(e, 'price') END;
    v_prop := public.fp2_txt(e, 'proposal_id', true); v_strat := public.fp2_txt(e, 'strategy_id', true);
    v_fill := NULL; v_risk := NULL;
    IF v_t < p_bar_t OR v_t > p_bar_t + a.tf_ms THEN RAISE EXCEPTION 'event time % is outside candle %', v_t, p_bar_t; END IF;
    IF v_kind IN ('entry_fill', 'order_accepted') AND (a.status <> 'active' OR a.halted) THEN
      RAISE EXCEPTION 'entries are refused while the account is not active or is halted';
    END IF;
    v_step := public.fp2_num(a.config->'specs'->v_sym, 'stepSize'); v_minnot := public.fp2_num(a.config->'specs'->v_sym, 'minNotional');
    v_mmr := public.fp2_num(a.config->'specs'->v_sym, 'maintenanceMarginRate');
    v_dir := CASE v_side WHEN 'LONG' THEN 1 WHEN 'SHORT' THEN -1 ELSE 0 END;
    SELECT * INTO b FROM public.futures_paper_positions WHERE account_id = a.id AND symbol = v_sym;
    v_found := FOUND;

    IF v_kind = 'order_accepted' THEN
      -- The database re-runs the Risk Engine's checks from its own data; nothing the worker states about risk is used.
      IF v_prop IS NULL OR v_strat IS NULL OR v_dir = 0 THEN RAISE EXCEPTION 'approval: proposal, strategy and side are required'; END IF;
      SELECT * INTO sb FROM public.strategy_risk_budgets WHERE user_id = a.user_id AND strategy_id = v_strat AND environment = 'paper';
      IF NOT FOUND THEN RAISE EXCEPTION 'approval refused: no paper risk budget for strategy %', v_strat; END IF;
      IF EXISTS (SELECT 1 FROM public.futures_paper_risk_approvals WHERE user_id = a.user_id AND proposal_id = v_prop) THEN
        RAISE EXCEPTION 'approval refused: proposal % was already evaluated', v_prop;
      END IF;
      IF v_found OR EXISTS (SELECT 1 FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND symbol = v_sym AND status = 'open') THEN
        RAISE EXCEPTION 'approval refused: % already has a position or a pending entry', v_sym;
      END IF;
      IF v_t <> p_bar_t + a.tf_ms THEN RAISE EXCEPTION 'approval refused: approvals are made at the candle close'; END IF;
      v_ref := public.fp3_mark(cs, v_sym, 'c');
      IF v_t - (p_bar_t + a.tf_ms) > a.limit_max_data_age_ms THEN RAISE EXCEPTION 'approval refused: price is older than % ms', a.limit_max_data_age_ms; END IF;
      v_created := public.fp2_int(e, 'proposal_created_t');
      IF v_t - v_created > a.limit_max_proposal_age_ms OR v_created > v_t + 5000 THEN
        RAISE EXCEPTION 'approval refused: proposal age % ms is outside 0..% ms', v_t - v_created, a.limit_max_proposal_age_ms;
      END IF;
      IF jsonb_typeof(cd->'index_c') IS DISTINCT FROM 'number' OR abs(v_ref - (cd->>'index_c')::numeric) / (cd->>'index_c')::numeric * 100 > a.max_basis_pct THEN
        RAISE EXCEPTION 'approval refused: index price missing or mark/index basis above %', a.max_basis_pct;
      END IF;
      v_stop := public.fp2_num(e, 'stop_price');
      IF NOT (v_stop > 0) OR (v_dir = 1 AND v_stop >= v_ref) OR (v_dir = -1 AND v_stop <= v_ref) THEN RAISE EXCEPTION 'approval refused: stop is on the wrong side of the mark'; END IF;
      v_dist := abs(v_ref - v_stop);
      v_lev := public.fp2_int(e, 'leverage');
      IF v_lev < 1 OR v_lev > a.limit_max_leverage THEN RAISE EXCEPTION 'approval refused: leverage % outside 1..%', v_lev, a.limit_max_leverage; END IF;
      IF NOT (v_qty > 0) OR abs(v_qty / v_step - round(v_qty / v_step)) > 0.000001 OR v_qty * v_ref < v_minnot THEN
        RAISE EXCEPTION 'approval refused: quantity % is not a lot-size multiple above the minimum notional', v_qty;
      END IF;
      v_cost := public.fp3_cost(a.user_id, v_strat, v_sym, a.limit_round_trip_cost_pct);
      v_risk := v_qty * (v_dist + v_ref * v_cost / 100);
      IF v_risk > a.limit_max_loss_per_trade + tol THEN RAISE EXCEPTION 'approval refused: risk % exceeds the per-trade maximum %', v_risk, a.limit_max_loss_per_trade; END IF;
      v_margin := v_qty * v_ref / v_lev;
      IF v_margin > a.limit_max_margin_per_trade + tol THEN RAISE EXCEPTION 'approval refused: margin % exceeds the per-trade maximum %', v_margin, a.limit_max_margin_per_trade; END IF;
      v_liq := CASE v_dir WHEN 1 THEN v_ref * (1 - 1.0 / v_lev + v_mmr) ELSE v_ref * (1 + 1.0 / v_lev - v_mmr) END;
      v_gap := (CASE v_dir WHEN 1 THEN v_stop - v_liq ELSE v_liq - v_stop END) / v_ref * 100;
      IF v_gap < a.limit_liquidation_buffer_pct - 0.000000001 THEN
        RAISE EXCEPTION 'approval refused: stop is % %% from estimated liquidation (minimum % %%)', round(v_gap, 4), a.limit_liquidation_buffer_pct;
      END IF;
      IF public.fp3_daily_left(a.id, p_bar_t, cs, 'c') <= 0 THEN RAISE EXCEPTION 'approval refused: daily loss limit reached'; END IF;
      INSERT INTO public.futures_paper_risk_approvals (account_id, proposal_id, user_id, strategy_id, budget_engine, symbol, side, approved_qty, leverage, reference_price, reference_t,
        stop_price, stop_dist, cost_pct, liquidation_price, liquidation_gap_pct, risk_amount, margin_estimate, proposal_created_t, approved_bar_t, approved_seq, expires_t)
      VALUES (a.id, v_prop, a.user_id, v_strat, sb.engine, v_sym, v_side, v_qty, v_lev, v_ref, p_bar_t + a.tf_ms,
        v_stop, v_dist, v_cost, v_liq, v_gap, v_risk, v_margin, v_created, p_bar_t, v_seq + 1, v_t + a.limit_max_proposal_age_ms);
      PERFORM public.fp3_check_account(a.id, cs, 'c', v_wallet, v_strat, 'approval');

    ELSIF v_kind = 'entry_cancelled' THEN
      SELECT * INTO r FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND proposal_id = v_prop FOR UPDATE;
      IF NOT FOUND OR r.status <> 'open' OR r.symbol <> v_sym THEN RAISE EXCEPTION 'cancellation without an open risk approval for %', v_sym; END IF;
      IF abs(v_qty - (r.approved_qty - r.filled_qty)) > tol * greatest(1, r.approved_qty) THEN RAISE EXCEPTION 'cancellation must cover the unfilled remainder'; END IF;
      v_strat := r.strategy_id;
      UPDATE public.futures_paper_risk_approvals SET status = 'cancelled', closed_seq = v_seq + 1 WHERE account_id = a.id AND proposal_id = v_prop;

    ELSIF v_kind = 'entry_fill' THEN
      SELECT * INTO r FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND proposal_id = v_prop FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'entry fill without a valid risk approval (proposal %)', coalesce(v_prop, 'none'); END IF;
      IF r.status <> 'open' THEN RAISE EXCEPTION 'risk approval % is % and cannot fill', r.proposal_id, r.status; END IF;
      IF r.symbol <> v_sym OR r.side IS DISTINCT FROM v_side OR (v_strat IS NOT NULL AND v_strat <> r.strategy_id) THEN
        RAISE EXCEPTION 'entry fill does not match the open % risk approval (symbol, side or strategy)', v_sym;
      END IF;
      IF r.approved_bar_t >= p_bar_t OR v_t < r.reference_t THEN RAISE EXCEPTION 'entry fill precedes its risk approval'; END IF;
      IF v_t > r.expires_t THEN RAISE EXCEPTION 'risk approval % expired at % (fill at %)', r.proposal_id, r.expires_t, v_t; END IF;
      IF v_t - p_bar_t > a.limit_max_data_age_ms THEN RAISE EXCEPTION 'entry fill refused: price is older than % ms', a.limit_max_data_age_ms; END IF;
      IF NOT (v_qty > 0) OR abs(v_qty / v_step - round(v_qty / v_step)) > 0.000001 OR r.filled_qty + v_qty > r.approved_qty * (1 + 0.000000001) THEN
        RAISE EXCEPTION 'entry fill quantity % exceeds the approved remainder % or is not a lot-size multiple', v_qty, r.approved_qty - r.filled_qty;
      END IF;
      v_expected := public.fp2_num(cd->'trade', 'o') * (1 + v_dir * v_adj);
      IF NOT public.fp3_near(v_price, v_expected) THEN RAISE EXCEPTION 'entry fill price % differs from the taker price % of the recorded candle open', v_price, v_expected; END IF;
      IF NOT public.fp3_near(v_fee, v_price * v_qty * a.cost_taker_fee_pct / 100) THEN RAISE EXCEPTION 'entry fill fee differs from the database computation'; END IF;
      IF NOT public.fp3_near(v_md, v_price * v_qty / r.leverage) THEN RAISE EXCEPTION 'entry fill margin differs from the approved leverage'; END IF;
      IF v_found AND (b.side IS DISTINCT FROM v_side OR b.strategy_id IS DISTINCT FROM r.strategy_id OR b.proposal_id IS DISTINCT FROM r.proposal_id) THEN
        RAISE EXCEPTION 'entry fill does not match the open % position', v_sym;
      END IF;
      IF public.fp3_daily_left(a.id, p_bar_t, cs, 'o') <= 0 THEN RAISE EXCEPTION 'daily loss limit reached: entry fill refused'; END IF;
      v_strat := r.strategy_id; v_fill := r.proposal_id || ':entry:' || v_t::text;
      v_risk := v_qty * r.stop_dist + v_qty * v_price * r.cost_pct / 100;  -- recomputed; never read from the payload
      UPDATE public.futures_paper_risk_approvals SET filled_qty = filled_qty + v_qty,
             status = CASE WHEN approved_qty - (filled_qty + v_qty) <= v_step / 2 THEN 'filled' ELSE 'open' END,
             closed_seq = CASE WHEN approved_qty - (filled_qty + v_qty) <= v_step / 2 THEN v_seq + 1 ELSE NULL END
       WHERE account_id = a.id AND proposal_id = r.proposal_id;

    ELSIF v_kind = 'funding' THEN
      IF NOT v_found OR b.side IS DISTINCT FROM v_side THEN RAISE EXCEPTION '% event without a matching open % position', v_kind, v_sym; END IF;
      IF v_strat IS NOT NULL AND v_strat IS DISTINCT FROM b.strategy_id THEN RAISE EXCEPTION 'event strategy differs from the position strategy'; END IF;
      SELECT public.fp2_num(x, 'rate') INTO v_rate FROM jsonb_array_elements(cd->'funding') x WHERE public.fp2_int(x, 't') = v_t LIMIT 1;
      IF v_rate IS NULL THEN RAISE EXCEPTION 'funding event at % has no funding entry in the recorded candle', v_t; END IF;
      IF b.opened_bar_t >= v_t THEN RAISE EXCEPTION 'funding before the position opened'; END IF;
      IF NOT public.fp3_near(v_qty, b.qty) OR NOT public.fp3_near(v_wd, -v_dir * b.qty * public.fp3_mark(cs, v_sym, 'o') * v_rate) THEN
        RAISE EXCEPTION 'funding cash differs from the database computation';
      END IF;
      v_strat := b.strategy_id;

    ELSIF v_kind IN ('exit_fill', 'liquidation') THEN
      IF NOT v_found OR b.side IS DISTINCT FROM v_side THEN RAISE EXCEPTION '% event without a matching open % position', v_kind, v_sym; END IF;
      IF v_strat IS NOT NULL AND v_strat IS DISTINCT FROM b.strategy_id THEN RAISE EXCEPTION 'event strategy differs from the position strategy'; END IF;
      IF abs(v_qty - b.qty) > tol * greatest(1, b.qty) THEN RAISE EXCEPTION 'close quantity % differs from the open quantity %', v_qty, b.qty; END IF;
      IF abs(v_md + b.margin) > tol * greatest(1, abs(b.margin)) THEN RAISE EXCEPTION 'close must release exactly the position margin'; END IF;
      IF v_kind = 'exit_fill' THEN
        v_lo := least(public.fp2_num(cd->'trade', 'l'), public.fp2_num(cd->'mark', 'l')) * (1 - v_adj);
        v_hi := greatest(public.fp2_num(cd->'trade', 'h'), public.fp2_num(cd->'mark', 'h')) * (1 + v_adj);
        IF v_price < v_lo * (1 - 0.000000001) OR v_price > v_hi * (1 + 0.000000001) THEN RAISE EXCEPTION 'exit price % is outside the recorded candle', v_price; END IF;
        IF NOT public.fp3_near(v_pnl, v_dir * (v_price - b.entry_price) * b.qty) OR NOT public.fp3_near(v_fee, v_price * b.qty * a.cost_taker_fee_pct / 100) THEN
          RAISE EXCEPTION 'exit P&L or fee differs from the database computation';
        END IF;
      ELSE
        v_liq := CASE v_dir WHEN 1 THEN (b.qty * b.entry_price - b.margin) / (b.qty * (1 - v_mmr)) ELSE (b.qty * b.entry_price + b.margin) / (b.qty * (1 + v_mmr)) END;
        v_liq := greatest(v_liq, 0);
        IF NOT public.fp3_near(v_price, v_liq) THEN RAISE EXCEPTION 'liquidation price differs from the database computation'; END IF;
        IF (v_dir = 1 AND public.fp3_mark(cs, v_sym, 'l') > v_liq * (1 + 0.000000001)) OR (v_dir = -1 AND public.fp3_mark(cs, v_sym, 'h') < v_liq * (1 - 0.000000001)) THEN
          RAISE EXCEPTION 'liquidation refused: the recorded mark never reached %', v_liq;
        END IF;
        IF NOT public.fp3_near(v_pnl, -b.margin) THEN RAISE EXCEPTION 'liquidation loss must equal the position margin'; END IF;
      END IF;
      v_strat := b.strategy_id; v_fill := b.proposal_id || ':close';
    ELSIF v_kind = 'order_rejected' THEN
      NULL;
    END IF;

    v_seq := v_seq + 1; v_wallet := v_wallet + v_wd;
    IF v_wallet < 0 THEN RAISE EXCEPTION 'simulated wallet would go negative'; END IF;
    INSERT INTO public.futures_paper_events (account_id, seq, user_id, bar_t, t, symbol, kind, side, qty, price, fee, pnl, wallet_delta, margin_delta, wallet_after, reason, proposal_id, strategy_id, fill_id, risk_amount)
    VALUES (a.id, v_seq, a.user_id, p_bar_t, v_t, v_sym, v_kind, v_side, v_qty, v_price, v_fee, v_pnl, v_wd, v_md, v_wallet, public.fp2_txt(e, 'reason', false), v_prop,
            CASE WHEN v_kind = 'order_rejected' THEN NULL ELSE v_strat END, v_fill, v_risk);

    IF v_kind = 'entry_fill' THEN
      IF v_found THEN
        UPDATE public.futures_paper_positions SET entry_price = (entry_price * qty + v_price * v_qty) / (qty + v_qty), qty = qty + v_qty,
               margin = margin + v_md, risk_reserved = risk_reserved + v_risk, updated_seq = v_seq WHERE account_id = a.id AND symbol = v_sym;
      ELSE
        INSERT INTO public.futures_paper_positions (account_id, user_id, symbol, side, qty, entry_price, margin, leverage, stop_dist, risk_reserved, strategy_id, proposal_id, opened_bar_t, updated_seq)
        VALUES (a.id, a.user_id, v_sym, v_side, v_qty, v_price, v_md, r.leverage, r.stop_dist, v_risk, r.strategy_id, r.proposal_id, p_bar_t, v_seq);
      END IF;
      PERFORM public.fp3_check_account(a.id, cs, 'o', v_wallet, v_strat, 'fill');
    ELSIF v_kind = 'funding' THEN
      UPDATE public.futures_paper_positions SET margin = margin + v_md, updated_seq = v_seq WHERE account_id = a.id AND symbol = v_sym;
    ELSIF v_kind IN ('exit_fill', 'liquidation') THEN
      DELETE FROM public.futures_paper_positions WHERE account_id = a.id AND symbol = v_sym;
    END IF;
  END LOOP;

  -- Submitted state must reconcile with the ledger, the database's own book and the open approvals.
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
  -- Pending entries live in the database: the state may carry exactly the open approvals, with their exact terms.
  FOR k IN SELECT jsonb_object_keys(st->'pending') LOOP
    SELECT * INTO r FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND symbol = k AND status = 'open';
    IF NOT FOUND THEN RAISE EXCEPTION 'state has a pending % entry without an open risk approval', k; END IF;
    pj := st->'pending'->k;
    IF pj->>'proposalId' IS DISTINCT FROM r.proposal_id OR pj->>'strategyId' IS DISTINCT FROM r.strategy_id OR pj->>'side' IS DISTINCT FROM r.side
       OR NOT public.fp3_near(public.fp2_num(pj, 'qtyTotal'), r.approved_qty) OR NOT public.fp3_near(public.fp2_num(pj, 'qtyFilled') + 1, r.filled_qty + 1)
       OR public.fp2_num(pj, 'leverage') IS DISTINCT FROM r.leverage::numeric OR NOT public.fp3_near(public.fp2_num(pj, 'stopDist'), r.stop_dist) THEN
      RAISE EXCEPTION 'state pending % does not match its risk approval', k;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND status = 'open') <> (SELECT count(*) FROM jsonb_object_keys(st->'pending')) THEN
    RAISE EXCEPTION 'an open risk approval is missing from the state';
  END IF;
  IF a.halted AND st->'pending' <> '{}'::jsonb THEN RAISE EXCEPTION 'a halted account cannot keep pending entries'; END IF;

  UPDATE public.futures_paper_accounts SET wallet = v_wallet, seq = v_seq, cursor_t = p_bar_t, state = st WHERE id = a.id;
  INSERT INTO public.futures_paper_commits (account_id, bar_t, user_id, expected_seq, seq_to, payload_sha256) VALUES (a.id, p_bar_t, a.user_id, p_expected_seq, v_seq, v_hash);
  PERFORM set_config('futures_paper.commit', 'off', true);
  RETURN v_seq;
END $$;

-- ---------- privileges and row security ----------
REVOKE ALL ON public.futures_paper_accounts, public.futures_paper_events, public.futures_paper_positions, public.futures_paper_commits, public.futures_paper_candles,
  public.futures_paper_risk_approvals, public.account_risk_budgets, public.strategy_risk_budgets, public.futures_paper_cost_assumptions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.futures_paper_accounts, public.futures_paper_events, public.futures_paper_positions, public.futures_paper_commits, public.futures_paper_candles,
  public.futures_paper_risk_approvals, public.account_risk_budgets, public.strategy_risk_budgets, public.futures_paper_cost_assumptions TO authenticated, service_role;
GRANT INSERT, UPDATE ON public.futures_paper_accounts, public.account_risk_budgets, public.strategy_risk_budgets, public.futures_paper_cost_assumptions TO service_role;
ALTER TABLE public.futures_paper_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_candles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_risk_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_risk_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy_risk_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_cost_assumptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_paper_accounts_owner_read ON public.futures_paper_accounts FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_events_owner_read ON public.futures_paper_events FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_positions_owner_read ON public.futures_paper_positions FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_commits_owner_read ON public.futures_paper_commits FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_candles_owner_read ON public.futures_paper_candles FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_risk_approvals_owner_read ON public.futures_paper_risk_approvals FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY account_risk_budgets_owner_read ON public.account_risk_budgets FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY strategy_risk_budgets_owner_read ON public.strategy_risk_budgets FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_cost_assumptions_owner_read ON public.futures_paper_cost_assumptions FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
-- service_role bypasses RLS (BYPASSRLS) for its configuration writes; no write policy exists for any API role.

REVOKE ALL ON FUNCTION public.fp2_finite(numeric), public.fp2_num(jsonb, text), public.fp2_int(jsonb, text), public.fp2_txt(jsonb, text, boolean), public.fp3_near(numeric, numeric),
  public.futures_paper_in_commit(), public.futures_paper_history_immutable(), public.guard_futures_paper_account(), public.guard_futures_paper_book(),
  public.guard_futures_paper_approval(), public.guard_account_risk_budget(), public.guard_strategy_risk_budget(), public.guard_futures_paper_cost(),
  public.fp3_cost(uuid, text, text, numeric), public.fp3_usage(uuid, text, text), public.fp3_mark(jsonb, text, text),
  public.fp3_check_account(uuid, jsonb, text, numeric, text, text), public.fp3_daily_left(uuid, bigint, jsonb, text) FROM PUBLIC, anon, authenticated;
-- service_role writes accounts, budgets and cost assumptions, whose CHECK constraints and triggers call these helpers.
GRANT EXECUTE ON FUNCTION public.fp2_finite(numeric), public.fp2_num(jsonb, text), public.fp2_int(jsonb, text), public.futures_paper_in_commit() TO service_role;
REVOKE ALL ON FUNCTION public.fp3_cost(uuid, text, text, numeric), public.fp3_usage(uuid, text, text), public.fp3_mark(jsonb, text, text),
  public.fp3_check_account(uuid, jsonb, text, numeric, text, text), public.fp3_daily_left(uuid, bigint, jsonb, text) FROM service_role;
REVOKE ALL ON FUNCTION public.futures_paper_commit_bar_v3(uuid, bigint, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.futures_paper_commit_bar_v3(uuid, bigint, bigint, jsonb) TO service_role;
