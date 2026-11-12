-- PROPOSED — NOT APPLIED. Apply only after owner approval and a verified export of the current database, byte-for-byte.
-- 0041: append-only Phase 1.6 harness evidence. Testnet connections only; backend writes; owners read their own rows.
-- Evidence here never authorizes production trading and is separate from public.futures_certifications.
CREATE TABLE public.futures_harness_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  scenario text NOT NULL CHECK (scenario IN ('partial_fill','protection_rejection','unknown_submission','isolated_kill_switch','concurrent_requests','crash_restart','funding_reconciliation','final_broker_state')),
  status text NOT NULL CHECK (status IN ('pass','fail','blocked')),
  provenance text[] NOT NULL DEFAULT '{}',
  revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 80),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX futures_harness_runs_owner_idx ON public.futures_harness_runs (user_id, created_at DESC);
REVOKE ALL ON public.futures_harness_runs FROM anon, authenticated;
GRANT SELECT ON public.futures_harness_runs TO authenticated;
GRANT ALL ON public.futures_harness_runs TO service_role;
ALTER TABLE public.futures_harness_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners read their harness evidence" ON public.futures_harness_runs
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.validate_futures_harness_run()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.exchange_connections WHERE id = NEW.connection_id AND user_id = NEW.user_id AND exchange = 'binance' AND is_testnet) THEN
  RAISE EXCEPTION 'Harness evidence must come from the owner''s Binance Testnet account';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER futures_harness_run_binding BEFORE INSERT ON public.futures_harness_runs
  FOR EACH ROW EXECUTE FUNCTION public.validate_futures_harness_run();
CREATE TRIGGER futures_harness_runs_immutable BEFORE UPDATE OR DELETE ON public.futures_harness_runs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_evaluation_mutation();
CREATE TRIGGER futures_harness_runs_no_truncate BEFORE TRUNCATE ON public.futures_harness_runs
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_evaluation_mutation();
