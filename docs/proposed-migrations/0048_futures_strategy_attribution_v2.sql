-- =====================================================================================================================
-- 0048 — DRAFT ONLY. NOT APPLIED. Reviewed SUCCESSOR of draft 0047 (Phase 4E, Workstream B). It SUPERSEDES 0047:
-- standalone, same object names — NEVER apply both. The number is proposed only; the final number is assigned at owner
-- approval (it depends on which of the unapplied drafts 0040–0046 are applied first).
--
-- Immutable strategy identity for REAL USD-M Futures orders, captured at intent-claim time, plus an append-only
-- attribution ledger. Unchanged from 0047: identity capture rules, owner/environment binding, legacy = UNATTRIBUTED
-- (nothing is inferred from bot_id, trades.strategy_id, symbol, notes or similarity), no change to public.orders,
-- public.positions or public.trades, owner-only MFA-aware reads, service-role-only writes through guarded paths.
--
-- What 0048 changes (weaknesses of 0047, docs/phase-4e/attribution-corrections-review.md):
--  W1  0047 corrections had no defined effect (qty = 0, amount free): replacement or delta was ambiguous, and entry-fill
--      / reduction quantities could not be corrected at all. 0048: a correction RESTATES the full effective value of one
--      ORIGINAL event (corrected_qty, corrected_amount) — replacement semantics, never a delta.
--  W2  0047 checked Σ reductions ≤ Σ fills on raw rows, ignoring corrections. 0048: every reduction AND every
--      correction is checked against EFFECTIVE totals (latest revision of every original event).
--  W3  0047 allowed any number of corrections of the same event (different evidence refs → double counting under delta
--      semantics). 0048: corrections of one original form a single linear chain numbered 1, 2, 3 … ≤ 20; the caller
--      names the revision it creates (compare-and-set): a stale or out-of-order revision, a fork (two corrections of the
--      same revision), a correction of a correction, a self-reference and a no-op restatement are all refused.
--  W4  0047 let reductions carry an `amount` that was summed with fees and funding (a second, ambiguous P&L source).
--      0048: reductions and fills carry quantity only (amount = 0); realized P&L stays in public.trades. Fees and
--      funding carry amount only.
--  W5  0047 had no effective-totals read model. 0048 adds two security-invoker views: per-event effective values and
--      per-order effective totals (filled, reduced, open, fees, funding, revisions).
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
  -- correction only: the ORIGINAL event restated, the revision this row creates, and the full restated values.
  corrects_event_id bigint REFERENCES public.futures_strategy_attribution_events(id),
  correction_revision integer,
  corrected_qty numeric,
  corrected_amount numeric,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_order_id, kind, evidence_ref),
  CONSTRAINT futures_attribution_one_revision UNIQUE (corrects_event_id, correction_revision),
  CONSTRAINT futures_attribution_numbers CHECK (
    qty <> 'NaN'::numeric AND qty > '-Infinity'::numeric AND qty < 'Infinity'::numeric AND qty >= 0
    AND amount <> 'NaN'::numeric AND amount > '-Infinity'::numeric AND amount < 'Infinity'::numeric
    AND (corrected_qty IS NULL OR (corrected_qty <> 'NaN'::numeric AND corrected_qty < 'Infinity'::numeric AND corrected_qty >= 0))
    AND (corrected_amount IS NULL OR (corrected_amount <> 'NaN'::numeric AND corrected_amount > '-Infinity'::numeric AND corrected_amount < 'Infinity'::numeric))),
  CONSTRAINT futures_attribution_kind_shape CHECK (CASE kind
    WHEN 'entry_fill' THEN qty > 0 AND amount = 0
    WHEN 'reduction'  THEN qty > 0 AND amount = 0 AND position_id IS NOT NULL
    WHEN 'fee'        THEN qty = 0 AND amount <= 0
    WHEN 'funding'    THEN qty = 0 AND position_id IS NOT NULL
    WHEN 'correction' THEN qty = 0 AND amount = 0 AND position_id IS NULL AND trade_id IS NULL
                      AND corrects_event_id IS NOT NULL AND correction_revision BETWEEN 1 AND 20
                      AND corrected_qty IS NOT NULL AND corrected_amount IS NOT NULL AND reason IS NOT NULL
  END),
  CONSTRAINT futures_attribution_correction_fields CHECK (
    kind = 'correction' OR (corrects_event_id IS NULL AND correction_revision IS NULL AND corrected_qty IS NULL AND corrected_amount IS NULL))
);
CREATE INDEX futures_strategy_attribution_events_order ON public.futures_strategy_attribution_events (entry_order_id, kind);
CREATE INDEX futures_strategy_attribution_events_user ON public.futures_strategy_attribution_events (user_id, execution_environment, created_at DESC);
CREATE INDEX futures_strategy_attribution_events_corrects ON public.futures_strategy_attribution_events (corrects_event_id, correction_revision DESC) WHERE corrects_event_id IS NOT NULL;

-- ---------- guards ----------
CREATE FUNCTION public.futures_attribution_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  RAISE EXCEPTION 'futures strategy attribution is append-only (% on %)', TG_OP, TG_TABLE_NAME;
END $$;

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
  IF o.status IS DISTINCT FROM 'pending' OR o.created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'strategy identity can only be captured in the transaction that claims the order (legacy orders stay UNATTRIBUTED)';
  END IF;
  NEW.captured_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER futures_order_strategy_identity_guard BEFORE INSERT ON public.futures_order_strategy_identity FOR EACH ROW EXECUTE FUNCTION public.guard_futures_order_strategy_identity();
CREATE TRIGGER futures_order_strategy_identity_immutable BEFORE UPDATE OR DELETE ON public.futures_order_strategy_identity FOR EACH ROW EXECUTE FUNCTION public.futures_attribution_immutable();
CREATE TRIGGER futures_order_strategy_identity_no_truncate BEFORE TRUNCATE ON public.futures_order_strategy_identity FOR EACH STATEMENT EXECUTE FUNCTION public.futures_attribution_immutable();

-- Effective quantity totals of one attributed order: every ORIGINAL fill/reduction at its latest restated quantity.
-- Internal helper of the guard (EXECUTE revoked from API roles); callers must hold the identity row lock.
CREATE FUNCTION public.futures_attribution_effective_qty(p_order uuid, OUT filled numeric, OUT reduced numeric)
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT coalesce(sum(s.eff) FILTER (WHERE s.kind = 'entry_fill'), 0), coalesce(sum(s.eff) FILTER (WHERE s.kind = 'reduction'), 0)
    FROM (SELECT e.kind, coalesce((SELECT x.corrected_qty FROM public.futures_strategy_attribution_events x
                                    WHERE x.kind = 'correction' AND x.corrects_event_id = e.id
                                    ORDER BY x.correction_revision DESC LIMIT 1), e.qty) AS eff
            FROM public.futures_strategy_attribution_events e
           WHERE e.entry_order_id = p_order AND e.kind IN ('entry_fill', 'reduction')) s
$$;

CREATE FUNCTION public.guard_futures_attribution_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE i public.futures_order_strategy_identity%ROWTYPE; p record; t record; o public.futures_strategy_attribution_events%ROWTYPE;
        v_rev integer; v_cur_qty numeric; v_cur_amount numeric; v_filled numeric; v_reduced numeric;
BEGIN
  -- Serialize EVERY event of one attributed order (fills, reductions, fees, funding, corrections) on its identity row:
  -- concurrent reductions and corrections cannot both pass the effective-quantity check or claim the same revision.
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

  SELECT * INTO v_filled, v_reduced FROM public.futures_attribution_effective_qty(NEW.entry_order_id);

  IF NEW.kind = 'reduction' THEN
    IF v_reduced + NEW.qty > v_filled THEN
      RAISE EXCEPTION 'reductions (% + %) would exceed the effective filled quantity %', v_reduced, NEW.qty, v_filled;
    END IF;
  ELSIF NEW.kind = 'correction' THEN
    IF NEW.corrected_qty IS NULL OR NEW.corrected_amount IS NULL OR NEW.corrected_qty = 'NaN'::numeric OR NEW.corrected_amount = 'NaN'::numeric
       OR NEW.corrected_qty < 0 OR NEW.corrected_qty = 'Infinity'::numeric OR abs(NEW.corrected_amount) = 'Infinity'::numeric THEN
      RAISE EXCEPTION 'corrected values must be finite numbers and corrected quantities non-negative';
    END IF;
    IF NEW.corrects_event_id >= NEW.id THEN RAISE EXCEPTION 'a correction must reference an earlier, existing original event'; END IF;
    SELECT * INTO o FROM public.futures_strategy_attribution_events WHERE id = NEW.corrects_event_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'a correction must reference an earlier, existing original event'; END IF;
    IF o.entry_order_id IS DISTINCT FROM NEW.entry_order_id THEN RAISE EXCEPTION 'a correction must reference an event of the same attributed order'; END IF;
    IF o.kind = 'correction' THEN RAISE EXCEPTION 'a correction restates an original event, never another correction'; END IF;
    -- Linear chain, compare-and-set: the caller names the revision it creates; it must be exactly the next one.
    SELECT coalesce(max(x.correction_revision), 0) INTO v_rev FROM public.futures_strategy_attribution_events x WHERE x.kind = 'correction' AND x.corrects_event_id = o.id;
    IF NEW.correction_revision IS DISTINCT FROM v_rev + 1 THEN
      RAISE EXCEPTION 'stale or out-of-order correction: event % is at revision %, so the next correction must be revision %', o.id, v_rev, v_rev + 1;
    END IF;
    SELECT coalesce((SELECT x.corrected_qty FROM public.futures_strategy_attribution_events x WHERE x.kind = 'correction' AND x.corrects_event_id = o.id ORDER BY x.correction_revision DESC LIMIT 1), o.qty),
           coalesce((SELECT x.corrected_amount FROM public.futures_strategy_attribution_events x WHERE x.kind = 'correction' AND x.corrects_event_id = o.id ORDER BY x.correction_revision DESC LIMIT 1), o.amount)
      INTO v_cur_qty, v_cur_amount;
    IF NEW.corrected_qty = v_cur_qty AND NEW.corrected_amount = v_cur_amount THEN
      RAISE EXCEPTION 'correction repeats the current effective values of event % (no-op corrections are refused)', o.id;
    END IF;
    -- The restated values must keep the ORIGINAL event's shape (0 = voided for quantities).
    IF o.kind IN ('entry_fill', 'reduction') AND NEW.corrected_amount <> 0 THEN RAISE EXCEPTION 'a % correction restates a quantity only (corrected_amount must be 0)', o.kind; END IF;
    IF o.kind IN ('fee', 'funding') AND NEW.corrected_qty <> 0 THEN RAISE EXCEPTION 'a % correction restates an amount only (corrected_qty must be 0)', o.kind; END IF;
    IF o.kind = 'fee' AND NEW.corrected_amount > 0 THEN RAISE EXCEPTION 'a fee correction cannot make the fee positive'; END IF;
    -- Effective invariant after the restatement: reductions never exceed fills.
    IF o.kind = 'entry_fill' THEN v_filled := v_filled - v_cur_qty + NEW.corrected_qty; END IF;
    IF o.kind = 'reduction' THEN v_reduced := v_reduced - v_cur_qty + NEW.corrected_qty; END IF;
    IF v_reduced > v_filled THEN
      RAISE EXCEPTION 'correction would make effective reductions % exceed the effective filled quantity %', v_reduced, v_filled;
    END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER futures_attribution_event_guard BEFORE INSERT ON public.futures_strategy_attribution_events FOR EACH ROW EXECUTE FUNCTION public.guard_futures_attribution_event();
CREATE TRIGGER futures_attribution_event_immutable BEFORE UPDATE OR DELETE ON public.futures_strategy_attribution_events FOR EACH ROW EXECUTE FUNCTION public.futures_attribution_immutable();
CREATE TRIGGER futures_attribution_event_no_truncate BEFORE TRUNCATE ON public.futures_strategy_attribution_events FOR EACH STATEMENT EXECUTE FUNCTION public.futures_attribution_immutable();

-- Called by a FUTURE, separately approved order path inside its claim transaction (unchanged from 0047).
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

-- ---------- read models (security invoker: the caller's row security applies) ----------
-- Every ORIGINAL event at its effective (latest restated) value. Corrections themselves are not rows here.
CREATE VIEW public.futures_strategy_attribution_effective WITH (security_invoker = true) AS
SELECT e.id AS event_id, e.user_id, e.execution_environment, e.entry_order_id, e.position_id, e.trade_id, e.kind, e.evidence_ref,
       e.qty AS original_qty, e.amount AS original_amount,
       coalesce(c.corrected_qty, e.qty) AS effective_qty, coalesce(c.corrected_amount, e.amount) AS effective_amount,
       coalesce(c.correction_revision, 0) AS revision, c.id AS latest_correction_id, e.created_at
  FROM public.futures_strategy_attribution_events e
  LEFT JOIN LATERAL (SELECT x.id, x.corrected_qty, x.corrected_amount, x.correction_revision FROM public.futures_strategy_attribution_events x
                      WHERE x.kind = 'correction' AND x.corrects_event_id = e.id ORDER BY x.correction_revision DESC LIMIT 1) c ON true
 WHERE e.kind <> 'correction';

-- Per attributed order: effective filled / reduced / open quantity, fees, funding and the number of restatements.
CREATE VIEW public.futures_strategy_attribution_totals WITH (security_invoker = true) AS
SELECT i.order_id AS entry_order_id, i.user_id, i.execution_environment, i.strategy_id, i.strategy_version, i.strategy_config_sha256,
       coalesce(sum(f.effective_qty) FILTER (WHERE f.kind = 'entry_fill'), 0) AS filled_qty,
       coalesce(sum(f.effective_qty) FILTER (WHERE f.kind = 'reduction'), 0) AS reduced_qty,
       coalesce(sum(f.effective_qty) FILTER (WHERE f.kind = 'entry_fill'), 0) - coalesce(sum(f.effective_qty) FILTER (WHERE f.kind = 'reduction'), 0) AS open_qty,
       coalesce(sum(f.effective_amount) FILTER (WHERE f.kind = 'fee'), 0) AS fees,
       coalesce(sum(f.effective_amount) FILTER (WHERE f.kind = 'funding'), 0) AS funding,
       coalesce(sum(f.revision), 0) AS restatements
  FROM public.futures_order_strategy_identity i
  LEFT JOIN public.futures_strategy_attribution_effective f ON f.entry_order_id = i.order_id AND f.user_id = i.user_id
 GROUP BY i.order_id, i.user_id, i.execution_environment, i.strategy_id, i.strategy_version, i.strategy_config_sha256;

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
REVOKE ALL ON public.futures_order_strategy_identity, public.futures_strategy_attribution_events, public.futures_trade_strategy_attribution,
  public.futures_strategy_attribution_effective, public.futures_strategy_attribution_totals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.futures_order_strategy_identity, public.futures_strategy_attribution_events, public.futures_trade_strategy_attribution,
  public.futures_strategy_attribution_effective, public.futures_strategy_attribution_totals TO authenticated, service_role;
GRANT INSERT ON public.futures_order_strategy_identity, public.futures_strategy_attribution_events TO service_role;
ALTER TABLE public.futures_order_strategy_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_strategy_attribution_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_order_strategy_identity_owner_read ON public.futures_order_strategy_identity FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE POLICY futures_strategy_attribution_events_owner_read ON public.futures_strategy_attribution_events FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
REVOKE ALL ON FUNCTION public.futures_attribution_immutable(), public.guard_futures_order_strategy_identity(), public.guard_futures_attribution_event(),
  public.futures_attribution_effective_qty(uuid), public.claim_futures_order_strategy_identity(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.futures_attribution_effective_qty(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.claim_futures_order_strategy_identity(uuid, text, integer, text) TO service_role;
