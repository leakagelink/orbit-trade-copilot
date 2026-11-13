-- =====================================================================================================================
-- 0051 — DRAFT ONLY. NOT APPLIED. PROPOSED NUMBER; the final number is assigned at owner approval.
-- Reviewed SUCCESSOR of drafts 0049 (ledger v3) and 0050 (worker gateway), both also NOT applied and both left
-- byte-identical. Apply order: 0049 → 0050 → 0051, in that order, never alongside 0045 or 0046. Everything is SIMULATED
-- from public market data; nothing here can reach an exchange, credentials, real orders/positions/trades, risk_settings,
-- futures_settings, the demo wallet, the Spot paper ledger (0044), bots, Autopilot or Live Futures.
--
-- Owner decision (Phase 4H, 13 Nov 2026): finding G2 MUST be fixed here; it is NOT accepted as a paper limitation.
-- G2: 0049 validates every event a worker submits but does not REQUIRE the events the recorded candle implies. 0051
-- makes the database derive the required outcome of every exposed symbol itself and refuse any candle whose events
-- differ. It never trusts a worker statement that an event was unnecessary.
--
--  C1 Funding completeness. Funding times for BTCUSDT/ETHUSDT follow a fixed 8 h grid (00/08/16 UTC; Binance reports
--     them a few ms late, so an entry counts when it lies within 1 s after a grid point). For a position held at the
--     candle open, a grid point inside the candle REQUIRES exactly one funding entry and exactly one funding event;
--     the cash itself is recomputed by 0049. A missing, duplicated or off-grid entry for a held symbol is refused as
--     missing/ambiguous data (the worker pauses; the candle stays uncommitted and is retried in full later).
--  C2 Exit completeness. For every position exposed during the candle (held at the open and/or filled at the open)
--     the database rebuilds the position from its own book plus this candle's validated funding and fills, then
--     applies the engine's documented conservative order: liquidation at the open → stop at the open (gap: filled at
--     the open) → target at the open → stop inside the candle (only if the stop lies before liquidation) →
--     liquidation inside the candle → target inside the candle → time limit at the close. Stop and target are always
--     assumed to be hit in the order least favourable to the account (stop first). The required outcome must be
--     submitted exactly (kind, time and taker price); an exit where none is required is refused as well.
--  C3 Protection terms are frozen when the approval is written (trigger source from the frozen account config; stop
--     distance from the approval; target distance and maximum hold from the submitted pending entry — strategy inputs
--     fixed BEFORE any outcome is known). Each later state must carry exactly these terms.
--  C4 No silent gaps. While a position or a pending entry exists, the candle must be the next one after the cursor.
--  C5 Ambiguity is refused, never guessed: a recorded price within 1e-9 (relative) of a stop, target or liquidation
--     level that decides the outcome, a missing or invalid trigger source or missing protection terms all refuse the
--     candle with a 'futures paper completeness:' message (the Phase 4F planner classifies it as review → pause).
--  C6 Atomic and idempotent: the checks run in the same transaction as 0049's commit (candles, events, positions,
--     approvals and budget usage roll back together); an identical replay returns the original sequence without
--     re-checking; the gateway (fpw_commit, replaced here with 0050's body calling v4) stays the only commit path.
-- Constants (8 h grid, 1 s funding jitter, 1e-9 ambiguity band, 100,000 bar hold ceiling) are engineering values
-- awaiting owner review, not approved policy. Everything else is inherited from the account's frozen 0049 config.
-- =====================================================================================================================
DO $$ BEGIN
  IF to_regprocedure('public.futures_paper_commit_bar_v3(uuid,bigint,bigint,jsonb)') IS NULL
     OR to_regprocedure('public.fpw_commit(uuid,uuid,bigint,bigint,bigint,jsonb,jsonb)') IS NULL
     OR to_regclass('public.futures_paper_worker_leases') IS NULL THEN
    RAISE EXCEPTION '0051 requires drafts 0049 and 0050 to be applied first';
  END IF;
END $$;

-- Protection terms of every approval, frozen at approval time (append-only).
CREATE TABLE public.futures_paper_protection_terms (
  account_id uuid NOT NULL,
  proposal_id text NOT NULL,
  user_id uuid NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT','ETHUSDT')),
  side text NOT NULL CHECK (side IN ('LONG','SHORT')),
  trigger_source text NOT NULL CHECK (trigger_source IN ('MARK','CONTRACT')),
  stop_dist numeric NOT NULL CHECK (public.fp2_finite(stop_dist) AND stop_dist > 0),
  target_dist numeric CHECK (target_dist IS NULL OR (public.fp2_finite(target_dist) AND target_dist > 0)),
  max_hold_bars integer NOT NULL CHECK (max_hold_bars BETWEEN 1 AND 100000),
  recorded_seq bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, proposal_id),
  FOREIGN KEY (account_id, proposal_id) REFERENCES public.futures_paper_risk_approvals(account_id, proposal_id)
);
CREATE INDEX futures_paper_protection_terms_user ON public.futures_paper_protection_terms (user_id, account_id);

-- What the database itself derived for every exposed symbol of every committed candle (append-only evidence).
CREATE TABLE public.futures_paper_candle_checks (
  account_id uuid NOT NULL,
  bar_t bigint NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT','ETHUSDT')),
  user_id uuid NOT NULL,
  proposal_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('none','liquidation_open','stop_open','target_open','stop','liquidation','target','time')),
  trigger_source text NOT NULL CHECK (trigger_source IN ('MARK','CONTRACT')),
  qty numeric NOT NULL CHECK (public.fp2_finite(qty) AND qty > 0),
  entry_price numeric NOT NULL CHECK (public.fp2_finite(entry_price) AND entry_price > 0),
  stop_price numeric NOT NULL CHECK (public.fp2_finite(stop_price)),
  target_price numeric CHECK (target_price IS NULL OR public.fp2_finite(target_price)),
  liquidation_price numeric NOT NULL CHECK (public.fp2_finite(liquidation_price) AND liquidation_price >= 0),
  bars_held integer NOT NULL CHECK (bars_held >= 1),
  funding_required integer NOT NULL CHECK (funding_required >= 0),
  expected_close_t bigint,
  expected_close_price numeric,
  PRIMARY KEY (account_id, bar_t, symbol),
  FOREIGN KEY (account_id, bar_t, symbol) REFERENCES public.futures_paper_candles(account_id, bar_t, symbol),
  CONSTRAINT futures_paper_candle_check_close CHECK ((outcome = 'none') = (expected_close_t IS NULL AND expected_close_price IS NULL))
);
CREATE INDEX futures_paper_candle_checks_user ON public.futures_paper_candle_checks (user_id, account_id, bar_t DESC);

CREATE TRIGGER futures_paper_protection_terms_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_protection_terms FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_protection_terms_no_truncate BEFORE TRUNCATE ON public.futures_paper_protection_terms FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_protection_terms_guard BEFORE INSERT ON public.futures_paper_protection_terms FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_book();
CREATE TRIGGER futures_paper_candle_checks_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_candle_checks FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_candle_checks_no_truncate BEFORE TRUNCATE ON public.futures_paper_candle_checks FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_candle_checks_guard BEFORE INSERT ON public.futures_paper_candle_checks FOR EACH ROW EXECUTE FUNCTION public.guard_futures_paper_book();

-- ---------- helpers ----------
-- Funding grid of the two supported perpetuals (Binance: every 8 h at 00:00/08:00/16:00 UTC). NULL = unknown symbol.
CREATE FUNCTION public.fp4_funding_interval_ms(p_symbol text) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE WHEN p_symbol IN ('BTCUSDT', 'ETHUSDT') THEN 28800000::bigint END
$$;
-- Was the level crossed? down: x < level; up: x > level. Within the ambiguity band the outcome is not guessed.
CREATE FUNCTION public.fp4_reached(p_x numeric, p_level numeric, p_down boolean, p_what text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $$
BEGIN
  IF p_x IS NULL OR p_level IS NULL THEN RAISE EXCEPTION 'futures paper completeness: % cannot be evaluated (missing price)', p_what; END IF;
  IF abs(p_x - p_level) <= 0.000000001 * greatest(1, abs(p_level)) THEN
    RAISE EXCEPTION 'futures paper completeness: ambiguous % (recorded % is within rounding of level %)', p_what, p_x, p_level;
  END IF;
  RETURN CASE WHEN p_down THEN p_x < p_level ELSE p_x > p_level END;
END $$;

-- ---------- the completeness-checked commit (wraps 0049's commit in the same transaction) ----------
CREATE FUNCTION public.futures_paper_commit_bar_v4(p_account uuid, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  a public.futures_paper_accounts%ROWTYPE;
  r public.futures_paper_risk_approvals%ROWTYPE;
  b public.futures_paper_positions%ROWTYPE;
  tm public.futures_paper_protection_terms%ROWTYPE;
  cdl public.futures_paper_candles%ROWTYPE;
  ev public.futures_paper_events%ROWTYPE;
  v_p0 jsonb; v_exposed boolean; v_trig text; v_seq0 bigint; v_seq bigint; v_adj numeric; st jsonb; pj jsonb; f jsonb; k text;
  v_iv bigint; v_g bigint; v_need integer; v_have integer; v_nfund integer; v_phase integer;
  v_q numeric; v_e numeric; v_m numeric; v_sd numeric; v_opened bigint; v_prop text; v_side text; v_dir integer; v_long boolean; v_mmr numeric;
  v_stop numeric; v_tgt numeric; v_liq numeric; v_bars integer;
  t_o numeric; t_h numeric; t_l numeric;
  v_out text; v_xkind text; v_xt bigint; v_xp numeric;
  c_kind text; c_t bigint; c_price numeric;
BEGIN
  IF p_account IS NULL OR p_expected_seq IS NULL OR p_bar_t IS NULL OR p_payload IS NULL THEN
    RAISE EXCEPTION 'futures paper commit: account, expected sequence, candle and payload are all required';
  END IF;
  SELECT * INTO a FROM public.futures_paper_accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'futures paper account not found'; END IF;
  -- Identical replay (or a conflicting payload for a committed candle): 0049 answers without writing.
  IF EXISTS (SELECT 1 FROM public.futures_paper_commits WHERE account_id = a.id AND bar_t = p_bar_t) THEN
    RETURN public.futures_paper_commit_bar_v3(p_account, p_expected_seq, p_bar_t, p_payload);
  END IF;
  IF jsonb_typeof(p_payload->'candles') IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'state') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'futures paper commit: payload must contain events[], state{} and candles{}';
  END IF;

  -- The book at the candle open (the account row is locked: only a commit holding this lock changes it).
  v_p0 := coalesce((SELECT jsonb_object_agg(p.symbol, to_jsonb(p)) FROM public.futures_paper_positions p WHERE p.account_id = a.id), '{}'::jsonb);
  v_exposed := v_p0 <> '{}'::jsonb OR EXISTS (SELECT 1 FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND status = 'open');
  v_trig := a.config->>'triggerSource';

  -- C4: no silent gaps while exposed.
  IF v_exposed AND a.status <> 'stopped' AND p_bar_t <> a.cursor_t + a.tf_ms AND p_bar_t > a.cursor_t THEN
    RAISE EXCEPTION 'futures paper completeness: candle % skips % candle(s) while a position or pending entry exists; every candle must be committed in order',
      p_bar_t, (p_bar_t - a.cursor_t) / a.tf_ms - 1;
  END IF;
  IF v_exposed AND (v_trig IS NULL OR v_trig NOT IN ('MARK', 'CONTRACT')) THEN
    RAISE EXCEPTION 'futures paper completeness: the account config has no valid triggerSource; stops cannot be evaluated';
  END IF;

  -- C1 (data side): a held symbol's funding entries must be unique, on the grid, and present at every grid point.
  FOR k IN SELECT jsonb_object_keys(v_p0) LOOP
    IF jsonb_typeof(p_payload->'candles'->k) IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'candles'->k->'funding') IS DISTINCT FROM 'array' THEN
      CONTINUE; -- 0049 refuses a missing candle for a held symbol with its own message
    END IF;
    v_iv := public.fp4_funding_interval_ms(k);
    IF v_iv IS NULL THEN RAISE EXCEPTION 'futures paper completeness: no funding schedule for %', k; END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(p_payload->'candles'->k->'funding') x) <> (SELECT count(DISTINCT x->>'t') FROM jsonb_array_elements(p_payload->'candles'->k->'funding') x) THEN
      RAISE EXCEPTION 'futures paper completeness: duplicate funding time for % in candle % (ambiguous)', k, p_bar_t;
    END IF;
    v_need := 0;
    v_g := ((p_bar_t + v_iv - 1) / v_iv) * v_iv;   -- first grid point at or after the candle open
    WHILE v_g < p_bar_t + a.tf_ms LOOP
      v_need := v_need + 1;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'candles'->k->'funding') x
                      WHERE jsonb_typeof(x->'t') = 'number' AND (x->>'t')::numeric >= v_g AND (x->>'t')::numeric < v_g + 1000) THEN
        RAISE EXCEPTION 'futures paper completeness: funding rate for % at % is missing while a position is held (candle %)', k, v_g, p_bar_t;
      END IF;
      v_g := v_g + v_iv;
    END LOOP;
    IF jsonb_array_length(p_payload->'candles'->k->'funding') <> v_need THEN
      RAISE EXCEPTION 'futures paper completeness: % funding entries for % in candle % do not match its % funding time(s) on the % ms grid (extra or off-grid; ambiguous)',
        jsonb_array_length(p_payload->'candles'->k->'funding'), k, p_bar_t, v_need, v_iv;
    END IF;
  END LOOP;

  v_seq0 := a.seq;
  v_seq := public.futures_paper_commit_bar_v3(p_account, p_expected_seq, p_bar_t, p_payload);  -- validates every submitted event
  PERFORM set_config('futures_paper.commit', 'on', true);
  st := p_payload->'state';
  v_adj := a.cost_spread_pct / 200 + a.cost_slippage_pct / 100;

  -- C3: freeze the protection terms of approvals written by this commit.
  FOR r IN SELECT * FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND approved_seq > v_seq0 ORDER BY symbol LOOP
    pj := st->'pending'->r.symbol;
    IF v_trig IS NULL OR v_trig NOT IN ('MARK', 'CONTRACT') THEN
      RAISE EXCEPTION 'futures paper completeness: the account config has no valid triggerSource; stops cannot be evaluated';
    END IF;
    IF jsonb_typeof(pj) IS DISTINCT FROM 'object' OR (pj->'targetDist' IS NOT NULL AND jsonb_typeof(pj->'targetDist') NOT IN ('number', 'null'))
       OR (jsonb_typeof(pj->'targetDist') = 'number' AND NOT ((pj->>'targetDist')::numeric > 0))
       OR public.fp2_int(pj, 'maxHoldBars') NOT BETWEEN 1 AND 100000 THEN
      RAISE EXCEPTION 'futures paper completeness: approval % needs a target distance (positive or null) and a maximum hold of 1..100000 candles', r.proposal_id;
    END IF;
    INSERT INTO public.futures_paper_protection_terms (account_id, proposal_id, user_id, symbol, side, trigger_source, stop_dist, target_dist, max_hold_bars, recorded_seq)
    VALUES (a.id, r.proposal_id, a.user_id, r.symbol, r.side, v_trig, r.stop_dist,
            CASE WHEN jsonb_typeof(pj->'targetDist') = 'number' THEN (pj->>'targetDist')::numeric END, public.fp2_int(pj, 'maxHoldBars'), r.approved_seq);
  END LOOP;

  -- C1 (events) + C2: rebuild every exposed position from the opening book and this candle's validated events.
  FOR k IN SELECT x FROM jsonb_object_keys(v_p0) x
           UNION SELECT e.symbol FROM public.futures_paper_events e WHERE e.account_id = a.id AND e.seq > v_seq0 AND e.kind = 'entry_fill' ORDER BY 1 LOOP
    IF v_p0 ? k THEN
      v_q := (v_p0->k->>'qty')::numeric; v_e := (v_p0->k->>'entry_price')::numeric; v_m := (v_p0->k->>'margin')::numeric;
      v_sd := (v_p0->k->>'stop_dist')::numeric; v_opened := (v_p0->k->>'opened_bar_t')::bigint; v_prop := v_p0->k->>'proposal_id'; v_side := v_p0->k->>'side';
    ELSE
      v_q := 0; v_e := NULL; v_m := 0; v_sd := NULL; v_opened := NULL; v_prop := NULL; v_side := NULL;
    END IF;
    v_phase := 0; v_nfund := 0; c_kind := NULL; c_t := NULL; c_price := NULL;
    FOR ev IN SELECT * FROM public.futures_paper_events e WHERE e.account_id = a.id AND e.seq > v_seq0 AND e.symbol = k ORDER BY e.seq LOOP
      IF ev.kind = 'funding' THEN
        IF v_phase > 0 THEN RAISE EXCEPTION 'futures paper completeness: funding for % is recorded after a fill, close or order event (order is ambiguous)', k; END IF;
        v_m := v_m + ev.margin_delta; v_nfund := v_nfund + 1;
      ELSIF ev.kind = 'entry_fill' THEN
        IF v_phase > 1 THEN RAISE EXCEPTION 'futures paper completeness: entry fill for % after its close or an order event', k; END IF;
        v_phase := 1;
        IF v_q = 0 THEN
          SELECT * INTO r FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND proposal_id = ev.proposal_id;
          v_e := ev.price; v_opened := p_bar_t; v_prop := ev.proposal_id; v_side := ev.side; v_sd := r.stop_dist;
        ELSE
          v_e := (v_e * v_q + ev.price * ev.qty) / (v_q + ev.qty);
        END IF;
        v_q := v_q + ev.qty; v_m := v_m + ev.margin_delta;
      ELSIF ev.kind IN ('exit_fill', 'liquidation') THEN
        IF v_phase > 1 THEN RAISE EXCEPTION 'futures paper completeness: a second close or a close after an order event for %', k; END IF;
        v_phase := 2; c_kind := ev.kind; c_t := ev.t; c_price := ev.price;
      ELSIF ev.kind IN ('order_accepted', 'order_rejected') THEN
        v_phase := 3;
      END IF; -- entry_cancelled: allowed anywhere (0049 checks it against its approval)
    END LOOP;
    -- Funding events must equal the required entries exactly (0049 already recomputed each one's cash).
    v_need := CASE WHEN v_p0 ? k AND jsonb_typeof(p_payload->'candles'->k->'funding') = 'array' THEN jsonb_array_length(p_payload->'candles'->k->'funding') ELSE 0 END;
    SELECT count(DISTINCT e.t) INTO v_have FROM public.futures_paper_events e WHERE e.account_id = a.id AND e.seq > v_seq0 AND e.symbol = k AND e.kind = 'funding';
    IF v_nfund <> v_need OR v_have <> v_need THEN
      RAISE EXCEPTION 'futures paper completeness: % funding event(s) for % but the recorded candle requires % for the held position', v_nfund, k, v_need;
    END IF;
    CONTINUE WHEN v_q = 0;

    SELECT * INTO tm FROM public.futures_paper_protection_terms WHERE account_id = a.id AND proposal_id = v_prop;
    IF NOT FOUND THEN RAISE EXCEPTION 'futures paper completeness: no frozen protection terms for the % position (%); the candle cannot be verified', k, v_prop; END IF;
    IF tm.side IS DISTINCT FROM v_side OR tm.stop_dist IS DISTINCT FROM v_sd THEN RAISE EXCEPTION 'futures paper completeness: % position differs from its frozen protection terms', k; END IF;
    SELECT * INTO cdl FROM public.futures_paper_candles WHERE account_id = a.id AND bar_t = p_bar_t AND symbol = k;
    IF NOT FOUND THEN RAISE EXCEPTION 'futures paper completeness: no recorded candle for exposed symbol %', k; END IF;
    v_long := v_side = 'LONG'; v_dir := CASE WHEN v_long THEN 1 ELSE -1 END;
    v_mmr := public.fp2_num(a.config->'specs'->k, 'maintenanceMarginRate');
    v_stop := v_e - v_dir * v_sd;
    v_tgt := CASE WHEN tm.target_dist IS NULL THEN NULL ELSE v_e + v_dir * tm.target_dist END;
    v_liq := greatest(0, CASE WHEN v_long THEN (v_q * v_e - v_m) / (v_q * (1 - v_mmr)) ELSE (v_q * v_e + v_m) / (v_q * (1 + v_mmr)) END);
    v_bars := ((p_bar_t - v_opened) / a.tf_ms + 1)::integer;
    IF tm.trigger_source = 'MARK' THEN t_o := cdl.mark_o; t_h := cdl.mark_h; t_l := cdl.mark_l; ELSE t_o := cdl.trade_o; t_h := cdl.trade_h; t_l := cdl.trade_l; END IF;

    -- The engine's conservative order (stop before target whenever both lie inside one candle).
    IF public.fp4_reached(cdl.mark_o, v_liq, v_long, 'liquidation at the open for ' || k) THEN
      v_out := 'liquidation_open'; v_xkind := 'liquidation'; v_xt := p_bar_t; v_xp := v_liq;
    ELSIF public.fp4_reached(t_o, v_stop, v_long, 'stop at the open for ' || k) THEN
      v_out := 'stop_open'; v_xkind := 'exit_fill'; v_xt := p_bar_t; v_xp := cdl.trade_o * (1 - v_dir * v_adj);
    ELSIF v_tgt IS NOT NULL AND public.fp4_reached(t_o, v_tgt, NOT v_long, 'target at the open for ' || k) THEN
      v_out := 'target_open'; v_xkind := 'exit_fill'; v_xt := p_bar_t; v_xp := cdl.trade_o * (1 - v_dir * v_adj);
    ELSIF public.fp4_reached(CASE WHEN v_long THEN t_l ELSE t_h END, v_stop, v_long, 'stop inside the candle for ' || k)
          AND public.fp4_reached(v_stop, v_liq, NOT v_long, 'stop versus liquidation for ' || k) THEN
      v_out := 'stop'; v_xkind := 'exit_fill'; v_xt := p_bar_t; v_xp := v_stop * (1 - v_dir * v_adj);
    ELSIF public.fp4_reached(CASE WHEN v_long THEN cdl.mark_l ELSE cdl.mark_h END, v_liq, v_long, 'liquidation inside the candle for ' || k) THEN
      v_out := 'liquidation'; v_xkind := 'liquidation'; v_xt := p_bar_t; v_xp := v_liq;
    ELSIF v_tgt IS NOT NULL AND public.fp4_reached(CASE WHEN v_long THEN t_h ELSE t_l END, v_tgt, NOT v_long, 'target inside the candle for ' || k) THEN
      v_out := 'target'; v_xkind := 'exit_fill'; v_xt := p_bar_t; v_xp := v_tgt * (1 - v_dir * v_adj);
    ELSIF v_bars >= tm.max_hold_bars THEN
      v_out := 'time'; v_xkind := 'exit_fill'; v_xt := p_bar_t + a.tf_ms; v_xp := cdl.trade_c * (1 - v_dir * v_adj);
    ELSE
      v_out := 'none'; v_xkind := NULL; v_xt := NULL; v_xp := NULL;
    END IF;

    IF v_xkind IS NULL AND c_kind IS NOT NULL THEN
      RAISE EXCEPTION 'futures paper completeness: % % at % submitted, but the recorded candle triggers no stop, target, liquidation or time limit', k, c_kind, c_price;
    END IF;
    IF v_xkind IS NOT NULL AND c_kind IS NULL THEN
      RAISE EXCEPTION 'futures paper completeness: the recorded candle requires a % (%) for % at % but no close event was submitted', v_xkind, v_out, k, v_xp;
    END IF;
    IF v_xkind IS NOT NULL AND (c_kind <> v_xkind OR c_t <> v_xt OR NOT public.fp3_near(c_price, v_xp)) THEN
      RAISE EXCEPTION 'futures paper completeness: % close differs from the required % (%): submitted % at % (t %), required % at % (t %)',
        k, v_xkind, v_out, c_kind, c_price, c_t, v_xkind, v_xp, v_xt;
    END IF;
    INSERT INTO public.futures_paper_candle_checks (account_id, bar_t, symbol, user_id, proposal_id, outcome, trigger_source, qty, entry_price, stop_price, target_price,
                                                    liquidation_price, bars_held, funding_required, expected_close_t, expected_close_price)
    VALUES (a.id, p_bar_t, k, a.user_id, v_prop, v_out, tm.trigger_source, v_q, v_e, v_stop, v_tgt, v_liq, v_bars, v_need, v_xt, v_xp);
  END LOOP;

  -- C3 (state side): every open position and pending entry in the submitted state carries exactly its frozen terms.
  FOR k IN SELECT jsonb_object_keys(st->'positions') LOOP
    SELECT * INTO b FROM public.futures_paper_positions WHERE account_id = a.id AND symbol = k;
    SELECT * INTO tm FROM public.futures_paper_protection_terms WHERE account_id = a.id AND proposal_id = b.proposal_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'futures paper completeness: no frozen protection terms for the % position (%); the candle cannot be verified', k, b.proposal_id; END IF;
    pj := st->'positions'->k; v_dir := CASE WHEN b.side = 'LONG' THEN 1 ELSE -1 END;
    IF NOT public.fp3_near(public.fp2_num(pj, 'stopDist'), tm.stop_dist) OR NOT public.fp3_near(public.fp2_num(pj, 'stop'), b.entry_price - v_dir * b.stop_dist)
       OR public.fp2_int(pj, 'maxHoldBars') IS DISTINCT FROM tm.max_hold_bars::bigint
       OR public.fp2_int(pj, 'bars') IS DISTINCT FROM (p_bar_t - b.opened_bar_t) / a.tf_ms + 1
       OR (tm.target_dist IS NULL) IS DISTINCT FROM (pj->'targetDist' IS NULL OR jsonb_typeof(pj->'targetDist') = 'null')
       OR (tm.target_dist IS NOT NULL AND NOT public.fp3_near(public.fp2_num(pj, 'targetDist'), tm.target_dist)) THEN
      RAISE EXCEPTION 'futures paper completeness: state position % does not carry its frozen stop, target, hold limit or candle count', k;
    END IF;
  END LOOP;
  FOR k IN SELECT jsonb_object_keys(st->'pending') LOOP
    SELECT * INTO r FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND symbol = k AND status = 'open';
    SELECT * INTO tm FROM public.futures_paper_protection_terms WHERE account_id = a.id AND proposal_id = r.proposal_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'futures paper completeness: no frozen protection terms for the pending % entry (%)', k, r.proposal_id; END IF;
    pj := st->'pending'->k;
    IF public.fp2_int(pj, 'maxHoldBars') IS DISTINCT FROM tm.max_hold_bars::bigint
       OR (tm.target_dist IS NULL) IS DISTINCT FROM (pj->'targetDist' IS NULL OR jsonb_typeof(pj->'targetDist') = 'null')
       OR (tm.target_dist IS NOT NULL AND NOT public.fp3_near(public.fp2_num(pj, 'targetDist'), tm.target_dist)) THEN
      RAISE EXCEPTION 'futures paper completeness: state pending % does not carry its frozen target or hold limit', k;
    END IF;
  END LOOP;
  PERFORM set_config('futures_paper.commit', 'off', true);
  RETURN v_seq;
END $$;


-- ---------- the gateway now commits through v4 (0050's body, unchanged except for the called function) ----------
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

  v_seq := public.futures_paper_commit_bar_v4(p_account, p_expected_seq, p_bar_t, p_payload);

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

-- Rollback-order guard: 0050's rollback (DROP TABLE futures_paper_worker_leases, no CASCADE) fails while 0051 exists,
-- so 0051 must be rolled back first and the gateway can never be left calling a dropped function.
CREATE VIEW public.futures_paper_0051_requires_0050 AS SELECT account_id FROM public.futures_paper_worker_leases WHERE false;

-- ---------- privileges and row security ----------
REVOKE ALL ON public.futures_paper_0051_requires_0050 FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.futures_paper_protection_terms, public.futures_paper_candle_checks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.futures_paper_protection_terms, public.futures_paper_candle_checks TO authenticated, service_role;
ALTER TABLE public.futures_paper_protection_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_candle_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_paper_protection_terms_owner_read ON public.futures_paper_protection_terms FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_candle_checks_owner_read ON public.futures_paper_candle_checks FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
REVOKE ALL ON FUNCTION public.futures_paper_commit_bar_v4(uuid, bigint, bigint, jsonb), public.fp4_funding_interval_ms(text), public.fp4_reached(numeric, numeric, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;
