// Fenced execution of ONE Autopilot tool. Pure orchestration so the shutdown race is testable:
// claim (compare-and-set under this worker's holder) → authorize → execute with a pre-submit guard → record (CAS).

export class AutopilotCancelled extends Error {}

export const CANCELLED_RESULT = (reason: string) => JSON.stringify({ ok: false, error: `Not executed: ${reason}. Nothing was submitted.` });

export interface FencedToolDeps<R> {
  /** CAS: mark this tool started. False = run stopped, finished or held by another worker. */
  claim: () => Promise<boolean>;
  /** Re-reads run state + Autopilot switch + emergency stop. Null = still authorized. */
  authorize: () => Promise<string | null>;
  /** Runs the tool. `guard` must be awaited immediately before any order/action submission. */
  execute: (guard: () => Promise<void>) => Promise<R>;
  /** CAS: store the result. False = the run was stopped meanwhile; the outcome must be reconciled, never repeated. */
  record: (result: R) => Promise<boolean>;
  /** Stops the run without executing the claimed tool. */
  cancel: (reason: string) => Promise<void>;
}

export type FencedOutcome = { outcome: "lost" } | { outcome: "cancelled"; reason: string } | { outcome: "executed" } | { outcome: "orphaned" };

export async function executeFencedTool<R>(d: FencedToolDeps<R>): Promise<FencedOutcome> {
  if (!(await d.claim())) return { outcome: "lost" };
  const problem = await d.authorize();
  if (problem) { await d.cancel(problem); return { outcome: "cancelled", reason: problem }; }
  const guard = async () => {
    const p = await d.authorize();
    if (p) throw new AutopilotCancelled(`Autopilot action cancelled before submission: ${p}`);
  };
  const result = await d.execute(guard);
  return (await d.record(result)) ? { outcome: "executed" } : { outcome: "orphaned" };
}

/** Deterministic request ID for one tool call of one run: a duplicate execution reuses the same idempotency claim. */
export async function autopilotRequestId(runId: string, toolCallId: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`autopilot:${runId}:${toolCallId}`))).slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x80; // version 8 (custom)
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const x = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
