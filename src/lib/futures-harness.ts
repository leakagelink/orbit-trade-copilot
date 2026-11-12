// Pure Phase 1.6 harness rules (no I/O): isolation facts, production fingerprints, broker flatness and verdicts.
// The harness never creates certification records; every run reports FAIL / NOT CERTIFIED overall.

export const HARNESS_OVERALL_STATUS = 'FAIL / NOT CERTIFIED' as const;
export type ScenarioId = 'partial_fill' | 'protection_rejection' | 'unknown_submission' | 'isolated_kill_switch' | 'concurrent_requests' | 'crash_restart' | 'funding_reconciliation' | 'final_broker_state';
export const SCENARIOS: readonly ScenarioId[] = ['partial_fill', 'protection_rejection', 'unknown_submission', 'isolated_kill_switch', 'concurrent_requests', 'crash_restart', 'funding_reconciliation', 'final_broker_state'];
export type Provenance = 'real' | 'injected' | 'real_broker_response_to_injected_input';

export interface IsolationFacts {
  testUserId: string; ownerUserId: string;
  testIsAdmin: boolean;
  testConnections: { id: string; exchange: string; is_testnet: boolean; status: string; account_type: string | null }[];
  connectionId: string;
  autopilot: { enabled: boolean; live_enabled: boolean } | null;
  elite: boolean;
  limits: { max_margin: number | null; max_leverage: number | null; max_loss: number | null; live_enabled: boolean } | null;
  risk: { max_daily_loss: number | null; max_open_exposure: number | null; trading_halted: boolean } | null;
}
/** Every reason the harness must refuse to touch an exchange. Empty = isolated. */
export function isolationProblems(f: IsolationFacts): string[] {
  const p: string[] = [];
  if (!f.testUserId || !f.ownerUserId) p.push('Test and production account IDs are both required');
  if (f.testUserId === f.ownerUserId) p.push('Dedicated test account must differ from the production owner');
  if (f.testIsAdmin) p.push('Test account must not hold an admin role');
  const c = f.testConnections.find(x => x.id === f.connectionId);
  if (!c) p.push('Selected connection is not owned by the test account');
  else {
    if (c.exchange !== 'binance' || !c.is_testnet) p.push('Selected connection must be Binance Futures Testnet');
    if (c.status !== 'connected') p.push('Testnet connection is not verified');
    if (c.account_type !== 'futures' && c.account_type !== 'both') p.push('Testnet connection must allow Futures');
  }
  if (f.testConnections.some(x => !x.is_testnet && x.status !== 'disconnected')) p.push('Test account owns a production or non-Testnet connection');
  if (f.autopilot && (f.autopilot.enabled || f.autopilot.live_enabled)) p.push('Test account Autopilot must be OFF');
  if (!f.elite) p.push('Test account needs Elite access for Futures entries');
  if (!f.limits || f.limits.max_margin == null || f.limits.max_leverage == null || f.limits.max_loss == null) p.push('Owner-stated Testnet Futures limits are missing');
  else if (f.limits.live_enabled) p.push('Test account Live Futures must stay OFF');
  if (!f.risk || f.risk.max_daily_loss == null || f.risk.max_open_exposure == null) p.push('Test account daily-loss and exposure limits are missing');
  else if (f.risk.trading_halted) p.push('Test account is halted; clear its own halt before running');
  return p;
}

/** Deterministic JSON (sorted keys) so fingerprints change only when content changes. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
export async function sha256(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
export type Fingerprint = { total: string; parts: Record<string, string> };
export async function fingerprint(parts: Record<string, unknown>): Promise<Fingerprint> {
  const hashed: Record<string, string> = {};
  for (const k of Object.keys(parts).sort()) hashed[k] = await sha256(canonical(parts[k]));
  return { total: await sha256(canonical(hashed)), parts: hashed };
}
export const fingerprintChanges = (a: Fingerprint, b: Fingerprint) =>
  Object.keys({ ...a.parts, ...b.parts }).filter(k => a.parts[k] !== b.parts[k]).sort();

export interface BrokerSnapshot {
  positions: { symbol: string; positionAmt: string }[]; regularOrders: number; algoOrders: number;
  activeLeases: number; pendingOrders: number; openPositions: number;
}
export function flatProblems(s: BrokerSnapshot): string[] {
  const p: string[] = [];
  const exposed = s.positions.filter(x => Number(x.positionAmt) !== 0);
  if (exposed.length) p.push(`Broker exposure remains on ${exposed.map(x => x.symbol).join(', ')}`);
  if (s.regularOrders) p.push(`${s.regularOrders} regular order(s) still open at the broker`);
  if (s.algoOrders) p.push(`${s.algoOrders} protective/algo order(s) still open at the broker`);
  if (s.activeLeases) p.push('An execution lease is still held');
  if (s.pendingOrders) p.push(`${s.pendingOrders} order intent(s) still pending reconciliation`);
  if (s.openPositions) p.push(`${s.openPositions} position(s) still open in the app`);
  return p;
}
export interface LedgerRow { position_id: string | null; realized_pnl: number; funding_pnl: number | null; fees: number; net_pnl: number | null; costs_verified: boolean }
export function ledgerProblems(rows: LedgerRow[]): string[] {
  return rows.flatMap(r => {
    const p: string[] = [];
    if (!r.costs_verified) p.push(`Trade ${r.position_id}: costs not verified from broker evidence`);
    const expected = r.realized_pnl + (r.funding_pnl ?? 0) - r.fees;
    if (r.net_pnl == null || Math.abs(r.net_pnl - expected) > 1e-8) p.push(`Trade ${r.position_id}: net differs from gross + funding − fees`);
    return p;
  });
}
export const fundingMatches = (stored: number | null, brokerEvents: { income: string }[]) =>
  stored != null && Math.abs(stored - brokerEvents.reduce((s, e) => s + Number(e.income), 0)) <= 1e-8;

export interface ScenarioResult {
  id: ScenarioId; status: 'pass' | 'fail' | 'blocked'; provenance: Provenance[];
  startedAt: string; endedAt: string; checks: { name: string; ok: boolean; detail?: string }[];
  evidence: Record<string, unknown>; productionChanged: string[]; faults: unknown[];
}
/** A scenario passes only when every check passed AND the production fingerprint is unchanged. */
export function verdict(checks: ScenarioResult['checks'], productionChanged: string[]): ScenarioResult['status'] {
  return checks.length > 0 && checks.every(c => c.ok) && productionChanged.length === 0 ? 'pass' : 'fail';
}

/** Production state that must hold before and after any Phase 1.6 preparation or run. Empty = safe. */
export interface ProductionSafetyFacts {
  autopilotOn: number; futuresLiveOn: number; passCertifications: number;
  productionPendingOrders: number; productionOpenFutures: number; activeLeases: number;
}
export function productionSafetyProblems(f: ProductionSafetyFacts): string[] {
  const p: string[] = [];
  if (f.autopilotOn) p.push(`${f.autopilotOn} account(s) have AI Autopilot ON`);
  if (f.futuresLiveOn) p.push(`${f.futuresLiveOn} account(s) have Live Futures ON`);
  if (f.passCertifications) p.push(`${f.passCertifications} PASS certification record(s) exist`);
  if (f.productionPendingOrders) p.push(`${f.productionPendingOrders} production Futures order(s) pending`);
  if (f.productionOpenFutures) p.push(`${f.productionOpenFutures} production Futures position(s) open`);
  if (f.activeLeases) p.push(`${f.activeLeases} Futures execution lease(s) held`);
  return p;
}
/** Only these Binance Futures reads are allowed during read-only verification. */
export const READ_ONLY_FUTURES_PATHS = ['/fapi/v3/account', '/fapi/v1/accountConfig', '/fapi/v1/positionSide/dual', '/fapi/v1/multiAssetsMargin', '/fapi/v3/positionRisk', '/fapi/v1/openOrders', '/fapi/v1/openAlgoOrders'] as const;
export function assertReadOnlyCall(method: string, path: string) {
  if (method !== 'GET' || !(READ_ONLY_FUTURES_PATHS as readonly string[]).includes(path)) throw new Error(`Read-only verification refused ${method} ${path}`);
}
