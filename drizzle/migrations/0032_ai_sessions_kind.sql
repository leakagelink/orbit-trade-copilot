ALTER TABLE public.ai_sessions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'assistant';
ALTER TABLE public.ai_sessions DROP CONSTRAINT IF EXISTS ai_sessions_kind_check;
ALTER TABLE public.ai_sessions ADD CONSTRAINT ai_sessions_kind_check CHECK (kind IN ('assistant','autopilot'));
CREATE INDEX IF NOT EXISTS ai_sessions_user_kind_idx ON public.ai_sessions (user_id, kind, updated_at DESC);