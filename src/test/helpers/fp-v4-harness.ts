// Test harness for DRAFT 0051 (event completeness) on top of DRAFTS 0049 + 0050, in PGlite — none is applied anywhere
// real. `commitV4` calls the completeness-checked commit as the function owner (the hosted path reaches it only through
// the 0050 gateway, which is tested separately). Every value is a TEST INPUT, not approved policy.
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { as, M } from "./fp-v3-harness";
import { MIGRATION_0050, makeGatewayDb } from "./fp-gateway-harness";

export const MIGRATION_0051 = readFileSync("docs/proposed-migrations/0051_futures_paper_event_completeness.sql", "utf8");
export const ROLLBACK_0051 = readFileSync("docs/proposed-migrations/0051_futures_paper_event_completeness.rollback.sql", "utf8");
export { MIGRATION_0050 };
/** FP_WITH_0052=1 additionally applies DRAFT 0052 (Phase 4H finalization) and commits through its v5, so every 0051 case is re-run through 0052. */
export const WITH_0052 = process.env["FP_WITH_0052"] === "1";
export async function makeCompletenessDb() {
  const db = await makeGatewayDb(); await db.exec(MIGRATION_0051);
  if (WITH_0052) { await db.exec(`SELECT set_config('futures_paper.change_reason', 'test fixture (PGlite)', false)`); await db.exec(readFileSync("docs/proposed-migrations/0052_futures_paper_entry_completeness_and_exit_only.sql", "utf8")); }
  return db;
}
export async function commitV4(db: PGlite, id: string, seq: number, barT: number, payload: unknown) {
  const fn = WITH_0052 ? "futures_paper_commit_bar_v5" : "futures_paper_commit_bar_v4";
  return Number((await db.query<{ seq: string }>(`SELECT public.${fn}($1, $2, $3, $4::jsonb) AS seq`, [id, seq, barT, JSON.stringify(payload)])).rows[0]!.seq);
}
export const asRole = as;
export const H8 = 8 * 3_600_000;
/** A past 1 m window that contains no funding grid point unless a test puts one there: [grid + 10 min, grid + 7 h). */
export const quietT0 = (now = Date.now()) => Math.floor(now / H8) * H8 - H8 + 10 * M;
/** The most recent past funding grid point that leaves `before` minutes of history before it. */
export const gridAt = (now = Date.now()) => Math.floor(now / H8) * H8 - H8;
