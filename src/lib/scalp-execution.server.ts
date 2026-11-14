// Phase 4H.8 — server side of the hard execution gate for scalping orders. It validates the request strictly, reads
// only the emergency-stop flag (read-only), evaluates executionGate and returns a REFUSED audit record. It loads no
// credentials, imports no exchange adapter and has no network transport, so it cannot submit any order — Testnet or live —
// whatever the request says. The structured audit line names the environment and carries a correlation id; it is redacted.
import { z } from "zod";
import { newId, redact } from "./live-monitor";
import { executionGate, SCALP_EXEC_VERSION, type ExecEnvironment, type GateResult } from "./scalp-execution";

export const scalpOrderRequestSchema = z.object({ proposalId: z.string().min(8).max(200), environment: z.enum(["testnet", "live"]), symbol: z.enum(["BTCUSDT", "ETHUSDT"]) }).strict();
export interface ExecutionAudit { type: "EXECUTION_REFUSED"; correlationId: string; at: number; version: typeof SCALP_EXEC_VERSION; environment: ExecEnvironment | "unknown"; proposalId: string | null; symbol: string | null; code: string; failedChecks: string[] }
export interface GateDeps { now(): number; readEmergencyStop(): Promise<boolean | null>; log(line: string): void }

export async function requestScalpOrder(raw: unknown, deps: GateDeps): Promise<{ status: "REFUSED"; gate: GateResult | null; audit: ExecutionAudit }> {
  const correlationId = newId("exec"), at = deps.now(), parsed = scalpOrderRequestSchema.safeParse(raw);
  const finish = (audit: ExecutionAudit, gate: GateResult | null) => {
    try { deps.log(JSON.stringify({ ...audit, failedChecks: audit.failedChecks.slice(0, 12), detail: redact({ note: "no order submitted" }) })); } catch { /* logging never changes the outcome */ }
    return { status: "REFUSED" as const, gate, audit };
  };
  if (!parsed.success) return finish({ type: "EXECUTION_REFUSED", correlationId, at, version: SCALP_EXEC_VERSION, environment: "unknown", proposalId: null, symbol: null, code: "INVALID_REQUEST", failedChecks: parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.code}`) }, null);
  let emergencyStop: boolean | null = null;
  try { emergencyStop = await deps.readEmergencyStop(); } catch { emergencyStop = null; }
  const gate = executionGate({ requestedEnvironment: parsed.data.environment, credentialEnvironment: null, liveOptIn: null, emergencyStop, certificationPass: null, decision: null, decisionAgeMs: null, maxDecisionAgeMs: 5_000, unresolvedOrders: null, protectionVerified: null });
  if (gate.allowed) throw new Error("execution transport is not connected"); // unreachable while the code flag is false
  return finish({ type: "EXECUTION_REFUSED", correlationId, at, version: SCALP_EXEC_VERSION, environment: parsed.data.environment, proposalId: parsed.data.proposalId, symbol: parsed.data.symbol, code: gate.code, failedChecks: gate.checks.filter((c) => !c.ok).map((c) => c.id) }, gate);
}
