// Production USD-M Futures authorization — pure rules shared by manual entries, Autopilot tools and tests.
// The database enforces the same rule independently in public.futures_live_authorized (see the Futures migration).

/**
 * Certification revision the current Futures execution code requires. Bump it together with
 * public.futures_certification_revision() whenever Futures execution changes: every earlier PASS becomes stale.
 */
export const FUTURES_CERTIFICATION_REVISION = "futures-exec-2026-11-r1";

export interface FuturesCertification {
  id: string; user_id: string; connection_id: string; environment: string;
  result: string; revision: string; created_at: string;
}
export interface FuturesConnectionRow { id: string; user_id: string; exchange: string; status: string; is_testnet: boolean }
export interface FuturesSettingsRow { live_enabled: boolean; connection_id: string | null; testnet_certified_at?: string | null }

export interface FuturesAuthorizationInput {
  userId: string;
  connection: FuturesConnectionRow | null;
  settings: FuturesSettingsRow | null;
  /** risk_settings.trading_halted; null = no risk row (unauthorized). */
  halted: boolean | null;
  certifications: FuturesCertification[];
  requiredRevision?: string | undefined;
  /** Checking whether the owner may switch Live Futures ON: the live flag itself is not yet required. */
  forOptIn?: boolean | undefined;
}

/** Most recent certification for exactly this owner + production account. A newer FAIL supersedes an older PASS. */
export function latestCertification(rows: FuturesCertification[], userId: string, connectionId: string) {
  return rows
    .filter((r) => r.user_id === userId && r.connection_id === connectionId)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (b.id < a.id ? -1 : 1))[0] ?? null;
}

/** Why production Futures entries are not authorized, or null when they are. `testnet_certified_at` is never consulted. */
export function productionFuturesProblem(i: FuturesAuthorizationInput): string | null {
  const c = i.connection;
  if (!c || c.user_id !== i.userId || c.exchange !== "binance" || c.status !== "connected") return "Verified owner Binance account required";
  if (c.is_testnet) return "Testnet accounts never authorize production Futures";
  if (!i.settings) return "Save explicit Futures risk limits first";
  if (!i.forOptIn && !i.settings.live_enabled) return "Live Futures is disabled";
  if (!i.forOptIn && i.settings.connection_id !== c.id) return "Live Futures opt-in is bound to a different account";
  if (i.halted == null) return "Account risk settings required";
  if (i.halted) return "Trading is halted";
  const cert = latestCertification(i.certifications, i.userId, c.id);
  if (!cert) return "No PASS certification on record for this production account";
  if (cert.environment !== "production") return "Certification is not bound to the production environment";
  if (cert.result !== "PASS") return `Latest certification is ${cert.result}; production Futures stay locked`;
  if (cert.revision !== (i.requiredRevision ?? FUTURES_CERTIFICATION_REVISION)) return "Certification is stale for the current Futures execution revision";
  return null;
}
