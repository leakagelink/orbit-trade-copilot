// Proposed retention policy (owner proposal, 13 Nov 2026 — NOT approved, NOT enforced). One test per stated rule.
import { describe, expect, it } from "vitest";
import { PROPOSED_RETENTION_POLICY as P, RETENTION_TABLE_MAP, retentionAction, validateRetentionPolicy } from "@/lib/retention-policy";

const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 13);
const rec = (ageDays: number, o: { legalHold?: boolean; accountDeleted?: boolean; anonymized?: boolean } = {}) => ({ createdAt: NOW - ageDays * DAY, legalHold: false, accountDeleted: false, ...o });

describe("proposed periods", () => {
  it("orders, fills, risk approvals, attribution and audit: 2 years (730 days)", () => { expect(P.rules.trading_audit.days).toBe(730); });
  it("raw AI prompts and provider outputs: 90 days", () => { expect(P.rules.ai_raw.days).toBe(90); });
  it("temporary debug logs: 30 days", () => { expect(P.rules.debug_logs.days).toBe(30); });
  it("is labelled as a proposal and is valid", () => { expect(P.status).toMatch(/NOT APPROVED/); expect(validateRetentionPolicy(P)).toEqual([]); });
});

describe("expiry", () => {
  it("audit records are kept for 729 days and archived then deleted at 730", () => {
    expect(retentionAction("trading_audit", rec(729), NOW).action).toBe("keep");
    expect(retentionAction("trading_audit", rec(730), NOW).action).toBe("archive_then_delete");
  });
  it("raw AI text is deleted at 90 days; debug logs at 30 days", () => {
    expect(retentionAction("ai_raw", rec(89), NOW).action).toBe("keep");
    expect(retentionAction("ai_raw", rec(90), NOW).action).toBe("delete");
    expect(retentionAction("debug_logs", rec(29), NOW).action).toBe("keep");
    expect(retentionAction("debug_logs", rec(30), NOW).action).toBe("delete");
  });
});

describe("account deletion, anonymization and audit preservation", () => {
  it("an audit record of a deleted account is anonymized and kept until it expires", () => {
    expect(retentionAction("trading_audit", rec(10, { accountDeleted: true }), NOW).action).toBe("anonymize");
    expect(retentionAction("trading_audit", rec(10, { accountDeleted: true, anonymized: true }), NOW).action).toBe("keep");
    expect(retentionAction("trading_audit", rec(730, { accountDeleted: true, anonymized: true }), NOW).action).toBe("archive_then_delete");
  });
  it("raw AI text and debug logs of a deleted account are deleted immediately", () => {
    expect(retentionAction("ai_raw", rec(1, { accountDeleted: true }), NOW).action).toBe("delete");
    expect(retentionAction("debug_logs", rec(1, { accountDeleted: true }), NOW).action).toBe("delete");
  });
  it("a legal hold keeps everything, even after expiry or account deletion", () => {
    expect(retentionAction("ai_raw", rec(400, { legalHold: true, accountDeleted: true }), NOW).action).toBe("keep");
    expect(retentionAction("trading_audit", rec(4000, { legalHold: true }), NOW).action).toBe("keep");
  });
  it("a configuration that would delete audit records with the account, or keep raw AI text longer than audit, is refused", () => {
    expect(validateRetentionPolicy({ ...P, rules: { ...P.rules, trading_audit: { ...P.rules.trading_audit, onAccountDeletion: "delete" } } }).join()).toMatch(/must anonymize/);
    expect(validateRetentionPolicy({ ...P, rules: { ...P.rules, ai_raw: { ...P.rules.ai_raw, days: 800 } } }).join()).toMatch(/longer than audit/);
    expect(validateRetentionPolicy({ ...P, rules: { ...P.rules, debug_logs: { ...P.rules.debug_logs, days: 0 } } }).join()).toMatch(/between 1 and 3650/);
    // An invalid policy removes nothing.
    expect(retentionAction("ai_raw", rec(400), NOW, { ...P, rules: { ...P.rules, ai_raw: { ...P.rules.ai_raw, days: 0 } } }).action).toBe("keep");
  });
  it("orders, trades, risk approvals and attribution are mapped to the 2-year audit category", () => {
    for (const t of ["orders", "trades", "futures_paper_risk_approvals", "futures_strategy_attribution_events", "audit_logs"]) expect(RETENTION_TABLE_MAP[t]!.category).toBe("trading_audit");
    expect(RETENTION_TABLE_MAP["ai_sessions"]!.category).toBe("ai_raw");
  });
});
