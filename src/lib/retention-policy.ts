// Configurable data-retention policy (owner proposal, 13 Nov 2026) — PROPOSED, NOT APPROVED, NOT ENFORCED. Pure and
// browser-safe; imports nothing. Nothing deletes, archives or anonymizes data today: the append-only triggers of the
// trading and research ledgers refuse deletes, and enforcement needs a separately reviewed migration (see
// docs/phase-4e/retention-and-deletion-policy.md). This module fixes the contract such a migration and its scheduled job
// would implement, so the rules can be reviewed and tested before anything is built.

export type RetentionCategory = "trading_audit" | "ai_raw" | "debug_logs";
export type ExpiryAction = "archive_then_delete" | "delete";
export type AccountDeletionAction = "anonymize_and_keep" | "delete";
export interface RetentionRule { days: number; onExpiry: ExpiryAction; onAccountDeletion: AccountDeletionAction }
export interface RetentionPolicy { status: string; rules: Record<RetentionCategory, RetentionRule> }

/** Owner's proposal: orders, fills, risk approvals, attribution and audit 2 years; raw AI prompts/outputs 90 days; debug logs 30 days. */
export const PROPOSED_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  status: "PROPOSED — NOT APPROVED, NOT ENFORCED",
  rules: Object.freeze({
    trading_audit: Object.freeze({ days: 730, onExpiry: "archive_then_delete", onAccountDeletion: "anonymize_and_keep" }),
    ai_raw: Object.freeze({ days: 90, onExpiry: "delete", onAccountDeletion: "delete" }),
    debug_logs: Object.freeze({ days: 30, onExpiry: "delete", onAccountDeletion: "delete" }),
  }) as Record<RetentionCategory, RetentionRule>,
}) as RetentionPolicy;

/**
 * Proposed mapping of existing (and draft) tables to categories. `confirm: true` marks a mapping the owner must confirm
 * (the table mixes raw AI text with structured evidence, or its purpose is operational rather than debug).
 * Tables not listed keep their current behaviour (profiles, roles, subscriptions, billing/payments, credentials,
 * connections, support, notifications, watchlists, alerts, journal, strategies, backtests, settings).
 */
export const RETENTION_TABLE_MAP: Readonly<Record<string, { category: RetentionCategory; confirm: boolean }>> = Object.freeze({
  orders: { category: "trading_audit", confirm: false },
  trades: { category: "trading_audit", confirm: false },
  positions: { category: "trading_audit", confirm: false },
  futures_broker_events: { category: "trading_audit", confirm: false },
  order_recovery_observations: { category: "trading_audit", confirm: false },
  futures_certifications: { category: "trading_audit", confirm: false },
  futures_verifications: { category: "trading_audit", confirm: false },
  trading_safety_events: { category: "trading_audit", confirm: false },
  audit_logs: { category: "trading_audit", confirm: false },
  wallet_transactions: { category: "trading_audit", confirm: false },
  arbitrage_runs: { category: "trading_audit", confirm: false },
  autopilot_runs: { category: "trading_audit", confirm: false },
  strategy_integrity_events: { category: "trading_audit", confirm: false },
  ai_research_decisions: { category: "trading_audit", confirm: true },
  ai_trade_proposals: { category: "trading_audit", confirm: true },
  // Drafts (not applied): Futures paper ledger 0049 and attribution 0048.
  futures_paper_events: { category: "trading_audit", confirm: false },
  futures_paper_risk_approvals: { category: "trading_audit", confirm: false },
  futures_paper_commits: { category: "trading_audit", confirm: false },
  futures_paper_candles: { category: "trading_audit", confirm: true },
  futures_order_strategy_identity: { category: "trading_audit", confirm: false },
  futures_strategy_attribution_events: { category: "trading_audit", confirm: false },
  ai_sessions: { category: "ai_raw", confirm: false },
  ai_agent_outputs: { category: "ai_raw", confirm: false },
  ai_strategy_generations: { category: "ai_raw", confirm: false },
  ai_research_reports: { category: "ai_raw", confirm: true },
  ai_research_runs: { category: "ai_raw", confirm: true },
  bot_logs: { category: "debug_logs", confirm: true },
});

const LIMITS = { minDays: 1, maxDays: 3650 } as const;

/** Problems with a configured policy; an empty list means it can be used. Audit records are never deleted with an account. */
export function validateRetentionPolicy(p: RetentionPolicy): string[] {
  const out: string[] = [];
  for (const c of ["trading_audit", "ai_raw", "debug_logs"] as RetentionCategory[]) {
    const r = p?.rules?.[c];
    if (!r) { out.push(`${c}: rule missing`); continue; }
    if (!Number.isInteger(r.days) || r.days < LIMITS.minDays || r.days > LIMITS.maxDays) out.push(`${c}: days must be an integer between ${LIMITS.minDays} and ${LIMITS.maxDays}`);
    if (r.onExpiry !== "archive_then_delete" && r.onExpiry !== "delete") out.push(`${c}: unknown expiry action`);
    if (r.onAccountDeletion !== "anonymize_and_keep" && r.onAccountDeletion !== "delete") out.push(`${c}: unknown account-deletion action`);
  }
  const t = p?.rules?.trading_audit;
  if (t && t.onAccountDeletion !== "anonymize_and_keep") out.push("trading_audit: account deletion must anonymize and keep audit records until they expire");
  if (t && t.onExpiry !== "archive_then_delete") out.push("trading_audit: expired audit records are archived (restorable export) before deletion");
  for (const c of ["ai_raw", "debug_logs"] as RetentionCategory[]) {
    const r = p?.rules?.[c];
    if (r && r.onAccountDeletion !== "delete") out.push(`${c}: raw AI text and debug logs are deleted with the account`);
    if (r && t && r.days > t.days) out.push(`${c}: may not be kept longer than audit records`);
  }
  return out;
}

export type RetentionAction = "keep" | "anonymize" | "archive_then_delete" | "delete";
export interface RecordFacts { createdAt: number; legalHold: boolean; accountDeleted: boolean; anonymized?: boolean }
const DAY = 86_400_000;

/** What the (future) retention job would do with one record now. A legal hold always wins. */
export function retentionAction(category: RetentionCategory, rec: RecordFacts, now: number, policy: RetentionPolicy = PROPOSED_RETENTION_POLICY): { action: RetentionAction; reason: string } {
  const issues = validateRetentionPolicy(policy);
  if (issues.length) return { action: "keep", reason: `policy invalid (${issues[0]}); nothing is removed` };
  if (!Number.isFinite(rec.createdAt) || !Number.isFinite(now) || rec.createdAt > now) return { action: "keep", reason: "record time unknown or in the future; nothing is removed" };
  if (rec.legalHold) return { action: "keep", reason: "legal hold" };
  const r = policy.rules[category];
  const expired = now - rec.createdAt >= r.days * DAY;
  if (expired) return { action: r.onExpiry, reason: `older than ${r.days} days` };
  if (rec.accountDeleted) {
    if (r.onAccountDeletion === "delete") return { action: "delete", reason: "account deleted: raw or debug data is removed" };
    return rec.anonymized ? { action: "keep", reason: "anonymized audit record kept until expiry" } : { action: "anonymize", reason: "account deleted: audit record kept with the owner replaced by a one-way tombstone" };
  }
  return { action: "keep", reason: `within ${r.days} days` };
}
