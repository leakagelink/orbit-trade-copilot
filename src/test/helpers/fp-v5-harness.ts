// Test harness for DRAFT 0052 (entry-fill completeness, stopped-account exit-only, configuration audit trail) on top of
// DRAFTS 0049 + 0050 + 0051, in PGlite — none is applied anywhere real. `commitV5` calls the entry-completeness-checked
// commit as the function owner (the hosted path reaches it only through the gateway). Every value is a TEST INPUT.
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { as, makeDb } from "./fp-v3-harness";
import { MIGRATION_0050 } from "./fp-gateway-harness";
import { MIGRATION_0051 } from "./fp-v4-harness";

export const MIGRATION_0052 = readFileSync("docs/proposed-migrations/0052_futures_paper_entry_completeness_and_exit_only.sql", "utf8");
export const ROLLBACK_0052 = readFileSync("docs/proposed-migrations/0052_futures_paper_entry_completeness_and_exit_only.rollback.sql", "utf8");
export const TEST_REASON = "test fixture (PGlite)";
/** 0049 → 0050 → 0051 → 0052. Configuration writes need a reason under 0052; the session supplies a test one. */
export async function makeEntryDb() {
  const db = await makeDb(); await db.exec(MIGRATION_0050); await db.exec(MIGRATION_0051);
  await db.exec(`SELECT set_config('futures_paper.change_reason', '${TEST_REASON}', false)`);
  await db.exec(MIGRATION_0052);
  return db;
}
export async function commitV5(db: PGlite, id: string, seq: number, barT: number, payload: unknown) {
  return Number((await db.query<{ seq: string }>(`SELECT public.futures_paper_commit_bar_v5($1, $2, $3, $4::jsonb) AS seq`, [id, seq, barT, JSON.stringify(payload)])).rows[0]!.seq);
}
/** Owner/operator status change as service_role (audited by 0050 and 0052). */
export async function setStatus(db: PGlite, id: string, o: { status?: "active" | "paused" | "stopped"; halted?: boolean; reason: string }) {
  const sets = [o.status ? `status = '${o.status}'` : null, o.halted === undefined ? null : `halted = ${o.halted}`, `status_reason = $2`].filter(Boolean).join(", ");
  return as(db, "service_role", `UPDATE public.futures_paper_accounts SET ${sets} WHERE id = $1`, [id, o.reason]);
}
