// Minimal stand-in for the hosted research schema (as of 12 Nov 2026) used to run draft migration 0043 in PGlite and in
// a throwaway multi-session PostgreSQL. Mirrors the hosted default grants (browser roles hold full table privileges,
// RLS with owner-read policies protects rows). Not used against any real database.
export const RESEARCH_IDS = {
  A: "00000000-0000-4000-8000-00000000000a", B: "00000000-0000-4000-8000-00000000000b", ADMIN: "00000000-0000-4000-8000-0000000000ad",
  RA: "00000000-0000-4000-8000-0000000000a1", RB: "00000000-0000-4000-8000-0000000000b1",
} as const;
const { A, B, ADMIN, RA, RB } = RESEARCH_IDS;
export const RESEARCH_DB_STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; -- as on the hosted database
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $$;
CREATE TABLE public.ai_research_runs (id uuid PRIMARY KEY, user_id uuid NOT NULL, symbol text NOT NULL, status text NOT NULL DEFAULT 'running' CONSTRAINT ai_research_runs_status_check CHECK (status IN ('running','completed','partial','failed')), error text, snapshot jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
CREATE TABLE public.ai_agent_outputs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, user_id uuid, agent text, status text, report jsonb);
CREATE TABLE public.ai_research_reports (LIKE public.ai_agent_outputs INCLUDING DEFAULTS);
CREATE TABLE public.ai_research_decisions (LIKE public.ai_agent_outputs INCLUDING DEFAULTS);
CREATE TABLE public.ai_trade_proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, user_id uuid, proposal jsonb);
CREATE TABLE public.ai_research_usage (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, user_id uuid, agent text, input_tokens int, output_tokens int, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action text NOT NULL, entity_type text, entity_id uuid, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.ai_research_stage_metrics (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, user_id uuid, agent text);
-- Mirrors the hosted database: default grants give browser roles full table privileges and RLS (owner-read only) protects rows.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role, authenticated, anon;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['ai_research_runs','ai_agent_outputs','ai_research_reports','ai_research_decisions','ai_trade_proposals','ai_research_usage','ai_research_stage_metrics'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY owner_read ON public.%I FOR SELECT TO authenticated USING (user_id = auth.uid())', t);
END LOOP; END $$;
INSERT INTO public.user_roles VALUES ('${ADMIN}', 'admin');
INSERT INTO public.ai_research_runs VALUES ('${RA}', '${A}', 'AAPL'), ('${RB}', '${B}', 'BTC-USD');
INSERT INTO public.ai_agent_outputs(run_id,user_id,agent,status,report) VALUES ('${RA}','${A}','market','completed','{}');
INSERT INTO public.ai_research_usage(run_id,user_id,agent,input_tokens,output_tokens) VALUES ('${RA}','${A}','market',1,1);
`;
