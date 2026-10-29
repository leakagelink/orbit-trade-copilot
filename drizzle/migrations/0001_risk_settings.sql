CREATE TABLE public.risk_settings (
  user_id uuid PRIMARY KEY,
  max_open_exposure numeric,
  max_daily_loss numeric,
  max_total_positions integer,
  trading_halted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_exposure_pos CHECK (max_open_exposure IS NULL OR max_open_exposure > 0),
  CONSTRAINT risk_loss_pos CHECK (max_daily_loss IS NULL OR max_daily_loss > 0),
  CONSTRAINT risk_positions_range CHECK (max_total_positions IS NULL OR (max_total_positions BETWEEN 1 AND 500))
);
GRANT SELECT, INSERT, UPDATE ON public.risk_settings TO authenticated;
GRANT ALL ON public.risk_settings TO service_role;
ALTER TABLE public.risk_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own risk read" ON public.risk_settings FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own risk insert" ON public.risk_settings FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own risk update" ON public.risk_settings FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);