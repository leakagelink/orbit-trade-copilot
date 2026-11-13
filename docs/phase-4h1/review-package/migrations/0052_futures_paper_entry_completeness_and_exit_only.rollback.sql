-- Rollback for DRAFT 0052 (not applied). Run BEFORE any rollback of 0051, 0050 or 0049. Export the two tables below first:
-- dropping them deletes the per-entry completeness evidence and the configuration-change audit trail. The gateway
-- (fpw_commit) is restored byte-for-byte to its 0051 body (commits through v4 again, i.e. WITHOUT entry-fill
-- completeness), and futures_paper_commit_bar_v3 byte-for-byte to its 0049 body (a stopped account can no longer commit,
-- so its exits freeze again). Only for a deliberate return to the reviewed 0051 state. No CASCADE is used.
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

DROP VIEW public.futures_paper_0052_requires_0051;
DROP FUNCTION public.futures_paper_commit_bar_v5(uuid, bigint, bigint, jsonb);
DROP FUNCTION public.fp5_verify_fill_refusal(uuid, text, bigint, bigint, jsonb, numeric, text);
DROP FUNCTION public.fp5_required_fill_qty(uuid, text, bigint, numeric);
DROP TRIGGER futures_paper_accounts_status_config_audit ON public.futures_paper_accounts;
DROP TRIGGER futures_paper_accounts_config_audit ON public.futures_paper_accounts;
DROP TRIGGER futures_paper_cost_config_audit ON public.futures_paper_cost_assumptions;
DROP TRIGGER strategy_risk_budgets_config_audit ON public.strategy_risk_budgets;
DROP TRIGGER account_risk_budgets_config_audit ON public.account_risk_budgets;
DROP FUNCTION public.fp5_audit_config();
DROP TABLE public.futures_paper_config_changes;
DROP TABLE public.futures_paper_entry_checks;
