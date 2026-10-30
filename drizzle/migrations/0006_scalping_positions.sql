ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS is_scalp boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_hold_until timestamptz;
CREATE INDEX IF NOT EXISTS positions_open_scalps_idx ON public.positions (user_id) WHERE is_open AND is_scalp;