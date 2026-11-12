import { describe, expect, it } from "vitest";
import { productionFuturesProblem, latestCertification, FUTURES_CERTIFICATION_REVISION, type FuturesAuthorizationInput, type FuturesCertification } from "@/lib/futures-authorization";
import { readFileSync } from "node:fs";

const U = "u1", P = "prod-1";
const cert = (result: string, at: string, extra: Partial<FuturesCertification> = {}): FuturesCertification =>
  ({ id: `${result}-${at}`, user_id: U, connection_id: P, environment: "production", result, revision: FUTURES_CERTIFICATION_REVISION, created_at: at, ...extra });
// The observed production state: Live ON, bound account, legacy timestamp set, no certification record.
const base = (o: Partial<FuturesAuthorizationInput> = {}): FuturesAuthorizationInput => ({
  userId: U, connection: { id: P, user_id: U, exchange: "binance", status: "connected", is_testnet: false },
  settings: { live_enabled: true, connection_id: P, testnet_certified_at: "2026-11-11T17:26:58Z" }, halted: false, certifications: [], ...o,
});

describe("stale certification never authorizes production Futures", () => {
  it("rejects the legacy timestamp alone", () => expect(productionFuturesProblem(base())).toMatch(/No PASS certification/));
  it("rejects when a newer FAIL supersedes an older PASS", () =>
    expect(productionFuturesProblem(base({ certifications: [cert("PASS", "2026-11-11T17:00:00Z"), cert("FAIL", "2026-11-12T04:50:00Z")] }))).toMatch(/Latest certification is FAIL/));
  it("rejects a PASS from an older execution revision", () =>
    expect(productionFuturesProblem(base({ certifications: [cert("PASS", "2026-11-12T00:00:00Z", { revision: "futures-exec-2026-10-r0" })] }))).toMatch(/stale/));
  it("ignores a PASS that belongs to another account", () =>
    expect(productionFuturesProblem(base({ certifications: [cert("PASS", "2026-11-12T00:00:00Z", { connection_id: "prod-2" })] }))).toMatch(/No PASS/));
  it("rejects a Testnet connection as production authority", () =>
    expect(productionFuturesProblem(base({ connection: { id: P, user_id: U, exchange: "binance", status: "connected", is_testnet: true } }))).toMatch(/Testnet/));
  it("accepts only a current PASS on the bound account", () =>
    expect(productionFuturesProblem(base({ certifications: [cert("FAIL", "2026-11-11T00:00:00Z"), cert("PASS", "2026-11-12T00:00:00Z")] }))).toBeNull());
  it("keeps the code revision equal to the database revision", () =>
    expect(readFileSync("docs/proposed-migrations/0039_futures_pass_certification_and_autopilot_fencing.sql", "utf8")).toContain(`'${FUTURES_CERTIFICATION_REVISION}'::text`));
  it("picks the newest record for the exact owner and account", () =>
    expect(latestCertification([cert("PASS", "2026-11-12T00:00:00Z"), cert("FAIL", "2026-11-12T01:00:00Z"), cert("PASS", "2026-11-13T00:00:00Z", { user_id: "u2" })], U, P)?.result).toBe("FAIL"));
});

describe("disabled Live Futures never authorizes production entries", () => {
  const pass = [cert("PASS", "2026-11-12T00:00:00Z")];
  it("rejects when Live Futures is OFF despite a current PASS", () =>
    expect(productionFuturesProblem(base({ certifications: pass, settings: { live_enabled: false, connection_id: P } }))).toMatch(/disabled/));
  it("rejects when the opt-in is bound to another account", () =>
    expect(productionFuturesProblem(base({ certifications: pass, settings: { live_enabled: true, connection_id: "prod-2" } }))).toMatch(/different account/));
  it("rejects when trading is halted", () => expect(productionFuturesProblem(base({ certifications: pass, halted: true }))).toMatch(/halted/));
  it("rejects when no risk settings exist", () => expect(productionFuturesProblem(base({ certifications: pass, halted: null }))).toMatch(/risk settings/));
  it("opt-in check still demands a current PASS", () =>
    expect(productionFuturesProblem(base({ forOptIn: true, settings: { live_enabled: false, connection_id: null } }))).toMatch(/No PASS/));
});
