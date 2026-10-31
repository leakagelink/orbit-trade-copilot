CREATE TABLE public.crypto_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan text NOT NULL CHECK (plan IN ('pro','elite')),
  billing_interval text NOT NULL CHECK (billing_interval IN ('monthly','yearly')),
  amount_usd numeric(12,2) NOT NULL CHECK (amount_usd > 0),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','waiting','confirming','confirmed','sending','partially_paid','finished','failed','refunded','expired')),
  invoice_id text UNIQUE,
  invoice_url text,
  payment_id text UNIQUE,
  pay_currency text,
  actually_paid numeric,
  activated_at timestamptz,
  period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crypto_payments_user_created_idx ON public.crypto_payments(user_id, created_at DESC);
GRANT SELECT ON public.crypto_payments TO authenticated;
GRANT ALL ON public.crypto_payments TO service_role;
ALTER TABLE public.crypto_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own crypto payments read" ON public.crypto_payments FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE TRIGGER trg_crypto_payments_upd BEFORE UPDATE ON public.crypto_payments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Applies a provider-verified payment status. Activates the plan exactly once.
CREATE OR REPLACE FUNCTION public.apply_crypto_payment(_order uuid, _payment_id text, _status text, _pay_currency text, _actually_paid numeric, _price_amount numeric, _price_currency text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p public.crypto_payments%ROWTYPE;
  s public.subscriptions%ROWTYPE;
  base timestamptz;
  new_end timestamptz;
BEGIN
  SELECT * INTO p FROM public.crypto_payments WHERE id = _order FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','unknown_order'); END IF;
  IF p.payment_id IS NOT NULL AND p.payment_id <> _payment_id THEN RETURN jsonb_build_object('result','payment_mismatch'); END IF;
  IF p.activated_at IS NOT NULL THEN RETURN jsonb_build_object('result','already_active'); END IF;
  IF _status NOT IN ('waiting','confirming','confirmed','sending','partially_paid','finished','failed','refunded','expired') THEN RETURN jsonb_build_object('result','ignored'); END IF;

  UPDATE public.crypto_payments SET payment_id = _payment_id, status = _status, pay_currency = _pay_currency, actually_paid = _actually_paid WHERE id = p.id;

  IF _status NOT IN ('confirmed','sending','finished') THEN RETURN jsonb_build_object('result','recorded'); END IF;
  IF lower(coalesce(_price_currency,'')) <> 'usd' OR coalesce(_price_amount,0) + 0.009 < p.amount_usd THEN
    RETURN jsonb_build_object('result','amount_mismatch');
  END IF;

  SELECT * INTO s FROM public.subscriptions WHERE user_id = p.user_id FOR UPDATE;
  base := now();
  IF FOUND AND s.plan = p.plan AND s.status IN ('active','trialing') AND s.current_period_end IS NOT NULL AND s.current_period_end > now() THEN
    base := s.current_period_end;
  END IF;
  new_end := base + CASE WHEN p.billing_interval = 'yearly' THEN interval '1 year' ELSE interval '1 month' END;

  INSERT INTO public.subscriptions (user_id, plan, status, billing_interval, provider, provider_ref, current_period_end, cancel_at_period_end, environment)
  VALUES (p.user_id, p.plan, 'active', p.billing_interval, 'nowpayments', _payment_id, new_end, true, 'live')
  ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, status = 'active', billing_interval = EXCLUDED.billing_interval, provider = 'nowpayments', provider_ref = EXCLUDED.provider_ref, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = true, environment = 'live';

  UPDATE public.crypto_payments SET activated_at = now(), period_end = new_end WHERE id = p.id;
  INSERT INTO public.notifications (user_id, title, body, kind)
  VALUES (p.user_id, initcap(p.plan) || ' plan active', 'Your crypto payment was confirmed. Access runs until ' || to_char(new_end AT TIME ZONE 'UTC', 'DD Mon YYYY') || ' (UTC).', 'system');
  RETURN jsonb_build_object('result','activated','period_end',new_end);
END $$;
REVOKE EXECUTE ON FUNCTION public.apply_crypto_payment(uuid, text, text, text, numeric, numeric, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_crypto_payment(uuid, text, text, text, numeric, numeric, text) TO service_role;