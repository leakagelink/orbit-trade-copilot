-- =====================================================================================================================
-- 0050 — DRAFT ONLY. NOT APPLIED. PROPOSED NUMBER; the final number is assigned at owner approval.
-- Hosted worker gateway for DRAFT 0049 (also NOT applied). It must be applied AFTER 0049 and never alongside 0045 or
-- 0046 (0049 already refuses those). It adds NOTHING that can reach an exchange, credentials, real orders/positions/
-- trades, risk_settings, futures_settings, the demo wallet, the Spot paper ledger, bots, Autopilot or Live Futures.
--
-- Why it exists (Phase 4G review of 0049, docs/phase-4g/migration-0049-review.md):
--  G1 Approval freshness was not bound to the wall clock: an approval's time must equal the candle close, so the 0049
--     price-age check is always 0 and a lagging worker could approve entries from old candles. fpw_commit refuses
--     order_accepted events when the candle closed longer ago than the account's max data age (database clock).
--  G3 Budget serialization relies on READ COMMITTED (each statement sees budget usage committed by the transaction it
--     waited for). fpw_commit refuses any other isolation level, and direct EXECUTE on futures_paper_commit_bar_v3 is
--     revoked from service_role so every commit passes through the gateway.
--  G4 0049 has no lease. Session advisory locks do not survive the hosted Data API (one transaction per request), so
--     leases are rows with a fencing token, checked (and renewed) inside the same transaction as the commit.
--  G5 0049 records candle prices but not where they came from. Each committed candle now gets an append-only provenance
--     row: source, timeframe, open/close time, fetch time, the worker-reported SHA-256 of the raw public payload, and a
--     database-computed hash of the recorded values. Prices are NEVER marked independently verified (CHECK).
--     The same public candle recorded for two accounts with different prices is refused.
--  G6 Status/halt changes were unaudited: every change now writes an append-only audit row with a bounded code.
-- One consistent snapshot per evaluation: fpw_snapshot is ONE SQL statement (one MVCC snapshot) and returns nothing
-- unless the caller holds the account's lease. Every function derives the owner from the account row; none accepts a
-- user id as authority (fpw_evaluated refuses a mismatching one). Operational bounds below (10..300 s lease, 15 min
-- fetch age, 5 s future skew) are engineering constants awaiting review, not approved policy.
-- =====================================================================================================================
DO $$ BEGIN
  IF to_regclass('public.futures_paper_accounts') IS NULL OR to_regprocedure('public.futures_paper_commit_bar_v3(uuid,bigint,bigint,jsonb)') IS NULL
     OR to_regprocedure('public.fp3_usage(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION '0050 requires draft 0049 (futures paper ledger v3) to be applied first';
  END IF;
END $$;

CREATE TABLE public.futures_paper_worker_leases (
  account_id uuid PRIMARY KEY REFERENCES public.futures_paper_accounts(id),
  user_id uuid NOT NULL,
  holder uuid NOT NULL,
  fence bigint NOT NULL CHECK (fence > 0),
  ttl_seconds integer NOT NULL CHECK (ttl_seconds BETWEEN 10 AND 300),
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE public.futures_paper_candle_provenance (
  account_id uuid NOT NULL,
  bar_t bigint NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT','ETHUSDT')),
  user_id uuid NOT NULL,
  source text NOT NULL CHECK (source = 'binance-public-usdm'),
  timeframe text NOT NULL CHECK (timeframe IN ('1m','5m','15m')),
  open_t bigint NOT NULL,
  close_t bigint NOT NULL,
  fetched_at bigint NOT NULL,
  recorded_at bigint NOT NULL,
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_sha256 text NOT NULL CHECK (recorded_sha256 ~ '^[0-9a-f]{64}$'),
  ohlc_sha256 text NOT NULL CHECK (ohlc_sha256 ~ '^[0-9a-f]{64}$'),
  independently_verified boolean NOT NULL DEFAULT false CHECK (NOT independently_verified),
  PRIMARY KEY (account_id, bar_t, symbol),
  FOREIGN KEY (account_id, bar_t, symbol) REFERENCES public.futures_paper_candles(account_id, bar_t, symbol),
  CONSTRAINT futures_paper_provenance_times CHECK (open_t = bar_t AND close_t > open_t AND fetched_at > close_t AND fetched_at <= recorded_at + 5000)
);
CREATE INDEX futures_paper_candle_provenance_public ON public.futures_paper_candle_provenance (symbol, timeframe, open_t);
CREATE INDEX futures_paper_candle_provenance_user ON public.futures_paper_candle_provenance (user_id, account_id, bar_t DESC);

CREATE TABLE public.futures_paper_worker_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_:>]{1,80}$'),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  holder uuid,
  fence bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX futures_paper_worker_audit_user ON public.futures_paper_worker_audit (user_id, account_id, created_at DESC);

CREATE TRIGGER futures_paper_provenance_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_candle_provenance FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_provenance_no_truncate BEFORE TRUNCATE ON public.futures_paper_candle_provenance FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_worker_audit_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_worker_audit FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_worker_audit_no_truncate BEFORE TRUNCATE ON public.futures_paper_worker_audit FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_worker_leases_no_truncate BEFORE TRUNCATE ON public.futures_paper_worker_leases FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();

-- Every status / halted change (worker review hold, owner pause/resume/stop) leaves an append-only trace.
CREATE FUNCTION public.fpw_audit_status_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_actor text := left(coalesce(nullif(current_setting('futures_paper.worker_actor', true), ''),
                                      nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', session_user::text), 64);
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor) VALUES (NEW.id, NEW.user_id, 'STATUS:' || upper(OLD.status) || '>' || upper(NEW.status), v_actor);
  END IF;
  IF OLD.halted IS DISTINCT FROM NEW.halted THEN
    INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor) VALUES (NEW.id, NEW.user_id, 'HALTED:' || upper(OLD.halted::text) || '>' || upper(NEW.halted::text), v_actor);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER futures_paper_accounts_status_audit AFTER UPDATE ON public.futures_paper_accounts FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.halted IS DISTINCT FROM NEW.halted) EXECUTE FUNCTION public.fpw_audit_status_change();

-- Hash of what 0049 recorded for one candle (all values) and of its public OHLC only (trade + mark; index/funding excluded).
CREATE FUNCTION public.fpw_candle_digest(p_account uuid, p_bar_t bigint, p_symbol text, p_full boolean) RETURNS text
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT encode(sha256(convert_to(concat_ws('|', c.symbol, c.bar_t, c.trade_o, c.trade_h, c.trade_l, c.trade_c, c.volume, c.mark_o, c.mark_h, c.mark_l, c.mark_c,
           CASE WHEN p_full THEN coalesce(c.index_c::text, 'null') END, CASE WHEN p_full THEN c.funding::text END), 'UTF8')), 'hex')
    FROM public.futures_paper_candles c WHERE c.account_id = p_account AND c.bar_t = p_bar_t AND c.symbol = p_symbol
$$;

-- ---------- lease (row + fencing token; survives the one-transaction-per-request Data API) ----------
CREATE FUNCTION public.fpw_acquire_lease(p_account uuid, p_holder uuid, p_ttl_seconds integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_user uuid; f bigint;
BEGIN
  IF p_account IS NULL OR p_holder IS NULL OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'futures paper worker: account, holder and a 10..300 s lease are required';
  END IF;
  SELECT user_id INTO v_user FROM public.futures_paper_accounts WHERE id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'futures paper account not found'; END IF;
  INSERT INTO public.futures_paper_worker_leases AS l (account_id, user_id, holder, fence, ttl_seconds, acquired_at, expires_at)
  VALUES (p_account, v_user, p_holder, 1, p_ttl_seconds, clock_timestamp(), clock_timestamp() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (account_id) DO UPDATE SET holder = EXCLUDED.holder, fence = l.fence + 1, ttl_seconds = EXCLUDED.ttl_seconds,
         acquired_at = EXCLUDED.acquired_at, expires_at = EXCLUDED.expires_at
   WHERE l.expires_at <= clock_timestamp()
  RETURNING fence INTO f;
  RETURN f; -- NULL: another holder's lease is still valid
END $$;

CREATE FUNCTION public.fpw_release_lease(p_account uuid, p_holder uuid, p_fence bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE public.futures_paper_worker_leases SET expires_at = clock_timestamp()
   WHERE account_id = p_account AND holder = p_holder AND fence = p_fence AND expires_at > clock_timestamp();
  RETURN FOUND;
END $$;

-- ---------- one consistent snapshot (ONE statement) for the lease holder only ----------
CREATE FUNCTION public.fpw_snapshot(p_account uuid, p_holder uuid, p_fence bigint) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH l AS (SELECT account_id, user_id FROM public.futures_paper_worker_leases
              WHERE account_id = p_account AND holder = p_holder AND fence = p_fence AND expires_at > now()),
  s AS (SELECT strategy_id, engine, max_loss FROM public.strategy_risk_budgets WHERE user_id = (SELECT user_id FROM l) AND environment = 'paper'),
  q AS (SELECT ev.strategy_id, sum(ev.wallet_delta) AS net FROM public.futures_paper_events ev
         WHERE ev.user_id = (SELECT user_id FROM l) AND ev.proposal_id IS NOT NULL AND ev.strategy_id IN (SELECT strategy_id FROM s)
         GROUP BY ev.account_id, ev.proposal_id, ev.strategy_id HAVING bool_or(ev.kind IN ('exit_fill', 'liquidation'))),
  c AS (SELECT strategy_id, sum(greatest(0, -net)) AS v FROM q GROUP BY strategy_id),
  o AS (SELECT strategy_id, sum(risk_reserved) AS v FROM public.futures_paper_positions WHERE user_id = (SELECT user_id FROM l) GROUP BY strategy_id),
  p AS (SELECT strategy_id, sum((approved_qty - filled_qty) * (stop_dist + reference_price * cost_pct / 100)) AS v
         FROM public.futures_paper_risk_approvals WHERE user_id = (SELECT user_id FROM l) AND status = 'open' GROUP BY strategy_id),
  u AS (SELECT s.strategy_id, s.engine, s.max_loss, coalesce(c.v, 0) AS closed_loss, coalesce(o.v, 0) AS open_risk, coalesce(p.v, 0) AS pending_risk
         FROM s LEFT JOIN c USING (strategy_id) LEFT JOIN o USING (strategy_id) LEFT JOIN p USING (strategy_id))
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM l) THEN NULL ELSE jsonb_build_object(
    'snapshot_ms', floor(extract(epoch FROM now()) * 1000)::bigint,
    'account', (SELECT to_jsonb(x) FROM (SELECT id, user_id, status, halted, seq, cursor_t, tf_ms, timeframe, symbols, config, state
                  FROM public.futures_paper_accounts WHERE id = p_account) x),
    'account_budget', (SELECT to_jsonb(x) FROM (SELECT max_loss, research_max_loss, scalping_max_loss FROM public.account_risk_budgets
                  WHERE user_id = (SELECT user_id FROM l) AND environment = 'paper') x),
    'usage', coalesce((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.strategy_id) FROM u), '[]'::jsonb),
    'costs', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.strategy_id, x.symbol) FROM (SELECT strategy_id, symbol, round_trip_cost_pct, validation_status
                  FROM public.futures_paper_cost_assumptions WHERE user_id = (SELECT user_id FROM l)) x), '[]'::jsonb),
    'approvals', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.symbol) FROM (SELECT proposal_id, strategy_id, budget_engine, symbol, side, approved_qty, filled_qty,
                  leverage, reference_price, reference_t, stop_dist, cost_pct, expires_t FROM public.futures_paper_risk_approvals
                  WHERE account_id = p_account AND status = 'open') x), '[]'::jsonb),
    'positions', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.symbol) FROM (SELECT symbol, proposal_id, strategy_id, risk_reserved
                  FROM public.futures_paper_positions WHERE account_id = p_account) x), '[]'::jsonb)) END
$$;

-- ---------- which proposals the owner's ledger already evaluated (owner derived from the account) ----------
CREATE FUNCTION public.fpw_evaluated(p_account uuid, p_holder uuid, p_fence bigint, p_user uuid, p_ids text[]) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM public.futures_paper_worker_leases
   WHERE account_id = p_account AND holder = p_holder AND fence = p_fence AND expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'futures paper worker lease lost'; END IF;
  IF p_user IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'futures paper worker: cross-account access refused'; END IF;
  IF p_ids IS NULL OR cardinality(p_ids) > 100 THEN RAISE EXCEPTION 'futures paper worker: 0..100 proposal ids expected'; END IF;
  RETURN coalesce((SELECT array_agg(proposal_id ORDER BY proposal_id) FROM public.futures_paper_risk_approvals WHERE user_id = v_user AND proposal_id = ANY (p_ids)), '{}');
END $$;

-- ---------- the only commit path: lease + isolation + entry freshness + provenance, then 0049, atomically ----------
CREATE FUNCTION public.fpw_commit(p_account uuid, p_holder uuid, p_fence bigint, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb, p_provenance jsonb)
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

  v_seq := public.futures_paper_commit_bar_v3(p_account, p_expected_seq, p_bar_t, p_payload);

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

-- ---------- review hold (entries stop; exits continue; never un-paused here) ----------
CREATE FUNCTION public.fpw_mark_review(p_account uuid, p_holder uuid, p_fence bigint, p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE l public.futures_paper_worker_leases%ROWTYPE;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[A-Z0-9_]{1,64}$' THEN RAISE EXCEPTION 'futures paper worker: review code must be 1..64 of A-Z, 0-9, _'; END IF;
  SELECT * INTO l FROM public.futures_paper_worker_leases WHERE account_id = p_account FOR UPDATE;
  IF NOT FOUND OR l.holder IS DISTINCT FROM p_holder OR l.fence IS DISTINCT FROM p_fence OR l.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'futures paper worker lease lost';
  END IF;
  PERFORM set_config('futures_paper.worker_actor', 'worker', true);
  UPDATE public.futures_paper_accounts SET status = 'paused', status_reason = 'review:' || p_code WHERE id = p_account AND status = 'active';
  INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor, holder, fence) VALUES (p_account, l.user_id, 'REVIEW:' || p_code, 'worker', p_holder, p_fence);
  PERFORM set_config('futures_paper.worker_actor', '', true);
  RETURN true;
END $$;

-- ---------- privileges and row security ----------
REVOKE ALL ON public.futures_paper_worker_leases, public.futures_paper_candle_provenance, public.futures_paper_worker_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.futures_paper_candle_provenance, public.futures_paper_worker_audit TO authenticated, service_role;
GRANT SELECT ON public.futures_paper_worker_leases TO service_role;
ALTER TABLE public.futures_paper_worker_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_candle_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_worker_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_paper_candle_provenance_owner_read ON public.futures_paper_candle_provenance FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_paper_worker_audit_owner_read ON public.futures_paper_worker_audit FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
-- No policy on leases: browser roles have no grant; service_role reads them for monitoring only (BYPASSRLS).

REVOKE ALL ON FUNCTION public.fpw_audit_status_change(), public.fpw_candle_digest(uuid, bigint, text, boolean),
  public.fpw_acquire_lease(uuid, uuid, integer), public.fpw_release_lease(uuid, uuid, bigint), public.fpw_snapshot(uuid, uuid, bigint),
  public.fpw_evaluated(uuid, uuid, bigint, uuid, text[]), public.fpw_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
  public.fpw_mark_review(uuid, uuid, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fpw_acquire_lease(uuid, uuid, integer), public.fpw_release_lease(uuid, uuid, bigint), public.fpw_snapshot(uuid, uuid, bigint),
  public.fpw_evaluated(uuid, uuid, bigint, uuid, text[]), public.fpw_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
  public.fpw_mark_review(uuid, uuid, bigint, text) TO service_role;
-- Every commit goes through the gateway: the direct 0049 entry point is no longer executable by any API role.
REVOKE EXECUTE ON FUNCTION public.futures_paper_commit_bar_v3(uuid, bigint, bigint, jsonb) FROM service_role;
