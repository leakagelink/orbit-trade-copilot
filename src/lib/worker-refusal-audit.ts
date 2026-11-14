// Phase 4H.7 — refusal audit completeness for the signed-in paper worker. Pure and browser-safe: no imports, network,
// environment, database client or logging. It (1) turns the worker's own bounded metrics into an invocation journal,
// (2) states for every refusal WHERE it can be recorded, and (3) reconciles that journal with the database refusal rows
// and the draft-0057 refusal tally, reporting gaps. It never claims that the database recorded a request that did not
// reach database code.
//
// Recording categories (docs/phase-4h7/audit-integrity-report.md):
//   A  DATABASE — refused inside one of the six worker envelopes (raise / data / integrity class): the envelope commits a
//      refusal row; above the per-identity cap the draft-0057 tally counts it as dropped instead (a counter, not a row).
//   B  PLATFORM LOGS ONLY — refused or lost before or outside database code: data-API request hook (42501), privilege
//      errors, rejected tokens (PGRST30x), statement timeouts (57014, the whole transaction aborts), lost replies,
//      calls cancelled by the worker's own limits, and calls the worker refused to send. Evidence is this journal (emitted
//      by the caller's logger) and the platform's request logs; their retention is NOT verified.
//   C  NOT DURABLY RECORDABLE — the worker process ended before its journal line was written AND the request never reached
//      the platform; or a platform log expired; or the database owner removed rows (detectable via the tally and
//      external checkpoints, not recoverable from the database).

export type CallKind =
  | "REFUSED_IN_DB"        // A
  | "REFUSED_AT_BOUNDARY"  // B: request hook / privileges (42501, PGRST202)
  | "TOKEN_REJECTED"       // B: data API refused the token (401 / PGRST30x)
  | "TIMED_OUT"            // B: the worker's own limit cancelled the call; the database may or may not have run it
  | "DB_TIMEOUT"           // B: statement / lock timeout or other aborted transaction — no database record by design
  | "OUTCOME_UNKNOWN"      // B: no reply (network, gateway 5xx)
  | "NOT_SENT";            // B: refused locally before anything was sent (budget, closed session, in-flight cap)
export type Category = "A" | "B" | "C";
export const CATEGORY_OF: Readonly<Record<CallKind, Category>> = Object.freeze({
  REFUSED_IN_DB: "A", REFUSED_AT_BOUNDARY: "B", TOKEN_REJECTED: "B", TIMED_OUT: "B", DB_TIMEOUT: "B", OUTCOME_UNKNOWN: "B", NOT_SENT: "B",
});

export interface JournalEvent {
  invocationId: string; seq: number; at: number;
  type: "INVOCATION_START" | "CALL" | "INVOCATION_END";
  fn?: string | null; kind?: CallKind; pgCode?: string | null; category?: Category; status?: string;
}
const FN = /^[a-z_]{1,40}$/, PG = /^([0-9A-Z]{5}|PGRST\d{3})$/;
const fnName = (fn: unknown): string | null => {
  if (typeof fn !== "string") return null;
  const f = fn.replace(/^f[p]w(?:_id2?)?_/, ""); // database wrapper prefix removed; the logical operation name stays
  return FN.test(f) ? f : null;
};
/** Maps one hosted-adapter metric (bounded codes only) to the call kind it proves; null when it is not a refusal. */
export function kindOfHostedMetric(m: { code: string; pgCode?: string | null }): CallKind | null {
  const pg = typeof m.pgCode === "string" && PG.test(m.pgCode) ? m.pgCode : null;
  switch (m.code) {
    case "RPC_REFUSED": return "REFUSED_IN_DB";
    case "RPC_TIMEOUT": return "TIMED_OUT";
    case "RPC_NO_RESPONSE": return "OUTCOME_UNKNOWN";
    case "RPC_SCHEMA_UNAVAILABLE": return pg === "PGRST301" ? "TOKEN_REJECTED" : "REFUSED_AT_BOUNDARY";
    case "RPC_TRANSIENT": case "LEASE_LOST": case "ENTRY_TOO_LATE": return pg === null ? "NOT_SENT" : "DB_TIMEOUT";
    default: return null;
  }
}

/** Builds an append-only journal for one invocation; `emit` is the caller's logger (never throws into the worker). */
export function createJournal(invocationId: string, now: () => number, emit?: (e: JournalEvent) => void) {
  const events: JournalEvent[] = [];
  let seq = 0, closed = false;
  const push = (e: Omit<JournalEvent, "invocationId" | "seq" | "at">) => {
    if (closed) return;
    const ev: JournalEvent = Object.freeze({ invocationId, seq: ++seq, at: now(), ...e });
    events.push(ev);
    try { emit?.(ev); } catch { /* the journal never blocks the worker */ }
  };
  return {
    events,
    start: () => push({ type: "INVOCATION_START" }),
    hosted: (m: { code: string; fn?: string | null; pgCode?: string | null }) => {
      const k = kindOfHostedMetric(m); if (!k) return;
      push({ type: "CALL", fn: fnName(m.fn), kind: k, pgCode: typeof m.pgCode === "string" && PG.test(m.pgCode) ? m.pgCode : null, category: CATEGORY_OF[k] });
    },
    end: (status: string) => { push({ type: "INVOCATION_END", status: /^[A-Z_]{1,40}$/.test(status) ? status : "OTHER" }); closed = true; },
  };
}

export interface DbRefusalRow { id: number; fn: string; sqlstate: string; session_id?: string | null; created_at: number }
export interface TallyRow { baseline_rows: number; recorded_total: number; dropped_total: number }
export type FindingCode =
  | "MISSING_IN_DB"            // an A-class refusal the worker saw has no matching row and is not explained by the cap counter
  | "DROPPED_BY_CAP"           // explained by the tally's dropped counter (recorded as a count, not a row)
  | "DB_ONLY_REFUSAL"          // a refusal row with no worker journal entry: someone else used the worker identity
  | "ROWS_DELETED"             // fewer rows than the tally recorded
  | "ROWS_ADDED"               // more rows than the tally recorded (forged or inserted outside the recorder)
  | "TALLY_MISSING"            // refusal rows exist but no tally: completeness cannot be checked
  | "JOURNAL_GAP"              // sequence numbers of one invocation are not contiguous
  | "JOURNAL_INCOMPLETE";      // an invocation has no end event (killed before logging: category C)
export interface Finding { code: FindingCode; invocationId?: string; fn?: string | null; count?: number }
export interface Reconciliation {
  byCategory: Record<Category, number>;
  matched: number; findings: Finding[];
  /** True only when every A-class refusal is matched or counted as dropped and the tally agrees with the rows. */
  complete: boolean;
}
/**
 * Reconciles worker journals with database rows for ONE worker identity over the journal's time window.
 * Matching is one-to-one by function, SQLSTATE and time (± toleranceMs). Rows outside every invocation window are ignored.
 */
export function reconcileRefusals(x: { journal: readonly JournalEvent[]; rows: readonly DbRefusalRow[]; tally: TallyRow | null; toleranceMs?: number }): Reconciliation {
  const tol = x.toleranceMs ?? 5_000;
  const byCategory: Record<Category, number> = { A: 0, B: 0, C: 0 };
  const findings: Finding[] = [];
  // Journal structure: contiguous sequence per invocation and an end event.
  const inv = new Map<string, JournalEvent[]>();
  for (const e of x.journal) { const l = inv.get(e.invocationId) ?? []; l.push(e); inv.set(e.invocationId, l); }
  const windows: { from: number; to: number }[] = [];
  for (const [id, l] of inv) {
    l.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < l.length; i++) if (l[i]!.seq !== i + 1) { findings.push({ code: "JOURNAL_GAP", invocationId: id }); break; }
    if (!l.some((e) => e.type === "INVOCATION_END")) { findings.push({ code: "JOURNAL_INCOMPLETE", invocationId: id }); byCategory.C++; }
    windows.push({ from: l[0]!.at - tol, to: l.at(-1)!.at + tol });
  }
  const inWindow = (t: number) => windows.some((w) => t >= w.from && t <= w.to);
  const rows = x.rows.filter((r) => inWindow(r.created_at)), used = new Set<number>();
  let unmatchedA = 0;
  const calls = x.journal.filter((e) => e.type === "CALL");
  for (const e of calls) {
    const c = e.category ?? "B"; byCategory[c]++;
    if (e.kind !== "REFUSED_IN_DB") continue;
    const m = rows.find((r) => !used.has(r.id) && r.fn === e.fn && r.sqlstate === e.pgCode && Math.abs(r.created_at - e.at) <= tol);
    if (m) used.add(m.id); else unmatchedA++;
  }
  const matched = used.size;
  const dropped = Math.max(0, x.tally?.dropped_total ?? 0);
  const explained = Math.min(unmatchedA, dropped);
  if (explained > 0) findings.push({ code: "DROPPED_BY_CAP", count: explained });
  if (unmatchedA - explained > 0) findings.push({ code: "MISSING_IN_DB", count: unmatchedA - explained });
  const dbOnly = rows.filter((r) => !used.has(r.id)).length;
  if (dbOnly > 0) findings.push({ code: "DB_ONLY_REFUSAL", count: dbOnly });
  if (x.tally) {
    const diff = x.tally.recorded_total - x.rows.length;
    if (diff > 0) findings.push({ code: "ROWS_DELETED", count: diff });
    if (diff < 0) findings.push({ code: "ROWS_ADDED", count: -diff });
  } else if (x.rows.length > 0) findings.push({ code: "TALLY_MISSING", count: x.rows.length });
  const complete = !findings.some((f) => f.code !== "DROPPED_BY_CAP");
  return { byCategory, matched, findings, complete };
}
