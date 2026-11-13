-- =====================================================================================================================
-- 0047 — DRAFT ONLY. NOT APPLIED. PROPOSED NUMBER; the final number is assigned at owner approval (it depends on which
-- of the unapplied drafts 0040–0046 are applied first). Phase 4D, Workstream D.
--
-- Immutable strategy identity for REAL USD-M Futures orders, captured at intent-claim time, plus an append-only
-- attribution ledger for entry fills, partial reductions, fees, funding and corrections. Design:
-- docs/phase-4d/strategy-attribution-migration.md.
--
--  * It does NOT alter public.orders, public.positions or public.trades (no new columns, no backfill, no trigger on
--    them): existing execution paths are unaffected until a separately approved order-path change calls
--    claim_futures_order_strategy_identity() inside the claim transaction.
--  * Identity rows can only be inserted in the SAME transaction that created the pending entry order (orders.created_at
--    = now()), for a usd_m_futures testnet/production order of the same owner, environment and idempotency key. They can
--    never be updated, deleted or truncated. A retry with the same tuple is a no-op; a conflicting tuple is refused.
--  * Legacy orders (claimed before this) get no identity row and stay UNATTRIBUTED forever: nothing infers identity from
--    bot_id, trades.strategy_id (mutable, ON DELETE SET NULL), symbol, notes or configuration similarity.
--  * Attribution events are insert-only, owner/environment-bound to an identity row, unique per evidence reference
--    (no loss is attributed twice), and partial reductions can never exceed the attributed filled quantity. Partial
--    reductions do NOT require a trades row (one Futures close per position remains the existing rule).
--  * Browser roles: owner-only, MFA-aware SELECT. Writes: service_role only, through the guarded paths.
-- =====================================================================================================================

CREATE TABLE public.futures_order_strategy_identity (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id),
  user_id uuid NOT NULL,
  execution_environment text NOT NULL CHECK (execution_environment IN ('testnet', 'production')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  strategy_id text NOT NULL CHECK (length(strategy_id) BETWEEN 1 AND 200 AND strategy_id ~ '^[A-Za-z0-9._:-]+$'),
  strategy_version integer NOT NULL CHECK (strategy_version > 0),
  strategy_config_sha256 text NOT NULL CHECK (strategy_config_sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX futures_order_strategy_identity_strategy ON public.futures_order_strategy_identity (user_id, execution_environment, strategy_id, strategy_version);

CREATE TABLE public.futures_strategy_attribution_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  execution_environment text NOT NULL CHECK (execution_environment IN ('testnet', 'production')),
  entry_order_id uuid NOT NULL REFERENCES public.futures_order_strategy_identity(order_id),
  position_id uuid REFERENCES public.positions(id),
  trade_id uuid REFERENCES public.trades(id),
  kind text NOT NULL CHECK (kind IN ('entry_fill', 'reduction', 'fee', 'funding', 'correction')),
  qty numeric NOT NULL DEFAULT 0,
  amount numeric NOT NULL DEFAULT 0,
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 300),
  corrects_event_id bigint REFERENCES public.futures_strategy_attribution_events(id),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_order_id, kind, evidence_ref),
  CONSTRAINT futures_attribution_numbers CHECK (
    qty <> 'NaN'::numeric AND qty > '-Infinity'::numeric AND qty < 'Infinity'::numeric AND qty >= 0
    AND amount <> 'NaN'::numeric AND amount > '-Infinity'::numeric AND amount < 'Infinity'::numeric),
  CONSTRAINT futures_attribution_kind_shape CHECK (CASE kind
    WHEN 'entry_fill' THEN qty > 0 AND amount = 0 AND corrects_event_id IS NULL
    WHEN 'reduction'  THEN qty > 0 AND position_id IS NOT NULL AND corrects_event_id IS NULL
    WHEN 'fee'        THEN qty = 0 AND amount <= 0 AND corrects_event_id IS NULL
    WHEN 'funding'    THEN qty = 0 AND position_id IS NOT NULL AND corrects_event_id IS NULL
    WHEN 'correction' THEN qty = 0 AND corrects_event_id IS NOT NULL AND reason IS NOT NULL
  END)
);
CREATE INDEX futures_strategy_attribution_events_order ON public.futures_strategy_attribution_events (entry_order_id, kind);
CREATE INDEX futures_strategy_attribution_events_user ON public.futures_strategy_attribution_events (user_id, execution_environment, created_at DESC);

-- ---------- guards ----------
CREATE FUNCTION public.futures_attribution_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  RAISE EXCEPTION 'futures strategy attribution is append-only (% on %)', TG_OP, TG_TABLE_NAME;
END $$;

-- Guards run as the function owner (they lock rows the API roles may not lock); EXECUTE is revoked from API roles.
CREATE FUNCTION public.guard_futures_order_strategy_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE o record;
BEGIN
  SELECT id, user_id, market_type, execution_environment, idempotency_key, status, created_at INTO o FROM public.orders WHERE id = NEW.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'strategy identity: order % not found', NEW.order_id; END IF;
  IF o.user_id IS DISTINCT FROM NEW.user_id OR o.execution_environment IS DISTINCT FROM NEW.execution_environment OR o.idempotency_key IS DISTINCT FROM NEW.idempotency_key THEN
    RAISE EXCEPTION 'strategy identity must match the order owner, environment and idempotency key';
  END IF;
  IF o.market_type IS DISTINCT FROM 'usd_m_futures' THEN RAISE EXCEPTION 'strategy identity is only captured for USD-M Futures orders'; END IF;
  IF o.idempotency_key LIKE 'futures:exit:%' THEN RAISE EXCEPTION 'exit orders inherit lineage from their position; no identity is captured'; END IF;
  -- Captured at intent creation only: the pending claim row must have been created in THIS transaction.
  IF o.status IS DISTINCT FROM 'pending' OR o.created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'strategy identity can only be captured in the transaction that claims the order (legacy orders stay UNATTRIBUTED)';
  END IF;
  NEW.captured_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER futures_order_strategy_identity_guard BEFORE INSERT ON public.futures_order_strategy_identity FOR EACH ROW EXECUTE FUNCTION public.guard_futures_order_strategy_identity();
CREATE TRIGGER futures_order_strategy_identity_immutable BEFORE UPDATE OR DELETE ON public.futures_order_strategy_identity FOR EACH ROW EXECUTE FUNCTION public.futures_attribution_immutable();
CREATE TRIGGER futures_order_strategy_identity_no_truncate BEFORE TRUNCATE ON public.futures_order_strategy_identity FOR EACH STATEMENT EXECUTE FUNCTION public.futures_attribution_immutable();

CREATE FUNCTION public.guard_futures_attribution_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE i public.futures_order_strategy_identity%ROWTYPE; p record; t record; c record; v_filled numeric; v_reduced numeric;
BEGIN
  -- Serialize every event of one attributed order (concurrent reductions cannot both pass the quantity check).
  SELECT * INTO i FROM public.futures_order_strategy_identity WHERE order_id = NEW.entry_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'attribution event without a captured strategy identity'; END IF;
  IF i.user_id IS DISTINCT FROM NEW.user_id OR i.execution_environment IS DISTINCT FROM NEW.execution_environment THEN
    RAISE EXCEPTION 'attribution event owner/environment differs from the captured identity';
  END IF;
  IF NEW.position_id IS NOT NULL THEN
    SELECT user_id, execution_environment, entry_order_id INTO p FROM public.positions WHERE id = NEW.position_id;
    IF NOT FOUND OR p.user_id IS DISTINCT FROM i.user_id OR p.execution_environment IS DISTINCT FROM i.execution_environment OR p.entry_order_id IS DISTINCT FROM i.order_id THEN
      RAISE EXCEPTION 'attribution position is not the position opened by the attributed entry order';
    END IF;
  END IF;
  IF NEW.trade_id IS NOT NULL THEN
    SELECT user_id, execution_environment, position_id INTO t FROM public.trades WHERE id = NEW.trade_id;
    IF NOT FOUND OR NEW.position_id IS NULL OR t.user_id IS DISTINCT FROM i.user_id OR t.execution_environment IS DISTINCT FROM i.execution_environment OR t.position_id IS DISTINCT FROM NEW.position_id THEN
      RAISE EXCEPTION 'attribution trade is not the close of the attributed position';
    END IF;
  END IF;
  IF NEW.kind = 'reduction' THEN
    SELECT coalesce(sum(qty) FILTER (WHERE kind = 'entry_fill'), 0), coalesce(sum(qty) FILTER (WHERE kind = 'reduction'), 0)
      INTO v_filled, v_reduced FROM public.futures_strategy_attribution_events WHERE entry_order_id = NEW.entry_order_id;
    IF v_reduced + NEW.qty > v_filled THEN
      RAISE EXCEPTION 'reductions (% + %) would exceed the attributed filled quantity %', v_reduced, NEW.qty, v_filled;
    END IF;
  END IF;
  IF NEW.kind = 'correction' THEN
    SELECT entry_order_id, kind INTO c FROM public.futures_strategy_attribution_events WHERE id = NEW.corrects_event_id;
    IF NOT FOUND OR c.entry_order_id IS DISTINCT FROM NEW.entry_order_id THEN RAISE EXCEPTION 'a correction must reference an event of the same attributed order'; END IF;
    IF c.kind = 'correction' THEN RAISE EXCEPTION 'a correction corrects an original event, never another correction'; END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER futures_attribution_event_guard BEFORE INSERT ON public.futures_strategy_attribution_events FOR EACH ROW EXECUTE FUNCTION public.guard_futures_attribution_event();
CREATE TRIGGER futures_attribution_event_immutable BEFORE UPDATE OR DELETE ON public.futures_strategy_attribution_events FOR EACH ROW EXECUTE FUNCTION public.futures_attribution_immutable();
CREATE TRIGGER futures_attribution_event_no_truncate BEFORE TRUNCATE ON public.futures_strategy_attribution_events FOR EACH STATEMENT EXECUTE FUNCTION public.futures_attribution_immutable();

-- Called by a FUTURE, separately approved order path inside its claim transaction. Retries are consistent: the same
-- tuple returns 'existing', a different tuple is refused. Not SECURITY DEFINER: it runs with the caller's rights.
CREATE FUNCTION public.claim_futures_order_strategy_identity(p_order uuid, p_strategy_id text, p_version integer, p_config_sha256 text)
RETURNS text LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE o record; i public.futures_order_strategy_identity%ROWTYPE;
BEGIN
  IF p_order IS NULL OR p_strategy_id IS NULL OR p_version IS NULL OR p_config_sha256 IS NULL THEN RAISE EXCEPTION 'strategy identity: every argument is required'; END IF;
  SELECT id, user_id, execution_environment, idempotency_key INTO o FROM public.orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'strategy identity: order % not found', p_order; END IF;
  SELECT * INTO i FROM public.futures_order_strategy_identity WHERE order_id = p_order;
  IF FOUND THEN
    IF (i.strategy_id, i.strategy_version, i.strategy_config_sha256) IS DISTINCT FROM (p_strategy_id, p_version, p_config_sha256) THEN
      RAISE EXCEPTION 'retried order % carries a different strategy identity', p_order;
    END IF;
    RETURN 'existing';
  END IF;
  INSERT INTO public.futures_order_strategy_identity (order_id, user_id, execution_environment, idempotency_key, strategy_id, strategy_version, strategy_config_sha256)
  VALUES (o.id, o.user_id, o.execution_environment, o.idempotency_key, p_strategy_id, p_version, p_config_sha256);
  RETURN 'captured';
END $$;

-- Order → position → trade lineage. A trade without a captured identity is UNATTRIBUTED (never inferred).
CREATE VIEW public.futures_trade_strategy_attribution WITH (security_invoker = true) AS
SELECT t.id AS trade_id, t.user_id, t.execution_environment, t.position_id, p.entry_order_id,
       i.strategy_id, i.strategy_version, i.strategy_config_sha256,
       CASE WHEN i.order_id IS NULL THEN 'UNATTRIBUTED' ELSE 'ATTRIBUTED' END AS attribution_status
  FROM public.trades t
  LEFT JOIN public.positions p ON p.id = t.position_id AND p.user_id = t.user_id
  LEFT JOIN public.futures_order_strategy_identity i ON i.order_id = p.entry_order_id AND i.user_id = t.user_id AND i.execution_environment = t.execution_environment
 WHERE t.market_type = 'usd_m_futures';

-- ---------- privileges and row security ----------
REVOKE ALL ON public.futures_order_strategy_identity, public.futures_strategy_attribution_events, public.futures_trade_strategy_attribution FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.futures_order_strategy_identity, public.futures_strategy_attribution_events, public.futures_trade_strategy_attribution TO authenticated, service_role;
GRANT INSERT ON public.futures_order_strategy_identity, public.futures_strategy_attribution_events TO service_role;
ALTER TABLE public.futures_order_strategy_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_strategy_attribution_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_order_strategy_identity_owner_read ON public.futures_order_strategy_identity FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_strategy_attribution_events_owner_read ON public.futures_strategy_attribution_events FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
REVOKE ALL ON FUNCTION public.futures_attribution_immutable(), public.guard_futures_order_strategy_identity(), public.guard_futures_attribution_event(),
  public.claim_futures_order_strategy_identity(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_futures_order_strategy_identity(uuid, text, integer, text) TO service_role;
