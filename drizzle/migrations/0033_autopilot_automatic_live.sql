CREATE TABLE public.autopilot_settings (
  user_id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  live_enabled boolean NOT NULL DEFAULT false,
  live_confirmed_at timestamptz,
  binance_connection_id uuid,
  deriv_connection_id uuid,
  interval_minutes integer NOT NULL DEFAULT 60 CHECK (interval_minutes IN (15, 30, 60, 240)),
  goal text NOT NULL DEFAULT '' CHECK (char_length(goal) <= 1000),
  next_run_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.autopilot_settings TO authenticated;
GRANT ALL ON public.autopilot_settings TO service_role;
ALTER TABLE public.autopilot_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners read autopilot settings" ON public.autopilot_settings FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.autopilot_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'waiting_model' CHECK (status IN ('waiting_model', 'executing', 'done', 'failed', 'stopped')),
  live boolean NOT NULL DEFAULT false,
  step integer NOT NULL DEFAULT 0,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  batch_id text,
  lease_until timestamptz,
  budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
GRANT SELECT ON public.autopilot_runs TO authenticated;
GRANT ALL ON public.autopilot_runs TO service_role;
ALTER TABLE public.autopilot_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners read autopilot runs" ON public.autopilot_runs FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE UNIQUE INDEX autopilot_runs_one_active ON public.autopilot_runs (user_id) WHERE status IN ('waiting_model', 'executing');
CREATE INDEX autopilot_runs_user_created ON public.autopilot_runs (user_id, created_at DESC);
CREATE INDEX autopilot_runs_active ON public.autopilot_runs (status, updated_at) WHERE status IN ('waiting_model', 'executing');