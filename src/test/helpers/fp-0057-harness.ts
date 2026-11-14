// Test harness for DRAFT 0057 (Phase 4H.7) over drafts 0049–0056 in PGlite — nothing is applied anywhere real and no
// auth user, session, credential or secret is created. auth.users / auth.identities are local stand-ins with the
// hosted column names (read from the live catalog, read-only, on 14 Nov 2026); passwords are fake markers, not hashes.
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { make0055Db } from "./fp-0055-harness";

export const MIG_0057 = readFileSync(process.env["FP_0057_FILE"] ?? "docs/proposed-migrations/0057_worker_credential_pin_and_refusal_tally.sql", "utf8");
export const RB_0057 = readFileSync("docs/proposed-migrations/0057_worker_credential_pin_and_refusal_tally.rollback.sql", "utf8");
export const AUTH_USERS_STANDIN = `
CREATE TABLE auth.users (
  id uuid PRIMARY KEY, aud varchar(255), role varchar(255), email varchar(255), encrypted_password varchar(255),
  email_confirmed_at timestamptz, recovery_sent_at timestamptz, email_change varchar(255) DEFAULT '', email_change_sent_at timestamptz,
  last_sign_in_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  phone text, phone_change text DEFAULT '', phone_change_sent_at timestamptz, banned_until timestamptz, reauthentication_sent_at timestamptz,
  is_sso_user boolean NOT NULL DEFAULT false, deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false);
CREATE TABLE auth.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id text NOT NULL, user_id uuid NOT NULL, identity_data jsonb NOT NULL, provider text NOT NULL,
  last_sign_in_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  email text GENERATED ALWAYS AS (lower(identity_data->>'email')) STORED, UNIQUE (provider_id, provider));`;

/** 0049 → 0056 (+ the auth.users / auth.identities stand-ins) → 0057. */
export async function make0057Db(o: { with0057?: boolean } = {}) {
  const d = await make0055Db({ with0056: true });
  await d.exec(AUTH_USERS_STANDIN);
  if (o.with0057 !== false) await d.exec(MIG_0057);
  return d;
}
type Q = Pick<PGlite, "query">;
export async function addAuthUser(db: Q, uid: string, email: string, password: string) {
  await db.query(`INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data) VALUES ($1, 'authenticated', 'authenticated', $2, $3, now(), '{"provider":"email","providers":["email"]}'::jsonb)`, [uid, email, `fake-hash:${password}`]);
  await db.query(`INSERT INTO auth.identities (provider_id, user_id, identity_data, provider) VALUES ($1::text, $1::uuid, jsonb_build_object('sub', $1::text, 'email', $2::text), 'email')`, [uid, email]);
}
export const changePassword = (db: Q, uid: string, password: string) => db.query(`UPDATE auth.users SET encrypted_password = $2, updated_at = now() WHERE id = $1`, [uid, `fake-hash:${password}`]);
export async function changeEmail(db: Q, uid: string, email: string) {
  await db.query(`UPDATE auth.users SET email = $2, updated_at = now() WHERE id = $1`, [uid, email]);
  await db.query(`UPDATE auth.identities SET identity_data = identity_data || jsonb_build_object('email', $2::text) WHERE user_id = $1 AND provider = 'email'`, [uid, email]);
}
export const requestEmailChange = (db: Q, uid: string, email: string) => db.query(`UPDATE auth.users SET email_change = $2, email_change_sent_at = now() WHERE id = $1`, [uid, email]);
/** What an ordinary password sign-in touches (GoTrue updates sign-in times); NOT part of the fingerprint. */
export async function ordinarySignInTouch(db: Q, uid: string) {
  await db.query(`UPDATE auth.users SET last_sign_in_at = now(), updated_at = now() WHERE id = $1`, [uid]);
  await db.query(`UPDATE auth.identities SET last_sign_in_at = now(), updated_at = now() WHERE user_id = $1`, [uid]);
}
/** The sign-in reply's `user` object as the auth service shapes it (subset), read from the stand-in tables. */
export async function authUserJson(db: Q, uid: string): Promise<Record<string, unknown>> {
  const u = (await db.query<Record<string, unknown>>(`SELECT id::text, email, email_change, email_change_sent_at, phone, banned_until, is_anonymous, is_sso_user, raw_app_meta_data FROM auth.users WHERE id = $1`, [uid])).rows[0]!;
  const ids = (await db.query<{ provider: string }>(`SELECT provider FROM auth.identities WHERE user_id = $1 ORDER BY provider`, [uid])).rows;
  return {
    id: u["id"], email: u["email"], phone: u["phone"] ?? "", is_anonymous: u["is_anonymous"], is_sso_user: u["is_sso_user"], app_metadata: u["raw_app_meta_data"],
    identities: ids.map((i) => ({ provider: i.provider })), ...(u["email_change"] ? { new_email: u["email_change"] } : {}),
    ...(u["email_change_sent_at"] ? { email_change_sent_at: String(u["email_change_sent_at"]) } : {}), ...(u["banned_until"] ? { banned_until: new Date(String(u["banned_until"])).toISOString() } : {}),
  };
}
