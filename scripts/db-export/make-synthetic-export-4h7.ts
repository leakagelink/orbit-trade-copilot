// Phase 4H.7 — writes the SQL of a SYNTHETIC practice database (stand-ins only; no real data) used to self-test
// verify-local-restore-0057.sh before the owner supplies a fresh export. It is NOT a backup. Output: stdout.
// Contents: API roles, auth stand-ins (uid/jwt, users, identities, sessions, mfa_factors), the app's applied
// user_roles/has_role/workspace_sessions/account_mfa_allowed (0010/0011 text), two example tables with rows, and a
// drizzle history equal to drizzle/migrations (timestamps + SHA-256 of each file). No 0039 objects (reported as FAIL).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AUTH_AND_APP, ROLES } from "../../src/test/helpers/fp-0055-harness";
import { AUTH_USERS_STANDIN } from "../../src/test/helpers/fp-0057-harness";

const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const j = JSON.parse(readFileSync("drizzle/migrations/meta/_journal.json", "utf8")) as { entries: { tag: string; when: number }[] };
const hist = j.entries.map((e) => `(${e.when}, '${createHash("sha256").update(readFileSync(`drizzle/migrations/${e.tag}.sql`)).digest("hex")}')`).join(",\n");
process.stdout.write(`${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
-- 0010 created account_mfa_allowed(); the 0011 text in AUTH_AND_APP replaces it (same order as the applied history).
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
${ROLES}
${AUTH_AND_APP}
${AUTH_USERS_STANDIN}
INSERT INTO public.exchange_connections (user_id, label) VALUES ('00000000-0000-4000-8000-0000000000a1', 'synthetic-1'), ('00000000-0000-4000-8000-0000000000a2', 'synthetic-2');
INSERT INTO public.watchlist_items (user_id, symbol) VALUES ('00000000-0000-4000-8000-0000000000a1', 'BTCUSDT');
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations (created_at, hash) VALUES
${hist};
`);
