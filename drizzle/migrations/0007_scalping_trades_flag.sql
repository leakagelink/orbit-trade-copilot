ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS is_scalp boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS trades_scalps_idx ON public.trades (user_id, closed_at DESC) WHERE is_scalp;