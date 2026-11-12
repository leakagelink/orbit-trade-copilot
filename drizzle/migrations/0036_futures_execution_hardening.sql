-- Phase 1 Futures hardening: one accounting contract, immutable execution environment,
-- durable client IDs, single-writer leases, deduplicated broker evidence and atomic ledger finalization.

-- 1. Accounting contract: realized_pnl is GROSS (excludes funding and fees). Net = gross + funding - fees.
COMMENT ON COLUMN public.trades.realized_pnl IS 'Gross realized PnL. Excludes funding and fees, which are stored separately.';
COMMENT ON COLUMN public.trades.funding_pnl IS 'Signed funding attributed to this trade (positive = received). Never included in realized_pnl.';
ALTER TABLE public.trades ADD COLUMN net_pnl numeric GENERATED ALWAYS AS (realized_pnl + coalesce(funding_pnl,0) - fees) STORED;

-- 2. Immutable execution environment captured when each record is written.
ALTER TABLE public.orders ADD COLUMN execution_environment text CHECK (execution_environment IN ('paper','testnet','production','legacy_unknown'));
ALTER TABLE public.positions ADD COLUMN execution_environment text CHECK (execution_environment IN ('paper','testnet','production','legacy_unknown'));
ALTER TABLE public.trades ADD COLUMN execution_environment text CHECK (execution_environment IN ('paper','testnet','production','legacy_unknown'));

-- Backfill only from evidence recorded at entry time (positions.futures_details.testnet); never from the current connection.
UPDATE public.positions SET execution_environment = CASE
  WHEN mode = 'paper' THEN 'paper'
  WHEN market_type = 'usd_m_futures' AND futures_details ? 'testnet' THEN CASE WHEN (futures_details->>'testnet')::boolean THEN 'testnet' ELSE 'production' END
  ELSE 'legacy_unknown' END;
UPDATE public.orders o SET execution_environment = CASE
  WHEN o.mode = 'paper' THEN 'paper'
  ELSE coalesce((SELECT p.execution_environment FROM public.positions p WHERE p.entry_order_id = o.id AND p.execution_environment <> 'legacy_unknown' LIMIT 1),
                (SELECT p.execution_environment FROM public.positions p WHERE o.market_type='usd_m_futures' AND o.idempotency_key = 'futures:exit:' || p.id::text AND p.execution_environment <> 'legacy_unknown' LIMIT 1),
                'legacy_unknown') END;
UPDATE public.trades t SET execution_environment = CASE
  WHEN t.mode = 'paper' THEN 'paper'
  ELSE coalesce((SELECT p.execution_environment FROM public.positions p WHERE p.entry_order_id = t.order_id AND p.execution_environment <> 'legacy_unknown' LIMIT 1),'legacy_unknown') END;

CREATE OR REPLACE FUNCTION public.set_execution_environment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE derived text; is_test boolean;
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF NEW.execution_environment IS DISTINCT FROM OLD.execution_environment THEN RAISE EXCEPTION 'Execution environment is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.mode = 'paper' THEN derived := 'paper';
 ELSE
  IF TG_TABLE_NAME = 'trades' AND NEW.order_id IS NOT NULL THEN
   SELECT execution_environment INTO derived FROM public.orders WHERE id = NEW.order_id;
  END IF;
  IF derived IS NULL OR derived = 'legacy_unknown' THEN
   SELECT is_testnet INTO is_test FROM public.exchange_connections WHERE id = NEW.exchange_connection_id;
   derived := CASE WHEN is_test IS NULL THEN 'legacy_unknown' WHEN is_test THEN 'testnet' ELSE 'production' END;
  END IF;
 END IF;
 IF NEW.execution_environment IS NULL THEN NEW.execution_environment := derived;
 ELSIF NEW.execution_environment <> derived AND derived <> 'legacy_unknown' THEN RAISE EXCEPTION 'Execution environment does not match the trading account';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.set_execution_environment() FROM PUBLIC;
CREATE TRIGGER aa_orders_execution_environment BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_execution_environment();
CREATE TRIGGER aa_positions_execution_environment BEFORE INSERT OR UPDATE ON public.positions FOR EACH ROW EXECUTE FUNCTION public.set_execution_environment();
CREATE TRIGGER aa_trades_execution_environment BEFORE INSERT OR UPDATE ON public.trades FOR EACH ROW EXECUTE FUNCTION public.set_execution_environment();
ALTER TABLE public.orders ALTER COLUMN execution_environment SET NOT NULL;
ALTER TABLE public.positions ALTER COLUMN execution_environment SET NOT NULL;
ALTER TABLE public.trades ALTER COLUMN execution_environment SET NOT NULL;
CREATE INDEX trades_environment_idx ON public.trades(user_id, execution_environment, market_type, closed_at);

-- 3. Durable client order IDs and exact position-to-trade attribution.
ALTER TABLE public.orders ADD COLUMN client_order_id text;
UPDATE public.orders SET client_order_id = CASE WHEN idempotency_key LIKE 'futures:exit:%' THEN 'fx-' ELSE 'fv-' END || left(id::text, 28)
 WHERE market_type = 'usd_m_futures';
CREATE UNIQUE INDEX orders_client_order_id_unique ON public.orders(exchange_connection_id, client_order_id) WHERE client_order_id IS NOT NULL;
ALTER TABLE public.trades ADD COLUMN position_id uuid;
UPDATE public.trades t SET position_id = p.id FROM public.positions p WHERE t.market_type = 'usd_m_futures' AND p.entry_order_id = t.order_id;
CREATE UNIQUE INDEX trades_one_futures_close_per_position ON public.trades(position_id) WHERE market_type = 'usd_m_futures' AND position_id IS NOT NULL;

-- 4. Single-writer execution leases with monotonically increasing fences (service-only writes).
CREATE TABLE public.futures_execution_leases (
 connection_id uuid PRIMARY KEY, user_id uuid NOT NULL, holder uuid NOT NULL, fence bigint NOT NULL,
 purpose text NOT NULL, acquired_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
GRANT SELECT ON public.futures_execution_leases TO authenticated;
GRANT ALL ON public.futures_execution_leases TO service_role;
ALTER TABLE public.futures_execution_leases ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_leases_owner_read ON public.futures_execution_leases FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());

CREATE OR REPLACE FUNCTION public.futures_acquire_lease(_connection uuid, _user uuid, _holder uuid, _purpose text, _ttl_seconds integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE f bigint;
BEGIN
 IF _ttl_seconds IS NULL OR _ttl_seconds < 5 OR _ttl_seconds > 300 THEN RAISE EXCEPTION 'Lease duration out of bounds'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.exchange_connections WHERE id = _connection AND user_id = _user) THEN RAISE EXCEPTION 'Owner connection required'; END IF;
 INSERT INTO public.futures_execution_leases AS l (connection_id, user_id, holder, fence, purpose, acquired_at, expires_at)
 VALUES (_connection, _user, _holder, 1, left(_purpose, 60), now(), now() + make_interval(secs => _ttl_seconds))
 ON CONFLICT (connection_id) DO UPDATE SET holder = EXCLUDED.holder, fence = l.fence + 1, purpose = EXCLUDED.purpose, acquired_at = now(), expires_at = EXCLUDED.expires_at
 WHERE l.expires_at <= now()
 RETURNING fence INTO f;
 RETURN f;
END $$;
CREATE OR REPLACE FUNCTION public.futures_renew_lease(_connection uuid, _holder uuid, _fence bigint, _ttl_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF _ttl_seconds IS NULL OR _ttl_seconds < 5 OR _ttl_seconds > 300 THEN RAISE EXCEPTION 'Lease duration out of bounds'; END IF;
 UPDATE public.futures_execution_leases SET expires_at = now() + make_interval(secs => _ttl_seconds)
  WHERE connection_id = _connection AND holder = _holder AND fence = _fence AND expires_at > now();
 RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.futures_release_lease(_connection uuid, _holder uuid, _fence bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE public.futures_execution_leases SET expires_at = now() WHERE connection_id = _connection AND holder = _holder AND fence = _fence;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.futures_acquire_lease(uuid,uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.futures_renew_lease(uuid,uuid,bigint,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.futures_release_lease(uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.futures_acquire_lease(uuid,uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.futures_renew_lease(uuid,uuid,bigint,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.futures_release_lease(uuid,uuid,bigint) TO service_role;

-- 5. Append-only, deduplicated broker evidence (fills, funding, protection and containment observations).
CREATE TABLE public.futures_broker_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, connection_id uuid NOT NULL, position_id uuid,
 event_type text NOT NULL CHECK (event_type IN ('entry_fill','exit_fill','funding','order_status','protection_status','containment')),
 broker_event_id text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', observed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (connection_id, event_type, broker_event_id)
);
GRANT SELECT ON public.futures_broker_events TO authenticated;
GRANT ALL ON public.futures_broker_events TO service_role;
ALTER TABLE public.futures_broker_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_broker_events_owner_read ON public.futures_broker_events FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE TRIGGER futures_broker_events_immutable BEFORE UPDATE OR DELETE ON public.futures_broker_events FOR EACH ROW EXECUTE FUNCTION public.safety_event_immutable();
CREATE INDEX futures_broker_events_position_idx ON public.futures_broker_events(position_id);

-- 6. Atomic, fenced final ledger transition: trade insert + position close in one transaction.
CREATE OR REPLACE FUNCTION public.futures_finalize_position(_position uuid, _holder uuid, _fence bigint, _trade jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p public.positions%ROWTYPE; l public.futures_execution_leases%ROWTYPE; tid uuid;
 q numeric; ep numeric; xp numeric; g numeric; f numeric; fu numeric;
BEGIN
 SELECT * INTO p FROM public.positions WHERE id = _position FOR UPDATE;
 IF NOT FOUND OR p.market_type <> 'usd_m_futures' THEN RAISE EXCEPTION 'Futures position not found'; END IF;
 SELECT * INTO l FROM public.futures_execution_leases WHERE connection_id = p.exchange_connection_id FOR UPDATE;
 IF NOT FOUND OR l.holder <> _holder OR l.fence <> _fence OR l.expires_at <= now() THEN RAISE EXCEPTION 'Execution lease lost; another writer owns this account'; END IF;
 SELECT id INTO tid FROM public.trades WHERE position_id = _position AND market_type = 'usd_m_futures';
 IF tid IS NOT NULL THEN
  UPDATE public.positions SET is_open = false, closed_at = coalesce(closed_at, now()), unrealized_pnl = 0 WHERE id = _position AND is_open;
  RETURN tid;
 END IF;
 IF NOT p.is_open THEN RAISE EXCEPTION 'Position already closed without a ledger entry; manual reconciliation required'; END IF;
 IF _trade IS NULL THEN
  UPDATE public.positions SET is_open = false, closed_at = now(), unrealized_pnl = 0,
   futures_details = coalesce(futures_details, '{}'::jsonb) || jsonb_build_object('protection','closed','recovery',null,'state','no_fill') WHERE id = _position;
  RETURN NULL;
 END IF;
 q := (_trade->>'quantity')::numeric; ep := (_trade->>'entry_price')::numeric; xp := (_trade->>'exit_price')::numeric;
 g := (_trade->>'gross')::numeric; f := (_trade->>'fees')::numeric; fu := (_trade->>'funding')::numeric;
 IF q IS NULL OR ep IS NULL OR xp IS NULL OR g IS NULL OR f IS NULL OR fu IS NULL
  OR q = 'NaN'::numeric OR ep = 'NaN'::numeric OR xp = 'NaN'::numeric OR g = 'NaN'::numeric OR f = 'NaN'::numeric OR fu = 'NaN'::numeric
  OR q <= 0 OR ep <= 0 OR xp <= 0 OR f < 0 THEN RAISE EXCEPTION 'Futures ledger values are incomplete or invalid'; END IF;
 INSERT INTO public.trades (user_id, order_id, position_id, exchange, exchange_connection_id, trading_pair, side, quantity, entry_price, exit_price,
  realized_pnl, fees, funding_pnl, costs_verified, mode, market_type, execution_environment, opened_at, closed_at, close_reason, is_scalp)
 VALUES (p.user_id, p.entry_order_id, p.id, p.exchange, p.exchange_connection_id, p.trading_pair, p.side, q, ep, xp,
  g, f, fu, true, p.mode, 'usd_m_futures', p.execution_environment, p.opened_at, now(), left(coalesce(_trade->>'reason','closed'), 60), p.is_scalp)
 RETURNING id INTO tid;
 UPDATE public.positions SET is_open = false, closed_at = now(), current_price = xp, unrealized_pnl = 0, quantity = q, entry_price = ep,
  futures_details = coalesce(futures_details, '{}'::jsonb) || jsonb_build_object('protection','closed','recovery',null,'state','closed','tradeId',tid)
  WHERE id = _position;
 RETURN tid;
END $$;
REVOKE ALL ON FUNCTION public.futures_finalize_position(uuid,uuid,bigint,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.futures_finalize_position(uuid,uuid,bigint,jsonb) TO service_role;

-- 7. New Futures entries stay blocked while any Futures exposure or intent is unresolved (atomic, DB-enforced).
CREATE OR REPLACE FUNCTION public.guard_futures_live_intent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s public.futures_settings%ROWTYPE; c public.exchange_connections%ROWTYPE;
BEGIN
 IF NEW.market_type <> 'usd_m_futures' OR NEW.idempotency_key LIKE '%:exit:%' THEN RETURN NEW; END IF;
 SELECT * INTO c FROM public.exchange_connections WHERE id=NEW.exchange_connection_id AND user_id=NEW.user_id;
 IF NOT FOUND OR c.exchange<>'binance' OR c.status<>'connected' THEN RAISE EXCEPTION 'Verified owner Binance connection required'; END IF;
 IF NOT c.is_testnet THEN
  SELECT * INTO s FROM public.futures_settings WHERE user_id=NEW.user_id;
  IF NOT FOUND OR NOT s.live_enabled OR s.connection_id<>c.id OR s.testnet_certified_at IS NULL THEN RAISE EXCEPTION 'Futures live opt-in and independent testnet verification required'; END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM public.positions WHERE user_id=NEW.user_id AND market_type='usd_m_futures' AND is_open AND coalesce(futures_details->>'protection','')<>'confirmed') THEN
  RAISE EXCEPTION 'Unresolved Futures exposure blocks new entries';
 END IF;
 IF EXISTS (SELECT 1 FROM public.orders WHERE user_id=NEW.user_id AND market_type='usd_m_futures' AND status IN ('pending','open','partially_filled')) THEN
  RAISE EXCEPTION 'Unresolved Futures order intent blocks new entries';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_futures_live_intent() FROM PUBLIC;

-- 8. Central risk gate and trade notifications use the same net contract (gross + funding - fees).
CREATE OR REPLACE FUNCTION public.guard_new_entry_intent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.risk_settings%ROWTYPE; exposure numeric; reserved numeric; position_count integer; pending_count integer; pnl numeric;
BEGIN
 IF NEW.idempotency_key LIKE '%:exit:%' THEN RETURN NEW; END IF;
 IF NEW.price IS NULL OR NEW.price<=0 OR NEW.quantity<=0 THEN RAISE EXCEPTION 'Entry intent requires a positive verified reference price and quantity'; END IF;
 SELECT * INTO r FROM public.risk_settings WHERE user_id=NEW.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Risk settings required before an entry'; END IF;
 IF r.trading_halted THEN RAISE EXCEPTION 'Trading is halted'; END IF;
 SELECT count(*),coalesce(sum(entry_price*quantity),0) INTO position_count,exposure FROM public.positions WHERE user_id=NEW.user_id AND is_open;
 SELECT count(*),coalesce(sum(quantity*price),0) INTO pending_count,reserved FROM public.orders WHERE user_id=NEW.user_id AND status IN ('pending','open','partially_filled') AND idempotency_key NOT LIKE '%:exit:%';
 IF r.max_total_positions IS NOT NULL AND position_count+pending_count>=r.max_total_positions THEN RAISE EXCEPTION 'Account position limit reached including pending intents'; END IF;
 IF r.max_open_exposure IS NOT NULL AND exposure+reserved+NEW.quantity*NEW.price>r.max_open_exposure THEN RAISE EXCEPTION 'Account exposure limit reached including pending intents'; END IF;
 SELECT coalesce(sum(net_pnl),0) INTO pnl FROM public.trades WHERE user_id=NEW.user_id AND closed_at>=date_trunc('day',now());
 SELECT pnl+coalesce(sum(least(unrealized_pnl,0)),0) INTO pnl FROM public.positions WHERE user_id=NEW.user_id AND is_open;
 IF r.max_daily_loss IS NOT NULL AND pnl<=-r.max_daily_loss THEN RAISE EXCEPTION 'Account loss limit reached'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_new_entry_intent() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.notify_trading_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE heading text; detail text; BEGIN
IF NOT public.has_pro_access(NEW.user_id) THEN RETURN NEW; END IF;
IF TG_TABLE_NAME='orders' THEN
IF NEW.status NOT IN ('filled','rejected') OR (TG_OP='UPDATE' AND OLD.status=NEW.status) THEN RETURN NEW; END IF;
heading:=CASE WHEN NEW.status='filled' THEN 'Order filled: ' ELSE 'Order rejected: ' END||NEW.trading_pair; detail:=NEW.side||' / '||NEW.mode;
ELSIF TG_TABLE_NAME='trades' THEN heading:='Trade closed: '||NEW.trading_pair; detail:='Net P&L: '||(NEW.realized_pnl+coalesce(NEW.funding_pnl,0)-NEW.fees)||' · '||coalesce(NEW.close_reason,'closed');
ELSIF TG_TABLE_NAME='trading_bots' THEN IF NEW.status<>'error' OR OLD.status=NEW.status THEN RETURN NEW; END IF; heading:='Bot needs attention: '||NEW.name; detail:='Review the bot log before restarting.';
ELSIF TG_TABLE_NAME='exchange_connections' THEN IF NEW.status NOT IN ('error','expired','disconnected') OR OLD.status=NEW.status THEN RETURN NEW; END IF; heading:='Exchange connection: '||NEW.label; detail:='Connection status: '||NEW.status;
END IF;
INSERT INTO public.notifications(user_id,title,body,kind,event_key) VALUES(NEW.user_id,heading,detail,'trading',TG_TABLE_NAME||':'||NEW.id||':'||coalesce(to_jsonb(NEW)->>'updated_at',to_jsonb(NEW)->>'created_at')) ON CONFLICT DO NOTHING; RETURN NEW; END $$;
