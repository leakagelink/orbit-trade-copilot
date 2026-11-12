// Atomic research budget reservations and single-worker ownership (draft migration 0043, section 6).
// Every AI call reserves its projected tokens in the database first; the database checks per-run, per-user daily,
// per-user monthly and platform monthly caps under one platform-wide lock, refuses calls for cancelled, closed or
// foreign-worker runs, and records reserved / consumed / released usage separately. Until 0043 is applied the functions
// do not exist: the run then uses the in-memory meter only ("pending_migration"), which is not atomic across runs.
// Any other database error is treated as "cannot verify" and stops further AI calls (fail closed).
type Err = { code?: string; message?: string } | null;
export interface LedgerDb { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: Err }> }
export const ledgerDb = (db: unknown) => db as LedgerDb;

export const functionMissing = (e: Err) => !!e && (e.code === "PGRST202" || e.code === "42883" || /could not find the function|function .* does not exist/i.test(e.message ?? ""));

export type LedgerMode = "atomic" | "pending_migration";
export type WorkerClaim = { mode: LedgerMode } | { mode: "refused" };

/** Raised when the ledger cannot be reached or answers unexpectedly; the caller must make no further AI calls. */
export class LedgerUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "LedgerUnavailable"; }
}

export async function claimResearchWorker(db: LedgerDb, runId: string, userId: string, workerId: string): Promise<WorkerClaim> {
  const r = await db.rpc("claim_ai_research_worker", { _run: runId, _user: userId, _worker: workerId });
  if (functionMissing(r.error)) return { mode: "pending_migration" };
  if (r.error) throw new LedgerUnavailable("Research run ownership could not be verified; no AI calls were made");
  return r.data === true ? { mode: "atomic" } : { mode: "refused" };
}

export type Reservation = { ok: true; id: string } | { ok: false; stoppedBy: string; reason: string };
export async function reserveResearchBudget(db: LedgerDb, a: { runId: string; userId: string; workerId: string; agent: string; kind: "call" | "repair"; tokens: number }): Promise<Reservation> {
  const r = await db.rpc("reserve_ai_research_budget", { _run: a.runId, _user: a.userId, _worker: a.workerId, _agent: a.agent, _kind: a.kind, _tokens: Math.ceil(a.tokens) });
  if (r.error || !r.data || typeof r.data !== "object") throw new LedgerUnavailable("Research spending limits could not be reserved; no further AI calls were made");
  const d = r.data as { ok?: unknown; reservation_id?: unknown; stopped_by?: unknown; reason?: unknown };
  if (d.ok === true && typeof d.reservation_id === "string") return { ok: true, id: d.reservation_id };
  if (d.ok === false && typeof d.stopped_by === "string") return { ok: false, stoppedBy: d.stopped_by, reason: typeof d.reason === "string" ? d.reason : "A research limit was reached. No further AI calls were made." };
  throw new LedgerUnavailable("Research spending limits answered unexpectedly; no further AI calls were made");
}

/** Records what a call actually used. `consumedTokens` null = provider reported nothing, so the reservation counts in full. */
export async function settleResearchBudget(db: LedgerDb, a: { reservationIds: string[]; workerId: string; consumedTokens: number | null; costUsd: number | null }) {
  const r = await db.rpc("settle_ai_research_budget", { _reservations: a.reservationIds, _worker: a.workerId, _consumed_tokens: a.consumedTokens === null ? null : Math.max(0, Math.round(a.consumedTokens)), _cost_usd: a.costUsd });
  return !r.error;
}

/** For a reservation whose call was never sent. */
export async function releaseResearchBudget(db: LedgerDb, a: { reservationId: string; workerId: string }) {
  const r = await db.rpc("release_ai_research_budget", { _reservation: a.reservationId, _worker: a.workerId });
  return !r.error;
}

/** Ledger refusals that stop the whole run (everything except a refused format correction). */
export const runStoppingRefusal = (stoppedBy: string) => stoppedBy !== "max_repairs";
