-- =====================================================================================================================
-- 0052 — DRAFT ONLY. NOT APPLIED. PROPOSED NUMBER; the final number is assigned at owner approval.
-- Reviewed SUCCESSOR of drafts 0049 (ledger v3), 0050 (worker gateway) and 0051 (event completeness). All three are
-- NOT applied and stay byte-identical. Apply order: 0049 → 0050 → 0051 → 0052, never alongside 0045 or 0046.
-- Everything is SIMULATED from public market data; nothing here can reach an exchange, credentials, real orders,
-- positions or trades, risk_settings, futures_settings, the demo wallet, the Spot paper ledger (0044), bots, Autopilot
-- or Live Futures.
--
-- Owner decisions implemented (Phase 4H finalization, 13 Nov 2026):
--  A  ENTRY-FILL COMPLETENESS — REQUIRED. For every pending entry open at the candle open the database derives the
--     required outcome itself from the recorded candle and its own approval row, and refuses any other event set:
--       1. approval expired (candle open > expires_t)      → cancel the whole remainder at the open, reason [APPROVAL_EXPIRED]
--       2. account halted                                   → cancel at the open, reason [ACCOUNT_HALTED]
--       3. account not active (paused or stopped)           → cancel at the open, reason [ACCOUNT_NOT_ACTIVE]
--       4. otherwise the required fill quantity q = the whole remainder, or, with a volume participation cap, the cap
--          rounded DOWN to the lot size (a cap within 1e-9 lot below a lot boundary is refused as ambiguous); q > 0
--          must be filled exactly once at the open at the taker price (0049 recomputes price, fee and margin), unless the
--          database ITSELF refuses that fill: a cancellation "fill refused [CODE]" is accepted only if a trial of the
--          very fill inside the same transaction (rolled back) is refused by 0049's own fill checks with the same
--          CODE — a worker can never claim a refusal the database would not make;
--       5. after the fill: nothing left → approval filled, no cancellation; candles waited ≥ entryTtlBars → cancel the
--          rest at the open (time limit); the position closed in this candle → cancel the rest at the close;
--          otherwise the approval stays open and nothing may be cancelled.
--     Duplicate, missing, excessive, contradictory or unexplained fills/cancellations are refused; an identical replay
--     returns the committed sequence without writing; the per-entry result is kept in futures_paper_entry_checks.
--  B  STOPPED ACCOUNT WITH OPEN POSITIONS — EXIT ONLY. 0049 refused every commit of a stopped account, which froze its
--     exits (Phase 4H finding R5). 0052 replaces futures_paper_commit_bar_v3 with 0049's body changed in exactly two
--     places (pinned by a test): a stopped account may commit while it holds a position or a pending entry (a flat
--     stopped account is still refused), and a fill-refusal cancellation is verified as in A.4. Entries stay refused
--     for any account that is not active or is halted (0049), so a stopped account can only cancel its pending
--     remainder, pay/receive funding and close positions in full (0049: close quantity = open quantity, no reversal),
--     with 0051's funding/exit completeness and no-gap rules applying to stopped accounts too. The commit never changes
--     status or halted; a stopped account stays stopped for ever (0049) and a halt is lifted only by an explicit,
--     audited manual change.
--  C  TIMING AND ROUNDING — CONSERVATIVE. No new tolerance is introduced: 0052 reuses 0049's 1e-9 relative comparison
--     and 0051's 1e-9 ambiguity band; every value is listed in docs/phase-4h/timing-and-rounding-register.md and is
--     NOT APPROVED.
--  Configuration audit trail (owner request §5): every INSERT/UPDATE of account and strategy budgets (including the
--     Research and Scalping sub-budgets), cost assumptions/overrides, account policy configuration (frozen at account
--     creation) and account status/halt writes one append-only, hash-chained futures_paper_config_changes record with
--     old value, new value, actor, timestamp, reason and per-entity version + SHA-256. A budget, cost or account write
--     WITHOUT a reason (transaction setting futures_paper.change_reason) is refused, so nothing changes silently. The
--     record approves nothing.
-- =====================================================================================================================
DO $$ BEGIN
  IF to_regprocedure('public.futures_paper_commit_bar_v4(uuid,bigint,bigint,jsonb)') IS NULL OR to_regclass('public.futures_paper_candle_checks') IS NULL
     OR to_regprocedure('public.fpw_commit(uuid,uuid,bigint,bigint,bigint,jsonb,jsonb)') IS NULL OR to_regclass('public.futures_paper_worker_leases') IS NULL THEN
    RAISE EXCEPTION '0052 requires drafts 0049, 0050 and 0051 to be applied first';
  END IF;
END $$;

-- What the database derived for every pending entry of every committed candle (append-only evidence).
CREATE TABLE public.futures_paper_entry_checks (
  account_id uuid NOT NULL,
  bar_t bigint NOT NULL,
  proposal_id text NOT NULL,
  user_id uuid NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT','ETHUSDT')),
  outcome text NOT NULL CHECK (outcome IN ('filled','partial','unfilled','cancelled_expired','cancelled_halted','cancelled_not_active','cancelled_refused','cancelled_ttl','cancelled_closed')),
  bars_waited integer NOT NULL CHECK (bars_waited >= 1),
  remaining_before numeric NOT NULL CHECK (public.fp2_finite(remaining_before) AND remaining_before > 0),
  required_qty numeric CHECK (required_qty IS NULL OR (public.fp2_finite(required_qty) AND required_qty >= 0)),
  filled_qty numeric NOT NULL CHECK (public.fp2_finite(filled_qty) AND filled_qty >= 0),
  cancelled_qty numeric NOT NULL CHECK (public.fp2_finite(cancelled_qty) AND cancelled_qty >= 0),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z_]{1,40}$'),
  PRIMARY KEY (account_id, bar_t, proposal_id),
  FOREIGN KEY (account_id, proposal_id) REFERENCES public.futures_paper_risk_approvals(account_id, proposal_id),
  FOREIGN KEY (account_id, bar_t) REFERENCES public.futures_paper_commits(account_id, bar_t),
  CONSTRAINT futures_paper_entry_check_reason CHECK ((outcome LIKE 'cancelled_%') = (reason_code IS NOT NULL))
);
CREATE INDEX futures_paper_entry_checks_user ON public.futures_paper_entry_checks (user_id, account_id, bar_t DESC);
CREATE TRIGGER futures_paper_entry_checks_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_entry_checks FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_entry_checks_no_truncate BEFORE TRUNCATE ON public.futures_paper_entry_checks FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_entry_checks_guard BEFORE INSERT ON public.futures_paper_entry_checks FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_book();

-- Configuration-change audit trail (append-only, hash-chained per entity; written only by fp5_audit_config).
CREATE TABLE public.futures_paper_config_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  entity text NOT NULL CHECK (entity IN ('account_budget','strategy_budget','cost_assumption','account_config','account_status')),
  entity_key text NOT NULL CHECK (length(entity_key) BETWEEN 1 AND 300),
  operation text NOT NULL CHECK (operation IN ('INSERT','UPDATE')),
  old_value jsonb,
  new_value jsonb NOT NULL,
  actor_role text NOT NULL CHECK (length(actor_role) BETWEEN 1 AND 64),
  actor_uid uuid,
  actor_label text CHECK (actor_label IS NULL OR length(actor_label) BETWEEN 1 AND 64),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  version integer NOT NULL CHECK (version >= 1),
  value_sha256 text NOT NULL CHECK (value_sha256 ~ '^[0-9a-f]{64}$'),
  prev_sha256 text CHECK (prev_sha256 IS NULL OR prev_sha256 ~ '^[0-9a-f]{64}$'),
  chain_sha256 text NOT NULL CHECK (chain_sha256 ~ '^[0-9a-f]{64}$'),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (entity, user_id, entity_key, version),
  CONSTRAINT futures_paper_config_change_shape CHECK ((operation = 'INSERT') = (old_value IS NULL) AND (version = 1) = (prev_sha256 IS NULL))
);
CREATE INDEX futures_paper_config_changes_user ON public.futures_paper_config_changes (user_id, entity, entity_key, version DESC);
CREATE TRIGGER futures_paper_config_changes_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_config_changes FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_config_changes_no_truncate BEFORE TRUNCATE ON public.futures_paper_config_changes FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();

CREATE FUNCTION public.fp5_audit_config() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_entity text; v_key text; v_old jsonb; v_new jsonb; v_reason text; v_label text; v_role text; v_claims text;
  v_prev public.futures_paper_config_changes%ROWTYPE; v_ver integer; v_hash text; v_user uuid;
BEGIN
  v_user := NEW.user_id;
  IF TG_TABLE_NAME = 'account_risk_budgets' THEN
    v_entity := 'account_budget'; v_key := NEW.environment;
    v_new := to_jsonb(NEW) - 'created_at' - 'updated_at'; v_old := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) - 'created_at' - 'updated_at' END;
  ELSIF TG_TABLE_NAME = 'strategy_risk_budgets' THEN
    v_entity := 'strategy_budget'; v_key := NEW.environment || ':' || NEW.strategy_id;
    v_new := to_jsonb(NEW) - 'created_at' - 'updated_at'; v_old := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) - 'created_at' - 'updated_at' END;
  ELSIF TG_TABLE_NAME = 'futures_paper_cost_assumptions' THEN
    v_entity := 'cost_assumption'; v_key := NEW.strategy_id || ':' || NEW.symbol;
    v_new := to_jsonb(NEW) - 'created_at' - 'updated_at'; v_old := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) - 'created_at' - 'updated_at' END;
  ELSIF TG_TABLE_NAME = 'futures_paper_accounts' AND TG_OP = 'INSERT' THEN
    v_entity := 'account_config'; v_key := NEW.id::text;
    v_new := jsonb_build_object('config', NEW.config, 'config_sha256', NEW.config_sha256, 'engine_version', NEW.engine_version, 'data_source', NEW.data_source,
                                'symbols', to_jsonb(NEW.symbols), 'timeframe', NEW.timeframe, 'starting_balance', NEW.starting_balance, 'status', NEW.status, 'halted', NEW.halted);
  ELSIF TG_TABLE_NAME = 'futures_paper_accounts' THEN
    v_entity := 'account_status'; v_key := NEW.id::text;
    v_new := jsonb_build_object('status', NEW.status, 'halted', NEW.halted, 'status_reason', NEW.status_reason);
    v_old := jsonb_build_object('status', OLD.status, 'halted', OLD.halted, 'status_reason', OLD.status_reason);
  ELSE
    RAISE EXCEPTION 'fp5_audit_config: unexpected table %', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'UPDATE' AND v_old IS NOT DISTINCT FROM v_new THEN RETURN NULL; END IF;  -- timestamps only: nothing changed
  v_reason := nullif(btrim(coalesce(current_setting('futures_paper.change_reason', true), '')), '');
  IF v_reason IS NULL AND v_entity = 'account_status' THEN v_reason := nullif(btrim(coalesce(NEW.status_reason, '')), ''); END IF;
  IF v_reason IS NULL OR length(v_reason) < 3 THEN
    RAISE EXCEPTION 'futures paper configuration change refused: % % needs a reason of at least 3 characters (transaction setting futures_paper.change_reason)', v_entity, lower(TG_OP);
  END IF;
  v_reason := left(v_reason, 500);
  v_label := left(coalesce(nullif(current_setting('futures_paper.worker_actor', true), ''), nullif(current_setting('futures_paper.change_actor', true), '')), 64);
  v_claims := nullif(current_setting('request.jwt.claims', true), '');
  v_role := left(coalesce(CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb->>'role' END, nullif(current_setting('role', true), 'none'), session_user::text), 64);
  -- Serialize writers of the same entity (versions never fork).
  PERFORM pg_advisory_xact_lock(hashtextextended('futures_paper_config:' || v_entity || ':' || v_user::text || ':' || v_key, 0));
  SELECT * INTO v_prev FROM public.futures_paper_config_changes
   WHERE entity = v_entity AND user_id = v_user AND entity_key = v_key ORDER BY version DESC LIMIT 1;
  v_ver := coalesce(v_prev.version, 0) + 1;
  v_hash := encode(sha256(convert_to(v_new::text, 'UTF8')), 'hex');
  INSERT INTO public.futures_paper_config_changes (user_id, entity, entity_key, operation, old_value, new_value, actor_role, actor_uid, actor_label, reason, version,
                                                   value_sha256, prev_sha256, chain_sha256)
  VALUES (v_user, v_entity, v_key, TG_OP, v_old, v_new, v_role, auth.uid(), v_label, v_reason, v_ver, v_hash, v_prev.chain_sha256,
          encode(sha256(convert_to(concat_ws('|', coalesce(v_prev.chain_sha256, 'genesis'), v_entity, v_user::text, v_key, v_ver::text, TG_OP, v_hash, v_reason), 'UTF8')), 'hex'));
  RETURN NULL;
END $$;
CREATE TRIGGER account_risk_budgets_config_audit AFTER INSERT OR UPDATE ON public.account_risk_budgets FOR EACH ROW EXECUTE FUNCTION public.fp5_audit_config();
CREATE TRIGGER strategy_risk_budgets_config_audit AFTER INSERT OR UPDATE ON public.strategy_risk_budgets FOR EACH ROW EXECUTE FUNCTION public.fp5_audit_config();
CREATE TRIGGER futures_paper_cost_config_audit AFTER INSERT OR UPDATE ON public.futures_paper_cost_assumptions FOR EACH ROW EXECUTE FUNCTION public.fp5_audit_config();
CREATE TRIGGER futures_paper_accounts_config_audit AFTER INSERT ON public.futures_paper_accounts FOR EACH ROW EXECUTE FUNCTION public.fp5_audit_config();
CREATE TRIGGER futures_paper_accounts_status_config_audit AFTER UPDATE ON public.futures_paper_accounts FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.halted IS DISTINCT FROM NEW.halted OR OLD.status_reason IS DISTINCT FROM NEW.status_reason)
  EXECUTE FUNCTION public.fp5_audit_config();

-- ---------- helpers ----------
-- Required fill quantity of a pending entry at this candle's open, from the database's own records only: the whole
-- remainder, or with a volume participation cap (frozen account config costs.maxParticipationPct; null = no cap) the
-- cap rounded DOWN to the lot size. A cap within 1e-9 lot below a lot boundary is refused as ambiguous (never guessed).
CREATE FUNCTION public.fp5_required_fill_qty(p_account uuid, p_symbol text, p_bar_t bigint, p_left numeric) RETURNS numeric
LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $$
DECLARE a public.futures_paper_accounts%ROWTYPE; c public.futures_paper_candles%ROWTYPE; v_pct jsonb; v_cap numeric; v_step numeric; x numeric; n numeric;
BEGIN
  SELECT * INTO a FROM public.futures_paper_accounts WHERE id = p_account;
  SELECT * INTO c FROM public.futures_paper_candles WHERE account_id = p_account AND bar_t = p_bar_t AND symbol = p_symbol;
  IF NOT FOUND THEN RAISE EXCEPTION 'futures paper completeness: no recorded candle for the pending % entry; the required fill cannot be derived', p_symbol; END IF;
  IF p_left IS NULL OR NOT (p_left > 0) THEN RAISE EXCEPTION 'futures paper completeness: pending % entry has no remainder', p_symbol; END IF;
  v_step := public.fp2_num(a.config->'specs'->p_symbol, 'stepSize');
  IF jsonb_typeof(a.config->'costs') IS DISTINCT FROM 'object' OR NOT (a.config->'costs' ? 'maxParticipationPct') THEN
    RAISE EXCEPTION 'futures paper completeness: the account config has no costs.maxParticipationPct (null or 0..100); the required fill cannot be derived';
  END IF;
  v_pct := a.config->'costs'->'maxParticipationPct';
  IF jsonb_typeof(v_pct) = 'null' THEN
    RETURN p_left;
  ELSIF jsonb_typeof(v_pct) = 'number' AND (v_pct #>> '{}')::numeric BETWEEN 0 AND 100 THEN
    v_cap := c.volume * (v_pct #>> '{}')::numeric / 100;
  ELSE
    RAISE EXCEPTION 'futures paper completeness: costs.maxParticipationPct must be null or a number in 0..100; the required fill cannot be derived';
  END IF;
  IF p_left <= v_cap THEN RETURN p_left; END IF;
  x := v_cap / v_step; n := floor(x);
  IF x > n AND (n + 1) - x <= 0.000000001 THEN
    RAISE EXCEPTION 'futures paper completeness: ambiguous fill quantity for % (volume cap % is within rounding of % lots)', p_symbol, v_cap, n + 1;
  END IF;
  RETURN n * v_step;
END $$;

-- A cancellation that claims "fill refused [CODE]" is accepted only if the database itself refuses that fill: the fill
-- the recorded candle implies is tried with 0049's own fill checks inside a sub-transaction that is always rolled back,
-- and the refusal it raises must map to the same CODE. Called from futures_paper_commit_bar_v3 (0052 body) at the
-- cancellation event, so the trial sees exactly the book, wallet and day cash the real fill would have seen.
CREATE FUNCTION public.fp5_verify_fill_refusal(p_account uuid, p_proposal text, p_bar_t bigint, p_t bigint, p_candles jsonb, p_wallet numeric, p_reason text) RETURNS void
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  a public.futures_paper_accounts%ROWTYPE; r public.futures_paper_risk_approvals%ROWTYPE; b public.futures_paper_positions%ROWTYPE;
  v_claim text; v_db text; v_msg text; v_allowed boolean := false; v_found boolean;
  v_q numeric; v_dir integer; v_adj numeric; v_price numeric; v_fee numeric; v_md numeric; v_risk numeric; v_step numeric;
BEGIN
  v_claim := substring(p_reason from '^fill refused \[([A-Z_]+)\]');
  IF v_claim IS NULL THEN RETURN; END IF;  -- not a fill-refusal cancellation: futures_paper_commit_bar_v5 classifies it
  SELECT * INTO a FROM public.futures_paper_accounts WHERE id = p_account;
  SELECT * INTO r FROM public.futures_paper_risk_approvals WHERE account_id = p_account AND proposal_id = p_proposal;
  IF p_t <> p_bar_t OR r.approved_bar_t >= p_bar_t OR a.status <> 'active' OR a.halted OR p_bar_t > r.expires_t THEN
    IF v_claim IN ('ACCOUNT_HALTED', 'ACCOUNT_NOT_ACTIVE', 'FILL_APPROVAL_EXPIRED') THEN RETURN; END IF;  -- checked against the account/approval by v5
    RAISE EXCEPTION 'futures paper completeness: cancellation of % claims a fill refusal [%], but no fill was due at %', p_proposal, v_claim, p_t;
  END IF;
  IF v_claim IN ('ACCOUNT_HALTED', 'ACCOUNT_NOT_ACTIVE', 'FILL_APPROVAL_EXPIRED') THEN
    RAISE EXCEPTION 'futures paper completeness: cancellation of % claims [%], but the account is active, not halted and the approval has not expired', p_proposal, v_claim;
  END IF;
  IF EXISTS (SELECT 1 FROM public.futures_paper_events WHERE account_id = p_account AND bar_t = p_bar_t AND proposal_id = p_proposal AND kind = 'entry_fill') THEN
    RAISE EXCEPTION 'futures paper completeness: cancellation of % claims a fill refusal after a fill in the same candle', p_proposal;
  END IF;
  v_q := public.fp5_required_fill_qty(p_account, r.symbol, p_bar_t, r.approved_qty - r.filled_qty);
  IF v_q = 0 THEN RAISE EXCEPTION 'futures paper completeness: cancellation of % claims a fill refusal [%], but the recorded volume cap implies no fill', p_proposal, v_claim; END IF;
  -- Trial of the implied fill: the same checks, in the same order, as 0049's entry_fill branch; always rolled back.
  BEGIN
    v_dir := CASE r.side WHEN 'LONG' THEN 1 ELSE -1 END;
    v_adj := a.cost_spread_pct / 200 + a.cost_slippage_pct / 100;
    v_step := public.fp2_num(a.config->'specs'->r.symbol, 'stepSize');
    v_price := public.fp2_num(p_candles->r.symbol->'trade', 'o') * (1 + v_dir * v_adj);
    v_fee := v_price * v_q * a.cost_taker_fee_pct / 100; v_md := v_price * v_q / r.leverage;
    SELECT * INTO b FROM public.futures_paper_positions WHERE account_id = p_account AND symbol = r.symbol;
    v_found := FOUND;
    IF v_found AND (b.side IS DISTINCT FROM r.side OR b.strategy_id IS DISTINCT FROM r.strategy_id OR b.proposal_id IS DISTINCT FROM r.proposal_id) THEN
      RAISE EXCEPTION 'entry fill does not match the open % position', r.symbol;
    END IF;
    IF public.fp3_daily_left(p_account, p_bar_t, p_candles, 'o') <= 0 THEN RAISE EXCEPTION 'daily loss limit reached: entry fill refused'; END IF;
    v_risk := v_q * r.stop_dist + v_q * v_price * r.cost_pct / 100;
    UPDATE public.futures_paper_risk_approvals SET filled_qty = filled_qty + v_q,
           status = CASE WHEN approved_qty - (filled_qty + v_q) <= v_step / 2 THEN 'filled' ELSE 'open' END,
           closed_seq = CASE WHEN approved_qty - (filled_qty + v_q) <= v_step / 2 THEN a.seq + 1 ELSE NULL END
     WHERE account_id = p_account AND proposal_id = p_proposal;
    IF p_wallet - v_fee < 0 THEN RAISE EXCEPTION 'simulated wallet would go negative'; END IF;
    IF v_found THEN
      UPDATE public.futures_paper_positions SET entry_price = (entry_price * qty + v_price * v_q) / (qty + v_q), qty = qty + v_q,
             margin = margin + v_md, risk_reserved = risk_reserved + v_risk WHERE account_id = p_account AND symbol = r.symbol;
    ELSE
      INSERT INTO public.futures_paper_positions (account_id, user_id, symbol, side, qty, entry_price, margin, leverage, stop_dist, risk_reserved, strategy_id, proposal_id, opened_bar_t, updated_seq)
      VALUES (p_account, a.user_id, r.symbol, r.side, v_q, v_price, v_md, r.leverage, r.stop_dist, v_risk, r.strategy_id, r.proposal_id, p_bar_t, a.seq + 1);
    END IF;
    PERFORM public.fp3_check_account(p_account, p_candles, 'o', p_wallet - v_fee, r.strategy_id, 'fill');
    RAISE EXCEPTION 'futures paper trial: fill permitted' USING ERRCODE = 'FP501';
  EXCEPTION
    WHEN SQLSTATE 'FP501' THEN v_allowed := true;
    WHEN raise_exception THEN v_msg := SQLERRM;
  END;
  IF v_allowed THEN
    RAISE EXCEPTION 'futures paper completeness: cancellation of % [%] refused: the database permits the fill of % at the open', p_proposal, v_claim, v_q;
  END IF;
  v_db := CASE
    WHEN v_msg ~ 'daily loss limit reached: entry fill refused' THEN 'DAILY_LOSS_LIMIT'
    WHEN v_msg ~ 'no paper account risk budget: fill refused' OR v_msg ~ 'no paper risk budget for strategy \S+: entry fill refused' THEN 'STRATEGY_BUDGET_MISSING'
    WHEN v_msg ~ 'budget \S+ would be exceeded at fill' THEN 'STRATEGY_BUDGET_EXCEEDED'
    WHEN v_msg ~ 'exposure \S+ would exceed \S+ at fill' THEN 'EXPOSURE_LIMIT'
    WHEN v_msg ~ 'position limit \S+ exceeded at fill' THEN 'POSITION_LIMIT'
    WHEN v_msg ~ 'free margin would be negative at fill' OR v_msg ~ 'simulated wallet would go negative' THEN 'FREE_MARGIN'
    WHEN v_msg ~ 'entry fill does not match the open \S+ position' THEN 'STRATEGY_IDENTITY_MISMATCH'
  END;
  IF v_db IS NULL THEN RAISE EXCEPTION 'futures paper completeness: the database refusal of the % fill could not be classified; the cancellation cannot be verified', p_proposal; END IF;
  IF v_db <> v_claim THEN
    RAISE EXCEPTION 'futures paper completeness: cancellation reason [%] for % differs from the database refusal [%]', v_claim, p_proposal, v_db;
  END IF;
END $$;

-- ---------- 0049's commit, changed in exactly two places (stopped accounts with exposure; verified fill refusals) ----------
CREATE OR REPLACE FUNCTION public.futures_paper_commit_bar_v3(p_account uuid, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb)
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

  IF a.status = 'stopped' AND NOT EXISTS (SELECT 1 FROM public.futures_paper_positions WHERE account_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND status = 'open') THEN
    RAISE EXCEPTION 'futures paper account is stopped';  -- 0052 (decision B): a stopped account with exposure commits exit-only candles
  END IF;
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
      PERFORM public.fp5_verify_fill_refusal(a.id, r.proposal_id, p_bar_t, v_t, cs, v_wallet, public.fp2_txt(e, 'reason', false));  -- 0052 (decision A)
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

-- ---------- the entry-completeness-checked commit (wraps 0051's v4, which wraps the v3 above, in one transaction) ----------
CREATE FUNCTION public.futures_paper_commit_bar_v5(p_account uuid, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  a public.futures_paper_accounts%ROWTYPE; r public.futures_paper_risk_approvals%ROWTYPE; x record;
  v_open jsonb; v_seq0 bigint; v_seq bigint; v_ttl bigint; v_step numeric; v_w bigint; v_req numeric; v_gate text; v_out text; v_code text; v_rest numeric;
  n_fill integer; f_qty numeric; f_t bigint; f_seq bigint;
  n_cancel integer; c_qty numeric; c_t bigint; c_seq bigint; c_reason text;
  x_seq bigint; x_t bigint;
BEGIN
  IF p_account IS NULL OR p_expected_seq IS NULL OR p_bar_t IS NULL OR p_payload IS NULL THEN
    RAISE EXCEPTION 'futures paper commit: account, expected sequence, candle and payload are all required';
  END IF;
  SELECT * INTO a FROM public.futures_paper_accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'futures paper account not found'; END IF;
  -- Identical replay (or a conflicting payload for a committed candle): 0049 answers without writing.
  IF EXISTS (SELECT 1 FROM public.futures_paper_commits WHERE account_id = a.id AND bar_t = p_bar_t) THEN
    RETURN public.futures_paper_commit_bar_v4(p_account, p_expected_seq, p_bar_t, p_payload);
  END IF;
  -- C4 for every status, stopped included (0051 exempted stopped accounts, which could not commit before 0052).
  IF p_bar_t > a.cursor_t AND p_bar_t <> a.cursor_t + a.tf_ms
     AND (EXISTS (SELECT 1 FROM public.futures_paper_positions WHERE account_id = a.id)
          OR EXISTS (SELECT 1 FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND status = 'open')) THEN
    RAISE EXCEPTION 'futures paper completeness: candle % skips % candle(s) while a position or pending entry exists; every candle must be committed in order',
      p_bar_t, (p_bar_t - a.cursor_t) / a.tf_ms - 1;
  END IF;
  -- Pending entries at the candle open (the account row is locked: only a commit holding this lock changes them).
  v_open := coalesce((SELECT jsonb_agg(jsonb_build_object('proposal_id', proposal_id, 'symbol', symbol, 'left_qty', approved_qty - filled_qty,
                                                          'approved_bar_t', approved_bar_t, 'expires_t', expires_t) ORDER BY symbol)
                        FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND status = 'open'), '[]'::jsonb);
  IF jsonb_array_length(v_open) > 0 THEN
    IF jsonb_typeof(a.config->'entryTtlBars') IS DISTINCT FROM 'number' OR public.fp2_int(a.config, 'entryTtlBars') NOT BETWEEN 1 AND 100000 THEN
      RAISE EXCEPTION 'futures paper completeness: the account config has no valid entryTtlBars (1..100000); pending entries cannot be verified';
    END IF;
    v_ttl := public.fp2_int(a.config, 'entryTtlBars');
  END IF;
  v_seq0 := a.seq;

  v_seq := public.futures_paper_commit_bar_v4(p_account, p_expected_seq, p_bar_t, p_payload);  -- 0049 + 0051 checks
  PERFORM set_config('futures_paper.commit', 'on', true);

  FOR x IN SELECT j->>'proposal_id' AS proposal_id, j->>'symbol' AS symbol, (j->>'left_qty')::numeric AS left_qty,
                  (j->>'approved_bar_t')::bigint AS approved_bar_t, (j->>'expires_t')::bigint AS expires_t
             FROM jsonb_array_elements(v_open) j LOOP
    SELECT * INTO r FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND proposal_id = x.proposal_id;
    v_step := public.fp2_num(a.config->'specs'->x.symbol, 'stepSize');
    v_w := (p_bar_t - x.approved_bar_t) / a.tf_ms;
    IF (p_bar_t - x.approved_bar_t) % a.tf_ms <> 0 OR v_w < 1 OR v_w > v_ttl THEN
      RAISE EXCEPTION 'futures paper completeness: the pending % entry (%) has waited % candle(s) (limit %); it cannot be verified', x.symbol, x.proposal_id, v_w, v_ttl;
    END IF;
    SELECT count(*), sum(qty), min(t), min(seq) INTO n_fill, f_qty, f_t, f_seq FROM public.futures_paper_events
     WHERE account_id = a.id AND seq > v_seq0 AND proposal_id = x.proposal_id AND kind = 'entry_fill';
    SELECT count(*), sum(qty), min(t), min(seq), min(reason) INTO n_cancel, c_qty, c_t, c_seq, c_reason FROM public.futures_paper_events
     WHERE account_id = a.id AND seq > v_seq0 AND proposal_id = x.proposal_id AND kind = 'entry_cancelled';
    SELECT min(seq), min(t) INTO x_seq, x_t FROM public.futures_paper_events
     WHERE account_id = a.id AND seq > v_seq0 AND symbol = x.symbol AND kind IN ('exit_fill', 'liquidation');
    IF n_fill > 1 THEN RAISE EXCEPTION 'futures paper completeness: % entry fills for % (%) in candle %; at most one fill per candle (at its open) is permitted', n_fill, x.symbol, x.proposal_id, p_bar_t; END IF;
    IF n_cancel > 1 THEN RAISE EXCEPTION 'futures paper completeness: % cancellations for % (%) in candle %', n_cancel, x.symbol, x.proposal_id, p_bar_t; END IF;
    v_code := substring(c_reason from '\[([A-Z_]+)\]');
    v_req := NULL;
    v_gate := CASE WHEN p_bar_t > x.expires_t THEN 'expired' WHEN a.halted THEN 'halted' WHEN a.status <> 'active' THEN 'not_active' END;
    IF v_gate IS NOT NULL THEN
      -- 1–3: no fill is permitted; the whole remainder is cancelled at the open with the database-derived reason.
      IF n_fill <> 0 OR n_cancel <> 1 OR c_t IS DISTINCT FROM p_bar_t THEN
        RAISE EXCEPTION 'futures paper completeness: the pending % entry (%) must be cancelled at the candle open with no fill (%; account %, halted %)',
          x.symbol, x.proposal_id, v_gate, a.status, a.halted;
      END IF;
      IF NOT coalesce(CASE v_gate WHEN 'expired' THEN v_code IN ('APPROVAL_EXPIRED', 'FILL_APPROVAL_EXPIRED') WHEN 'halted' THEN v_code = 'ACCOUNT_HALTED' ELSE v_code = 'ACCOUNT_NOT_ACTIVE' END, false) THEN
        RAISE EXCEPTION 'futures paper completeness: cancellation reason [%] of % does not match the database-derived reason (%)', coalesce(v_code, 'none'), x.proposal_id, v_gate;
      END IF;
      v_out := 'cancelled_' || v_gate;
    ELSIF n_fill = 0 AND n_cancel = 1 AND c_t = p_bar_t AND c_reason ~ '^fill refused \[' THEN
      -- 4: the database itself refused the implied fill (fp5_verify_fill_refusal ran inside this commit, same code).
      v_req := public.fp5_required_fill_qty(a.id, x.symbol, p_bar_t, x.left_qty);
      v_out := 'cancelled_refused';
    ELSE
      v_req := public.fp5_required_fill_qty(a.id, x.symbol, p_bar_t, x.left_qty);
      IF v_req > 0 AND (n_fill <> 1 OR f_t IS DISTINCT FROM p_bar_t OR NOT public.fp3_near(f_qty, v_req)) THEN
        RAISE EXCEPTION 'futures paper completeness: the recorded candle requires an entry fill of % for % (%) at % but % was submitted',
          v_req, x.symbol, x.proposal_id, p_bar_t, coalesce(f_qty::text || ' at ' || f_t::text, 'none');
      END IF;
      IF v_req = 0 AND n_fill <> 0 THEN
        RAISE EXCEPTION 'futures paper completeness: entry fill of % for % submitted, but the recorded volume cap allows none', f_qty, x.symbol;
      END IF;
      v_rest := x.left_qty - coalesce(f_qty, 0);
      IF v_rest <= v_step / 2 THEN
        IF n_cancel <> 0 OR r.status <> 'filled' THEN
          RAISE EXCEPTION 'futures paper completeness: the % entry (%) is completely filled; nothing may be cancelled', x.symbol, x.proposal_id;
        END IF;
        v_out := 'filled';
      ELSIF v_w >= v_ttl THEN
        IF n_cancel <> 1 OR c_t IS DISTINCT FROM p_bar_t OR c_seq < coalesce(f_seq, 0) OR c_reason IS DISTINCT FROM 'unfilled remainder cancelled at its time limit' THEN
          RAISE EXCEPTION 'futures paper completeness: the % entry (%) reached its time limit of % candle(s); its remainder % must be cancelled at the open (reason: time limit)',
            x.symbol, x.proposal_id, v_ttl, v_rest;
        END IF;
        v_out := 'cancelled_ttl';
      ELSIF x_seq IS NOT NULL THEN
        IF n_cancel <> 1 OR c_t IS DISTINCT FROM x_t OR c_seq < x_seq OR c_reason IS DISTINCT FROM 'position closed: remainder cancelled' THEN
          RAISE EXCEPTION 'futures paper completeness: the % position closed in candle %; its pending remainder % must be cancelled at the close (reason: position closed)',
            x.symbol, p_bar_t, v_rest;
        END IF;
        v_out := 'cancelled_closed';
      ELSE
        IF n_cancel <> 0 OR r.status <> 'open' THEN
          RAISE EXCEPTION 'futures paper completeness: cancellation of the % entry (%) has no valid reason (not expired, halted, inactive, refused, at its time limit or closed)',
            x.symbol, x.proposal_id;
        END IF;
        v_out := CASE WHEN coalesce(f_qty, 0) > 0 THEN 'partial' ELSE 'unfilled' END;
      END IF;
    END IF;
    INSERT INTO public.futures_paper_entry_checks (account_id, bar_t, proposal_id, user_id, symbol, outcome, bars_waited, remaining_before, required_qty, filled_qty, cancelled_qty, reason_code)
    VALUES (a.id, p_bar_t, x.proposal_id, a.user_id, x.symbol, v_out, v_w, x.left_qty, v_req, coalesce(f_qty, 0), coalesce(c_qty, 0),
            CASE WHEN v_out = 'cancelled_ttl' THEN 'TIME_LIMIT' WHEN v_out = 'cancelled_closed' THEN 'POSITION_CLOSED' WHEN v_out LIKE 'cancelled_%' THEN v_code END);
  END LOOP;
  PERFORM set_config('futures_paper.commit', 'off', true);
  RETURN v_seq;
END $$;

-- ---------- the gateway now commits through v5 (0051's body, unchanged except for the called function) ----------
-- CREATE OR REPLACE keeps 0050's grants: EXECUTE for service_role only.
CREATE OR REPLACE FUNCTION public.fpw_commit(p_account uuid, p_holder uuid, p_fence bigint, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb, p_provenance jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  l public.futures_paper_worker_leases%ROWTYPE; a public.futures_paper_accounts%ROWTYPE; pv jsonb; k text;
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint; v_seq bigint; v_replay boolean; v_fetched bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'futures paper worker: commits must run at READ COMMITTED (found %)', current_setting('transaction_isolation');
  END IF;
  SELECT * INTO l FROM public.futures_paper_worker_leases WHERE account_id = p_account FOR UPDATE;
  IF NOT FOUND OR l.holder IS DISTINCT FROM p_holder OR l.fence IS DISTINCT FROM p_fence OR l.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'futures paper worker lease lost';
  END IF;
  SELECT * INTO a FROM public.futures_paper_accounts WHERE id = p_account;
  v_replay := EXISTS (SELECT 1 FROM public.futures_paper_commits WHERE account_id = p_account AND bar_t = p_bar_t);
  IF NOT v_replay THEN
    IF jsonb_typeof(p_payload) = 'object' AND jsonb_typeof(p_payload->'events') = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'events') x WHERE x->>'kind' = 'order_accepted')
       AND v_now - (p_bar_t + a.tf_ms) > a.limit_max_data_age_ms THEN
      RAISE EXCEPTION 'futures paper worker: candle % closed % ms ago; new entries need data younger than % ms', p_bar_t, v_now - (p_bar_t + a.tf_ms), a.limit_max_data_age_ms;
    END IF;
    IF jsonb_typeof(p_provenance) IS DISTINCT FROM 'array' OR jsonb_typeof(p_payload->'candles') IS DISTINCT FROM 'object'
       OR jsonb_array_length(p_provenance) <> (SELECT count(*) FROM jsonb_object_keys(p_payload->'candles'))
       OR (SELECT count(DISTINCT x->>'symbol') FROM jsonb_array_elements(p_provenance) x) <> jsonb_array_length(p_provenance) THEN
      RAISE EXCEPTION 'futures paper worker: provenance must cover exactly the recorded candles, once each';
    END IF;
    FOR pv IN SELECT * FROM jsonb_array_elements(p_provenance) LOOP
      k := public.fp2_txt(pv, 'symbol', false);
      IF jsonb_typeof(p_payload->'candles'->k) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'futures paper worker: provenance for % has no recorded candle', k; END IF;
      IF public.fp2_txt(pv, 'source', false) IS DISTINCT FROM a.data_source OR public.fp2_txt(pv, 'timeframe', false) IS DISTINCT FROM a.timeframe
         OR public.fp2_int(pv, 'open_t') IS DISTINCT FROM p_bar_t OR public.fp2_int(pv, 'close_t') IS DISTINCT FROM p_bar_t + a.tf_ms - 1 THEN
        RAISE EXCEPTION 'futures paper worker: provenance for % does not match the account source, timeframe or candle times', k;
      END IF;
      v_fetched := public.fp2_int(pv, 'fetched_at');
      IF v_fetched <= p_bar_t + a.tf_ms - 1 OR v_fetched > v_now + 5000 OR v_now - v_fetched > 900000 THEN
        RAISE EXCEPTION 'futures paper worker: provenance for % was fetched before the close, in the future or too long ago', k;
      END IF;
      IF public.fp2_txt(pv, 'raw_sha256', false) !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'futures paper worker: provenance for % needs a raw payload SHA-256', k; END IF;
      IF pv->'independently_verified' IS DISTINCT FROM 'false'::jsonb THEN
        RAISE EXCEPTION 'futures paper worker: provenance for % must state independently_verified = false (prices are not verified)', k;
      END IF;
    END LOOP;
  END IF;

  v_seq := public.futures_paper_commit_bar_v5(p_account, p_expected_seq, p_bar_t, p_payload);

  IF NOT v_replay THEN
    INSERT INTO public.futures_paper_candle_provenance (account_id, bar_t, symbol, user_id, source, timeframe, open_t, close_t, fetched_at, recorded_at, raw_sha256, recorded_sha256, ohlc_sha256)
    SELECT p_account, p_bar_t, x->>'symbol', a.user_id, x->>'source', a.timeframe, p_bar_t, (x->>'close_t')::bigint, (x->>'fetched_at')::bigint, v_now, x->>'raw_sha256',
           public.fpw_candle_digest(p_account, p_bar_t, x->>'symbol', true), public.fpw_candle_digest(p_account, p_bar_t, x->>'symbol', false)
      FROM jsonb_array_elements(p_provenance) x;
    IF EXISTS (SELECT 1 FROM public.futures_paper_candle_provenance n JOIN public.futures_paper_candle_provenance o
                 ON o.symbol = n.symbol AND o.timeframe = n.timeframe AND o.open_t = n.open_t AND o.account_id <> n.account_id AND o.ohlc_sha256 <> n.ohlc_sha256
                WHERE n.account_id = p_account AND n.bar_t = p_bar_t) THEN
      RAISE EXCEPTION 'futures paper worker: candle % conflicts with the same public candle recorded for another account', p_bar_t;
    END IF;
  END IF;
  UPDATE public.futures_paper_worker_leases SET expires_at = clock_timestamp() + make_interval(secs => l.ttl_seconds) WHERE account_id = p_account;
  RETURN v_seq;
END $$;

-- Rollback-order guard: 0051's rollback (DROP TABLE futures_paper_candle_checks, no CASCADE) fails while 0052 exists.
CREATE VIEW public.futures_paper_0052_requires_0051 AS SELECT account_id FROM public.futures_paper_candle_checks WHERE false;

-- ---------- privileges and row security ----------
REVOKE ALL ON public.futures_paper_0052_requires_0051 FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.futures_paper_entry_checks, public.futures_paper_config_changes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.futures_paper_entry_checks, public.futures_paper_config_changes TO authenticated, service_role;
ALTER TABLE public.futures_paper_entry_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_config_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_paper_entry_checks_owner_read ON public.futures_paper_entry_checks FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_config_changes_owner_read ON public.futures_paper_config_changes FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
REVOKE ALL ON FUNCTION public.futures_paper_commit_bar_v5(uuid, bigint, bigint, jsonb), public.fp5_required_fill_qty(uuid, text, bigint, numeric),
  public.fp5_verify_fill_refusal(uuid, text, bigint, bigint, jsonb, numeric, text), public.fp5_audit_config() FROM PUBLIC, anon, authenticated, service_role;
