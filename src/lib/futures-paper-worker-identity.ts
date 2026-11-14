// Signed-in worker identity for the Futures PAPER worker (Phase 4H finalization, DRAFT 0053 — not applied). Pure and
// browser-safe: it only maps the six hosted-port function names (Phase 4G, `HOSTED_WORKER_RPCS`) to the 0053 wrappers
// that check `auth.uid()` against the worker-identity registry and the owner's per-account enrollment. Nothing in the
// app imports it; there is no route, schedule or background job. It holds no credential and grants no authority.
import { HOSTED_WORKER_RPCS, type HostedRpcName } from "./futures-paper-worker-hosted";

export const WORKER_IDENTITY_ENABLED_BY_DEFAULT = false as const;
export const IDENTITY_RPC: Readonly<Record<HostedRpcName, string>> = Object.freeze({
  fpw_acquire_lease: "fpw_id_acquire_lease",
  fpw_release_lease: "fpw_id_release_lease",
  fpw_snapshot: "fpw_id_snapshot",
  fpw_evaluated: "fpw_id_evaluated",
  fpw_commit: "fpw_id_commit",
  fpw_mark_review: "fpw_id_mark_review",
});
/** The 0053 wrapper for an allowlisted hosted function; anything else is refused. */
export function identityRpcName(fn: string): string {
  if (!(HOSTED_WORKER_RPCS as readonly string[]).includes(fn)) throw new Error("futures paper worker identity: function not allowlisted");
  return IDENTITY_RPC[fn as HostedRpcName];
}
/** Bounded failure codes; messages never carry credentials or provider text. */
export const IDENTITY_CODES = ["IDENTITY_DISABLED", "IDENTITY_NOT_CONFIGURED", "IDENTITY_SIGN_IN_FAILED"] as const;
export class WorkerIdentityError extends Error {
  constructor(readonly code: (typeof IDENTITY_CODES)[number]) { super(`futures paper worker identity: ${code}`); }
}

// ---------- Phase 4H.5: the six envelope wrappers of DRAFT 0055 (not applied) ----------
/** The 0055 wrappers. They record refused calls in the database and answer {"ok":true,"data"} / {"ok":false,"sqlstate","message"}. */
export const IDENTITY_RPC_V2: Readonly<Record<HostedRpcName, string>> = Object.freeze({
  fpw_acquire_lease: "fpw_id2_acquire_lease",
  fpw_release_lease: "fpw_id2_release_lease",
  fpw_snapshot: "fpw_id2_snapshot",
  fpw_evaluated: "fpw_id2_evaluated",
  fpw_commit: "fpw_id2_commit",
  fpw_mark_review: "fpw_id2_mark_review",
});
export function identityRpcNameV2(fn: string): string {
  if (!(HOSTED_WORKER_RPCS as readonly string[]).includes(fn)) throw new Error("futures paper worker identity: function not allowlisted");
  return IDENTITY_RPC_V2[fn as HostedRpcName];
}
const SQLSTATE = /^[0-9A-Z]{5}$/;
/**
 * Maps a 2xx body of a 0055 wrapper back to the reply shape the (locked) hosted classifier already understands:
 * ok → data; refused → error with the original SQLSTATE and message (classified exactly as before 0055). Anything
 * else is answered as an UNKNOWN outcome (status 0): the wrapper may have committed, so it is never treated as
 * "nothing was written".
 */
export function decodeIdentityEnvelope(body: unknown): { data: unknown; error: { code: string | null; message: string | null } | null; status: number } {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (b["ok"] === true && "data" in b) return { data: b["data"] ?? null, error: null, status: 200 };
    if (b["ok"] === false && typeof b["sqlstate"] === "string" && SQLSTATE.test(b["sqlstate"]))
      return { data: null, error: { code: b["sqlstate"], message: typeof b["message"] === "string" ? b["message"] : null }, status: 400 };
  }
  return { data: null, error: { code: null, message: "futures paper worker identity: malformed reply (outcome unknown)" }, status: 0 };
}
