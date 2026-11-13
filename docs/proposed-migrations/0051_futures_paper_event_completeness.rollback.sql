-- Rollback for DRAFT 0051 (not applied). Run BEFORE any rollback of 0050 or 0049. Export the two tables below first:
-- dropping them deletes the frozen protection terms and the per-candle completeness evidence. The gateway function
-- fpw_commit is restored byte-for-byte to its 0050 body (commits through futures_paper_commit_bar_v3 again, i.e. WITHOUT
-- the G2 completeness checks — only for a deliberate return to the reviewed 0050 state). No CASCADE is used.
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
DROP VIEW public.futures_paper_0051_requires_0050;
DROP FUNCTION public.futures_paper_commit_bar_v4(uuid, bigint, bigint, jsonb);
DROP TABLE public.futures_paper_candle_checks;
DROP TABLE public.futures_paper_protection_terms;
DROP FUNCTION public.fp4_reached(numeric, numeric, boolean, text);
DROP FUNCTION public.fp4_funding_interval_ms(text);
