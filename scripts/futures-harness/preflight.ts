// Phase 1.6 READ-ONLY preflight for the dedicated test account. Never places orders, never changes settings, limits,
// connections, credentials, kill switches or certification records, and never writes to the database.
// Usage: PREFLIGHT_TEST_USER_ID=… PREFLIGHT_OWNER_USER_ID=… PREFLIGHT_CONNECTION_ID=… bun scripts/futures-harness/preflight.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { supabaseAdmin as db } from '@/integrations/supabase/client.server';
import { isolationFacts, productionFingerprint, type HarnessConfig } from '@/lib/futures-harness.server';
import { isolationProblems, fingerprintChanges, productionSafetyProblems, assertReadOnlyCall, HARNESS_OVERALL_STATUS } from '@/lib/futures-harness';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (k: string) => { const v = process.env[k]; if (!v || !UUID.test(v)) throw new Error(`${k} must be a UUID`); return v; };
const cfg = { testUserId: id('PREFLIGHT_TEST_USER_ID'), ownerUserId: id('PREFLIGHT_OWNER_USER_ID'), connectionId: id('PREFLIGHT_CONNECTION_ID'),
  symbol: 'DOGE/USDT', margin: 1, leverage: 1, slPct: 1, tpPct: 1, fundingWaitMaxMin: 1 } satisfies HarnessConfig;
const count = async (q: PromiseLike<{ count: number | null; error: unknown }>, what: string) => { const r = await q; if (r.error || r.count == null) throw new Error(`${what} unavailable`); return r.count; };
const head = { count: 'exact' as const, head: true };
const now = new Date().toISOString();

async function productionSafety() {
  return {
    autopilotOn: await count(db.from('autopilot_settings').select('user_id', head).or('enabled.eq.true,live_enabled.eq.true'), 'Autopilot state'),
    futuresLiveOn: await count(db.from('futures_settings').select('user_id', head).eq('live_enabled', true), 'Live Futures state'),
    passCertifications: await count(db.from('futures_certifications').select('id', head).eq('result', 'PASS'), 'Certification records'),
    productionPendingOrders: await count(db.from('orders').select('id', head).eq('execution_environment', 'production').eq('market_type', 'usd_m_futures').in('status', ['pending', 'open', 'partially_filled']), 'Production orders'),
    productionOpenFutures: await count(db.from('positions').select('id', head).eq('execution_environment', 'production').eq('market_type', 'usd_m_futures').eq('is_open', true), 'Production positions'),
    activeLeases: await count(db.from('futures_execution_leases').select('connection_id', head).gt('expires_at', now), 'Execution leases'),
  };
}
const mask = (e?: string | null) => (e ? e.replace(/^(.).*(@.*)$/, '$1***$2') : null);

const before = await productionFingerprint(db, cfg.ownerUserId);
const facts = await isolationFacts(db, cfg);
const problems = isolationProblems(facts);
const [testUser, ownerUser, ownerRisk, testRisk, certTotal] = await Promise.all([
  db.auth.admin.getUserById(cfg.testUserId), db.auth.admin.getUserById(cfg.ownerUserId),
  db.from('risk_settings').select('trading_halted').eq('user_id', cfg.ownerUserId).maybeSingle(),
  db.from('risk_settings').select('user_id,trading_halted').eq('user_id', cfg.testUserId).maybeSingle(),
  count(db.from('futures_certifications').select('id', head), 'Certification records'),
]);
if (!testUser.data.user) problems.push('Test sign-in does not exist');
if (testUser.data.user && ownerUser.data.user && testUser.data.user.email === ownerUser.data.user.email) problems.push('Test sign-in uses the production email');
if (testUser.data.user && !testUser.data.user.email_confirmed_at) problems.push('Test sign-in email is not confirmed');

// Exchange reads happen only when the connection belongs to a different, dedicated test account and is Testnet.
let exchange: Record<string, unknown> = { skipped: 'Isolation not proven; no exchange call was made' };
const conn = facts.testConnections.find(c => c.id === cfg.connectionId);
if (cfg.testUserId !== cfg.ownerUserId && conn?.is_testnet) {
  const { loadFuturesAccount } = await import('@/lib/futures.server');
  const { futuresCall } = await import('@/lib/binance-futures.server');
  const a = await loadFuturesAccount(db, cfg.testUserId, cfg.connectionId);
  if (a.testnet !== true) throw new Error('Refused: connection is not Testnet');
  const get = <T,>(path: string) => { assertReadOnlyCall('GET', path); return futuresCall<T>({ testnet: true, creds: a.creds }, 'GET', path); };
  const [acct, config, dual, multi, pos, open, algo] = await Promise.all([
    get<{ availableBalance: string; totalWalletBalance: string }>('/fapi/v3/account'), get<{ canTrade: boolean }>('/fapi/v1/accountConfig'),
    get<{ dualSidePosition: boolean }>('/fapi/v1/positionSide/dual'), get<{ multiAssetsMargin: boolean }>('/fapi/v1/multiAssetsMargin'),
    get<{ symbol: string; positionAmt: string }[]>('/fapi/v3/positionRisk'), get<unknown[]>('/fapi/v1/openOrders'), get<unknown[]>('/fapi/v1/openAlgoOrders'),
  ]);
  const exposed = pos.filter(p => Number(p.positionAmt) !== 0).map(p => p.symbol);
  exchange = { venue: 'Binance USD-M Futures Testnet', readAccess: true, canTrade: config.canTrade === true, hedgeMode: dual.dualSidePosition,
    multiAssets: multi.multiAssetsMargin, availableUSDT: acct.availableBalance, walletUSDT: acct.totalWalletBalance,
    openPositions: exposed, openOrders: open.length, openProtectionOrders: algo.length,
    withdrawalPermission: 'not readable on Testnet — owner attestation required' };
  if (!config.canTrade) problems.push('Testnet key cannot trade Futures');
  if (exposed.length || open.length || algo.length) problems.push('Testnet account is not flat');
}
const safety = await productionSafety();
const safetyProblems = productionSafetyProblems(safety);
const after = await productionFingerprint(db, cfg.ownerUserId);
const changed = fingerprintChanges(before, after);
if (changed.length) problems.push(`Production records changed during preflight: ${changed.join(', ')}`);

const report = {
  kind: 'Phase 1.6 read-only preflight', at: now, phase15: 'FAIL / NOT CERTIFIED', harnessOverall: HARNESS_OVERALL_STATUS,
  ordersPlaced: 0, databaseWrites: 0,
  testAccount: { userId: cfg.testUserId, email: mask(testUser.data.user?.email), emailConfirmed: !!testUser.data.user?.email_confirmed_at,
    admin: facts.testIsAdmin, elite: facts.elite, autopilot: facts.autopilot, futuresLimits: facts.limits, risk: facts.risk,
    connections: facts.testConnections.map(c => ({ id: c.id, exchange: c.exchange, testnet: c.is_testnet, status: c.status, accountType: c.account_type })) },
  killSwitch: { scope: 'per sign-in (emergency stop filters every write by the caller user ID)', testAccountHalted: testRisk.data?.trading_halted ?? null,
    productionHalted: ownerRisk.data?.trading_halted ?? null, separateRiskRows: !!testRisk.data && cfg.testUserId !== cfg.ownerUserId },
  exchange, production: { ...safety, certificationRowsTotal: certTotal, fingerprintUnchanged: changed.length === 0, fingerprint: after.total },
  isolationProblems: problems, productionSafetyProblems: safetyProblems,
  verdict: problems.length || safetyProblems.length ? 'NOT READY' : 'READY FOR OWNER APPROVAL (no execution performed)',
};
mkdirSync('docs/certification', { recursive: true });
const file = process.env['PREFLIGHT_OUT'] ?? `docs/certification/phase-1.6-preflight-${now.replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`${report.verdict}\n${[...problems, ...safetyProblems].map(p => ` - ${p}`).join('\n')}\nEvidence: ${file}`);
