// Phase 4H.7 — bounded, resumable invocation plan for the signed-in paper worker under the MEASURED 5,000 ms limit of
// the existing scheduled HTTP calls (docs/phase-4h6/live-service-checks.md LS21). Pure and browser-safe: no imports,
// network, environment, database client or logging. Nothing in the app calls it; the only caller is the disabled
// signed-in binding. It grants no authority and changes no S1–S8 / T1–T11 value: every limit is passed explicitly.
//
// Model. One invocation = ONE bounded session (sign in → calls → sign out) for ONE account, chosen deterministically from
// the time slot. Progress lives only in the database: each candle commits in its own one-request transaction
// (compare-and-set on the ledger sequence; an identical replay returns the committed sequence), the per-account lease
// row (fence + TTL) serializes workers, and nothing is carried in memory from one invocation to the next. A timed-out,
// killed or overlapping invocation therefore resumes from the committed cursor on the next one: an uncommitted candle
// is simply recomputed, a committed one is never repeated, and a stale fence or sequence is refused by the database.
// No database transaction ever spans two requests, let alone two invocations.
//
// Completion. Only CAUGHT_UP is a completed invocation: the session completed, nothing was uncertain, and the account
// is waiting for the next candle (or is stopped and flat). Commits made before a budget stop are durable PROGRESS, but
// never "completed"; anything uncertain is INCOMPLETE and is resolved by reloading on the next invocation.

/** Measured: 7 of 1,080 scheduled calls timed out at exactly 5,000 ms (pg_net). */
export const MEASURED_SCHEDULER_LIMIT_MS = 5_000;

export interface InvocationLimits {
  /** Whole session, sign-in to sign-out acknowledgement. */
  budgetMs: number;
  /** Kept free for platform start-up, scheduler network and the response; budget + margin must fit the scheduler limit. */
  safetyMarginMs: number;
  authTimeoutMs: number; rpcTimeoutMs: number; signOutTimeoutMs: number;
  marketTimeoutMs: number; intentsTimeoutMs: number;
  /** Lease TTL: must outlive one invocation and expire before the next slot, so a dead invocation never blocks two. */
  leaseTtlSeconds: number;
  scheduleIntervalMs: number;
  /** Upper bound of candles per invocation; the budget usually stops earlier. */
  maxCandles: number;
}
/** Engineering PROPOSAL (NOT APPROVED; register I1–I10 in docs/phase-4h7/owner-decisions-required.md). */
export const PROPOSED_INVOCATION_LIMITS: Readonly<InvocationLimits> = Object.freeze({
  budgetMs: 3_600, safetyMarginMs: 1_200, authTimeoutMs: 600, rpcTimeoutMs: 450, signOutTimeoutMs: 400,
  marketTimeoutMs: 600, intentsTimeoutMs: 200, leaseTtlSeconds: 15, scheduleIntervalMs: 60_000, maxCandles: 6,
});

export interface FitReport {
  /** auth + acquire + snapshot + market + intents + evaluated + commit + sign-out, every call at its own limit. */
  worstEntryStepMs: number;
  /** auth + acquire + snapshot + market + commit + sign-out (no intents). */
  worstExitStepMs: number;
  /** One more candle in the same invocation: snapshot + market + intents + evaluated + commit. */
  worstExtraCandleMs: number;
  schedulerLimitMs: number; headroomMs: number;
}
export type LimitsCheck = { ok: true; limits: Readonly<InvocationLimits>; fit: FitReport } | { ok: false; code: string };

const posInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
/** Refuses any profile that cannot finish inside the scheduler limit, or under which one full step could not fit. */
export function validateInvocationLimits(l: InvocationLimits, schedulerLimitMs: number = MEASURED_SCHEDULER_LIMIT_MS): LimitsCheck {
  if (!l || typeof l !== "object") return { ok: false, code: "LIMITS_MISSING" };
  const keys: (keyof InvocationLimits)[] = ["budgetMs", "safetyMarginMs", "authTimeoutMs", "rpcTimeoutMs", "signOutTimeoutMs", "marketTimeoutMs", "intentsTimeoutMs", "leaseTtlSeconds", "scheduleIntervalMs", "maxCandles"];
  for (const k of keys) if (!posInt(l[k])) return { ok: false, code: `NOT_POSITIVE_${k.toUpperCase()}` };
  if (!posInt(schedulerLimitMs)) return { ok: false, code: "SCHEDULER_LIMIT_INVALID" };
  if (l.budgetMs + l.safetyMarginMs > schedulerLimitMs) return { ok: false, code: "EXCEEDS_SCHEDULER_LIMIT" };
  const fit: FitReport = {
    worstEntryStepMs: l.authTimeoutMs + 4 * l.rpcTimeoutMs + l.marketTimeoutMs + l.intentsTimeoutMs + l.signOutTimeoutMs,
    worstExitStepMs: l.authTimeoutMs + 3 * l.rpcTimeoutMs + l.marketTimeoutMs + l.signOutTimeoutMs,
    worstExtraCandleMs: 3 * l.rpcTimeoutMs + l.marketTimeoutMs + l.intentsTimeoutMs,
    schedulerLimitMs, headroomMs: schedulerLimitMs - l.budgetMs - l.safetyMarginMs,
  };
  // If every call meets its own limit, one complete candle (entries included) must always fit: no invocation can make
  // zero progress merely because of the budget.
  if (fit.worstEntryStepMs > l.budgetMs) return { ok: false, code: "STEP_DOES_NOT_FIT_BUDGET" };
  if (l.leaseTtlSeconds < 10 || l.leaseTtlSeconds > 300) return { ok: false, code: "LEASE_TTL_OUT_OF_RANGE" };   // the database accepts 10..300 s
  if (l.leaseTtlSeconds * 1000 <= l.budgetMs) return { ok: false, code: "LEASE_SHORTER_THAN_INVOCATION" };
  if (l.leaseTtlSeconds * 1000 >= l.scheduleIntervalMs) return { ok: false, code: "LEASE_OUTLIVES_SLOT" };
  if (l.maxCandles > 60) return { ok: false, code: "MAX_CANDLES_TOO_HIGH" };
  return { ok: true, limits: Object.freeze({ ...l }), fit };
}

/** Deterministic account for a time slot: overlapping invocations of one slot pick the same account (the lease decides). */
export function pickAccount(accounts: readonly string[], nowMs: number, intervalMs: number): string | null {
  const list = [...new Set(accounts.filter((a) => typeof a === "string" && a.length > 0))].sort();
  if (!list.length || !Number.isFinite(nowMs) || !posInt(intervalMs)) return null;
  const slot = Math.floor(nowMs / intervalMs);
  return list[((slot % list.length) + list.length) % list.length]!;
}

/** A bounded port call was not started (budget) or was cancelled (timeout / caller); its late result is never used. */
export class InvocationRefusal extends Error {
  constructor(readonly code: "BUDGET" | "TIMEOUT" | "CANCELLED" | "TIMER") { super(`worker invocation: ${code}`); }
}
type Timers = { setTimeout: (f: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
const platformTimers: Timers = { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>) };
/**
 * Runs `f` only if it can finish (timeoutMs) before `deadlineAt`; arms its timer BEFORE `f` starts (a timer fault refuses
 * with nothing started); passes one signal combining its own limit and `parent`; ignores a late result.
 */
export async function boundedCall<T>(f: (signal: AbortSignal) => Promise<T>, o: { timeoutMs: number; deadlineAt: number; now(): number; parent?: AbortSignal; timers?: Timers }): Promise<T> {
  const timers = o.timers ?? platformTimers;
  if (o.parent?.aborted) throw new InvocationRefusal("CANCELLED");
  if (!(o.now() + o.timeoutMs <= o.deadlineAt)) throw new InvocationRefusal("BUDGET");
  const ctl = new AbortController();
  let why: "TIMEOUT" | "CANCELLED" | null = null, done: (v: { stop: true }) => void = () => {};
  const stopped = new Promise<{ stop: true }>((r) => { done = r; });
  const stop = (w: "TIMEOUT" | "CANCELLED") => () => { if (why === null) { why = w; try { ctl.abort(); } catch { /* */ } done({ stop: true }); } };
  let h: unknown;
  try { h = timers.setTimeout(stop("TIMEOUT"), Math.max(1, o.timeoutMs)); } catch { throw new InvocationRefusal("TIMER"); }
  const onParent = stop("CANCELLED");
  o.parent?.addEventListener?.("abort", onParent, { once: true });
  try {
    let p: Promise<T>;
    try { p = Promise.resolve(f(ctl.signal)); } catch (e) { p = Promise.reject(e); }
    p.then(undefined, () => undefined); // a late failure after cancellation is ignored
    const r = await Promise.race([p.then((v) => ({ v })), stopped]);
    if ("stop" in r) throw new InvocationRefusal(why ?? "TIMEOUT");
    return r.v;
  } finally {
    try { timers.clearTimeout(h); } catch { /* */ }
    try { o.parent?.removeEventListener?.("abort", onParent); } catch { /* */ }
  }
}

// ---------- classification: what an invocation proves ----------
export type InvocationStatus = "CAUGHT_UP" | "PROGRESS" | "INCOMPLETE" | "SKIPPED_BUSY" | "HALTED" | "SESSION_FAILED" | "DISABLED" | "CONFIG_INVALID" | "NO_ACCOUNT";
export interface InvocationClassification { status: InvocationStatus; completed: boolean; committed: number; reasons: string[] }
/** Loose shapes so this module needs no imports: the session result and the hosted tick summary. */
export interface ClassifyInput {
  session: { outcome: string; signOut?: string } | null;
  summary?: { status: string; committed: number; halted: readonly string[]; metrics: readonly { code: string }[]; hosted?: readonly { code: string }[] } | null;
}
const UNCERTAIN_HOSTED = new Set(["RPC_TIMEOUT", "RPC_NO_RESPONSE", "TICK_ABORTED", "LEASE_LOST", "RPC_TRANSIENT", "RPC_SCHEMA_UNAVAILABLE", "RPC_MALFORMED_REPLY", "PROVENANCE_MISSING", "PROVENANCE_INVALID", "SNAPSHOT_EMPTY", "SNAPSHOT_MISMATCH", "CROSS_ACCOUNT_REFUSED"]);
const UNCERTAIN_WORKER = new Set(["UNKNOWN_OUTCOME", "LOAD_FAILED", "DATA_UNAVAILABLE", "DATA_INVALID", "TRANSIENT_DB_ERROR", "RELOAD_LIMIT", "RECOMPUTE_LIMIT", "ENGINE_DATA_ERROR", "LEDGER_STATE_MISMATCH", "CATCH_UP_LIMIT", "LOST_RESPONSE_RESENT"]);
const SESSION_BEFORE_BODY = new Set(["CONFIG_INVALID", "AUTH_INVALID_CREDENTIALS", "AUTH_RATE_LIMITED", "AUTH_UNAVAILABLE", "AUTH_TIMEOUT", "AUTH_MALFORMED_REPLY", "TOKEN_NOT_WORKER_ROLE", "TOKEN_WRONG_IDENTITY", "TOKEN_EXPIRED", "TOKEN_LIFETIME_TOO_SHORT", "CLOCK_SKEW", "TOKEN_STALE", "TOKEN_USER_REFUSED"]);
/** Strict: CAUGHT_UP is the only `completed: true` result; partial state is never reported as a completed tick. */
export function classifyInvocation(x: ClassifyInput): InvocationClassification {
  const s = x.session, sum = x.summary ?? null;
  if (!s) return { status: "SESSION_FAILED", completed: false, committed: 0, reasons: ["NO_SESSION_RESULT"] };
  if (!sum) {
    const before = SESSION_BEFORE_BODY.has(s.outcome);
    return { status: before ? "SESSION_FAILED" : "INCOMPLETE", completed: false, committed: 0, reasons: [s.outcome] };
  }
  if (sum.status === "disabled") return { status: "DISABLED", completed: false, committed: 0, reasons: ["DISABLED"] };
  const committed = Number.isSafeInteger(sum.committed) && sum.committed > 0 ? sum.committed : 0;
  const codes = sum.metrics.map((m) => m.code), hosted = (sum.hosted ?? []).map((m) => m.code);
  const reasons = [...new Set([...hosted.filter((c) => UNCERTAIN_HOSTED.has(c)), ...codes.filter((c) => UNCERTAIN_WORKER.has(c))])];
  if (s.outcome !== "TICK_COMPLETED") reasons.unshift(s.outcome);
  if (sum.halted.length) return { status: "HALTED", completed: false, committed, reasons: ["HALT_FOR_REVIEW", ...reasons] };
  const last = codes.at(-1);
  // Busy only when the database answered "another holder's lease is valid" (a failed acquire also reports LEASE_BUSY to the core).
  if (committed === 0 && codes.length > 0 && codes.every((c) => c === "LEASE_BUSY") && hosted.includes("LEASE_BUSY") && reasons.length === 0) return { status: "SKIPPED_BUSY", completed: false, committed: 0, reasons: ["LEASE_BUSY"] };
  const caughtUp = last === "WAIT_CANDLE_NOT_CLOSED" || last === "ACCOUNT_STOPPED";
  if (caughtUp && reasons.length === 0) return { status: "CAUGHT_UP", completed: true, committed, reasons: [] };
  if (committed > 0) return { status: "PROGRESS", completed: false, committed, reasons: reasons.length ? reasons : ["NOT_CAUGHT_UP"] };
  return { status: "INCOMPLETE", completed: false, committed: 0, reasons: reasons.length ? reasons : ["NO_COMMIT"] };
}

// ---------- server-side sign-in user check (early stop; draft 0057 is the authoritative database check) ----------
/**
 * Accepts only an unchanged, email-only worker account: same email as configured, no pending email change, no phone,
 * provider and every linked identity "email", not banned, not anonymous, not SSO. Returns a bounded code or null.
 * A changed password cannot be seen here: the worker's own sign-in then fails, and the database refuses old tokens.
 */
export function workerUserCheck(expectedEmail: string, nowMs: () => number = () => Date.now()): (u: Readonly<Record<string, unknown>>) => string | null {
  const want = String(expectedEmail ?? "").trim().toLowerCase();
  return (u) => {
    if (!want) return "CHECK_NOT_CONFIGURED";
    const email = typeof u["email"] === "string" ? u["email"].trim().toLowerCase() : null;
    if (email !== want) return "EMAIL_CHANGED";
    const pend = u["new_email"] ?? u["email_change"];
    if (typeof pend === "string" && pend.length > 0) return "EMAIL_CHANGE_PENDING";
    if (u["email_change_sent_at"] != null && u["email_change_sent_at"] !== "") return "EMAIL_CHANGE_PENDING";
    const phone = u["phone"], newPhone = u["new_phone"];
    if ((typeof phone === "string" && phone.length > 0) || (typeof newPhone === "string" && newPhone.length > 0)) return "PHONE_LINKED";
    if (u["is_anonymous"] === true || u["is_sso_user"] === true) return "NOT_EMAIL_ACCOUNT";
    const meta = u["app_metadata"];
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return "PROVIDER_UNKNOWN";
    const m = meta as Record<string, unknown>, providers = m["providers"];
    if (m["provider"] !== "email" || !Array.isArray(providers) || providers.length !== 1 || providers[0] !== "email") return "PROVIDER_CHANGED";
    const ids = u["identities"];
    if (ids !== undefined && ids !== null) {
      if (!Array.isArray(ids)) return "IDENTITY_UNKNOWN";
      for (const i of ids) if (!i || typeof i !== "object" || (i as Record<string, unknown>)["provider"] !== "email") return "IDENTITY_LINKED";
    }
    const banned = u["banned_until"];
    if (typeof banned === "string" && banned.length > 0) { const t = Date.parse(banned); if (!Number.isFinite(t) || t > nowMs()) return "BANNED"; }
    return null;
  };
}
