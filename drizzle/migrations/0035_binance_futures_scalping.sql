ALTER TABLE public.orders ADD COLUMN market_type text NOT NULL DEFAULT 'spot' CHECK(market_type IN ('spot','usd_m_futures'));
ALTER TABLE public.positions ADD COLUMN market_type text NOT NULL DEFAULT 'spot' CHECK(market_type IN ('spot','usd_m_futures'));
ALTER TABLE public.positions ADD COLUMN futures_details jsonb;
ALTER TABLE public.trades ADD COLUMN market_type text NOT NULL DEFAULT 'spot' CHECK(market_type IN ('spot','usd_m_futures'));
ALTER TABLE public.trades ADD COLUMN funding_pnl numeric;
ALTER TABLE public.trades ADD COLUMN costs_verified boolean NOT NULL DEFAULT true;
CREATE TABLE public.futures_settings (
 user_id uuid PRIMARY KEY, connection_id uuid, live_enabled boolean NOT NULL DEFAULT false,
 max_margin numeric CHECK(max_margin>0), max_leverage integer CHECK(max_leverage BETWEEN 1 AND 20), max_loss numeric CHECK(max_loss>0),
 testnet_certified_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.futures_settings TO authenticated;
GRANT ALL ON public.futures_settings TO service_role;
ALTER TABLE public.futures_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_settings_owner_read ON public.futures_settings FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE TABLE public.futures_verifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, connection_id uuid NOT NULL,
 read_access boolean NOT NULL, can_trade boolean NOT NULL DEFAULT false, hedge_mode boolean, is_testnet boolean NOT NULL,
 details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.futures_verifications TO authenticated;
GRANT ALL ON public.futures_verifications TO service_role;
ALTER TABLE public.futures_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_verifications_owner_read ON public.futures_verifications FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE TRIGGER futures_verifications_immutable BEFORE UPDATE OR DELETE ON public.futures_verifications FOR EACH ROW EXECUTE FUNCTION public.prevent_evaluation_mutation();
COMMENT ON COLUMN public.futures_settings.testnet_certified_at IS 'Service-only operator attestation after a complete observed testnet entry/protection/close/recovery lifecycle; UI and AI cannot self-certify.';
CREATE UNIQUE INDEX futures_one_active_symbol ON public.positions(exchange_connection_id,trading_pair) WHERE is_open AND market_type='usd_m_futures';
-- Prevent Spot consumers from silently interpreting Futures records: server code must dispatch by market_type.
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
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_futures_live_intent() FROM PUBLIC;
CREATE TRIGGER futures_live_intent_gate BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.guard_futures_live_intent();