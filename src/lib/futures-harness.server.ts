// Phase 1.6 Testnet certification harness (server-only I/O). Runs ONLY for the configured dedicated test account and its
// Binance Futures Testnet connection; refuses otherwise. It never writes certification records, never reads the production
// owner's kill switch for pass/fail, and fingerprints the production owner's records before and after every scenario.
import { faultPlan, type FaultPlan } from './futures-faults.server';
import { futuresCall, futuresEvidence, type BrokerOrder, type BrokerPosition, type AlgoOrder } from './binance-futures.server';
import type { FuturesTicket } from './futures';
import {
  isolationProblems, fingerprint, fingerprintChanges, flatProblems, ledgerProblems, fundingMatches, verdict,
  type Fingerprint, type IsolationFacts, type ScenarioId, type ScenarioResult, type Provenance, type BrokerSnapshot,
} from './futures-harness';
type Admin = Awaited<typeof import('@/integrations/supabase/client.server')>['supabaseAdmin'];
type Account = Awaited<ReturnType<typeof import('./futures.server')['loadFuturesAccount']>>;

export interface HarnessConfig {
  testUserId: string; ownerUserId: string; connectionId: string; symbol: string;
  margin: number; leverage: number; slPct: number; tpPct: number; fundingWaitMaxMin: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function harnessConfig(env: Record<string, string | undefined>): HarnessConfig {
  if (env['HARNESS_CONFIRM'] !== 'TESTNET') throw new Error('Set HARNESS_CONFIRM=TESTNET to run the Testnet harness');
  const id = (k: string) => { const v = env[k]; if (!v || !UUID.test(v)) throw new Error(`${k} must be a UUID`); return v; };
  const num = (k: string, d: number) => { const v = Number(env[k] ?? d); if (!Number.isFinite(v) || v <= 0) throw new Error(`${k} must be positive`); return v; };
  const symbol = env['HARNESS_SYMBOL'] ?? 'DOGE/USDT';
  if (!/^[A-Z0-9]{2,16}\/USDT$/.test(symbol)) throw new Error('HARNESS_SYMBOL must look like DOGE/USDT');
  return { testUserId: id('HARNESS_TEST_USER_ID'), ownerUserId: id('HARNESS_OWNER_USER_ID'), connectionId: id('HARNESS_CONNECTION_ID'), symbol,
    margin: num('HARNESS_MARGIN', 2.5), leverage: Math.trunc(num('HARNESS_LEVERAGE', 2)), slPct: num('HARNESS_SL_PCT', 0.4), tpPct: num('HARNESS_TP_PCT', 0.8), fundingWaitMaxMin: num('HARNESS_FUNDING_WAIT_MAX_MIN', 30) };
}

export interface HarnessContext { db: Admin; cfg: HarnessConfig; account: Account; runStartedAt: string }
const must = (r: { data: unknown; error: unknown }, what: string): unknown => { if (r.error || r.data == null) throw new Error(`${what} unavailable`); return r.data; };

export async function isolationFacts(db: Admin, cfg: HarnessConfig): Promise<IsolationFacts> {
  const [roles, conns, auto, elite, limits, risk] = await Promise.all([
    db.from('user_roles').select('role').eq('user_id', cfg.testUserId),
    db.from('exchange_connections').select('id,exchange,is_testnet,status,account_type').eq('user_id', cfg.testUserId),
    db.from('autopilot_settings').select('enabled,live_enabled').eq('user_id', cfg.testUserId).maybeSingle(),
    db.rpc('has_elite_access', { _uid: cfg.testUserId }),
    db.from('futures_settings').select('max_margin,max_leverage,max_loss,live_enabled').eq('user_id', cfg.testUserId).maybeSingle(),
    db.from('risk_settings').select('max_daily_loss,max_open_exposure,trading_halted').eq('user_id', cfg.testUserId).maybeSingle(),
  ]);
  for (const r of [roles, conns, auto, elite, limits, risk]) if (r.error) throw new Error('Isolation evidence unavailable');
  return { testUserId: cfg.testUserId, ownerUserId: cfg.ownerUserId, connectionId: cfg.connectionId,
    testIsAdmin: (roles.data ?? []).some(r => r.role === 'admin' || r.role === 'super_admin'),
    testConnections: conns.data ?? [], autopilot: auto.data, elite: elite.data === true, limits: limits.data, risk: risk.data };
}
/** Hashes of the production owner's records the harness must never change. Only hashes leave this function. */
export async function productionFingerprint(db: Admin, owner: string): Promise<Fingerprint> {
  const [futures, risk, autopilot, conns, creds, certs, runs, prodOrders, prodOpen] = await Promise.all([
    db.from('futures_settings').select('*').eq('user_id', owner),
    db.from('risk_settings').select('*').eq('user_id', owner),
    db.from('autopilot_settings').select('*').eq('user_id', owner),
    db.from('exchange_connections').select('*').eq('user_id', owner).order('id'),
    db.from('connection_credentials').select('connection_id,ciphertext,iv,created_at').eq('user_id', owner).order('connection_id'),
    db.from('futures_certifications').select('*').eq('user_id', owner).order('id'),
    db.from('autopilot_runs').select('id,status,updated_at').eq('user_id', owner).order('id'),
    db.from('orders').select('id,status,updated_at').eq('user_id', owner).eq('execution_environment', 'production').order('id'),
    db.from('positions').select('id,is_open,updated_at').eq('user_id', owner).eq('execution_environment', 'production').order('id'),
  ]);
  const parts: Record<string, unknown> = {};
  for (const [k, r] of Object.entries({ futures, risk, autopilot, conns, creds, certs, runs, prodOrders, prodOpen })) parts[k] = must(r, `Production ${k} fingerprint`);
  return fingerprint(parts);
}

export async function prepareHarness(db: Admin, cfg: HarnessConfig): Promise<HarnessContext> {
  const problems = isolationProblems(await isolationFacts(db, cfg));
  if (problems.length) throw new Error(`Harness refused — isolation not proven: ${problems.join('; ')}`);
  const { loadFuturesAccount } = await import('./futures.server');
  const account = await loadFuturesAccount(db, cfg.testUserId, cfg.connectionId);
  if (account.testnet !== true) throw new Error('Harness refused — connection is not Testnet');
  return { db, cfg, account, runStartedAt: new Date().toISOString() };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sym = (c: HarnessConfig) => c.symbol.replace('/', '');
export function ticket(ctx: HarnessContext, over: Partial<FuturesTicket> = {}): FuturesTicket {
  const c = ctx.cfg;
  return { connectionId: c.connectionId, symbol: c.symbol, side: 'buy', margin: c.margin, leverage: c.leverage, slPct: c.slPct, tpPct: c.tpPct, holdMin: 10, requestId: crypto.randomUUID(), confirmation: 'TESTNET', ...over };
}
export async function open(ctx: HarnessContext, t: FuturesTicket, faults?: FaultPlan) {
  const { openFutures } = await import('./futures.server');
  return openFutures(ctx.db, ctx.cfg.testUserId, t, faults ? { faults } : {});
}
export async function brokerSnapshot(ctx: HarnessContext): Promise<BrokerSnapshot> {
  const a = ctx.account, now = new Date().toISOString();
  const [positions, regular, algo, leases, pending, openPos] = await Promise.all([
    futuresCall<BrokerPosition[]>(a, 'GET', '/fapi/v3/positionRisk'),
    futuresCall<BrokerOrder[]>(a, 'GET', '/fapi/v1/openOrders'),
    futuresCall<AlgoOrder[]>(a, 'GET', '/fapi/v1/openAlgoOrders'),
    ctx.db.from('futures_execution_leases').select('connection_id', { count: 'exact', head: true }).eq('connection_id', a.connectionId).gt('expires_at', now),
    ctx.db.from('orders').select('id', { count: 'exact', head: true }).eq('exchange_connection_id', a.connectionId).in('status', ['pending', 'open', 'partially_filled']),
    ctx.db.from('positions').select('id', { count: 'exact', head: true }).eq('exchange_connection_id', a.connectionId).eq('is_open', true),
  ]);
  for (const r of [leases, pending, openPos]) if (r.error) throw new Error('App state snapshot unavailable');
  return { positions, regularOrders: regular.length, algoOrders: algo.length, activeLeases: leases.count ?? 0, pendingOrders: pending.count ?? 0, openPositions: openPos.count ?? 0 };
}
export async function waitLeaseFree(ctx: HarnessContext, maxMs = 150_000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const r = await ctx.db.from('futures_execution_leases').select('expires_at').eq('connection_id', ctx.cfg.connectionId).gt('expires_at', new Date().toISOString());
    if (!r.error && !(r.data ?? []).length) return;
    await sleep(5000);
  }
  throw new Error('Execution lease did not expire');
}
/** Closes every open harness position through the app's own fenced path, retrying across the settlement window. */
export async function cleanup(ctx: HarnessContext, reason = 'harness_cleanup') {
  const { closeFutures } = await import('./futures.server');
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await ctx.db.from('positions').select('*').eq('user_id', ctx.cfg.testUserId).eq('exchange_connection_id', ctx.cfg.connectionId).eq('is_open', true);
    if (r.error) throw new Error('Open harness positions unavailable');
    if (!r.data.length) return;
    for (const p of r.data) { try { await waitLeaseFree(ctx); await closeFutures(ctx.db, p, reason); } catch (e) { console.error(`cleanup ${p.id}: ${String(e).slice(0, 200)}`); } }
    await sleep(30_000);
  }
}
/** Entry orders (app client IDs start with fv-) the broker received for the symbol since `since`. */
export async function brokerEntries(ctx: HarnessContext, since: number) {
  const all = await futuresCall<(BrokerOrder & { time: number })[]>(ctx.account, 'GET', '/fapi/v1/allOrders', { symbol: sym(ctx.cfg), startTime: since, limit: 1000 });
  return all.filter(o => o.clientOrderId.startsWith('fv-'));
}

export type Rec = { check(name: string, ok: boolean, detail?: string): void; evidence: Record<string, unknown>; plans: FaultPlan[] };
export async function scenario(ctx: HarnessContext, id: ScenarioId, provenance: Provenance[], body: (r: Rec) => Promise<void>): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString(), before = await productionFingerprint(ctx.db, ctx.cfg.ownerUserId);
  const checks: ScenarioResult['checks'] = [], evidence: Record<string, unknown> = {}, plans: FaultPlan[] = [];
  const rec: Rec = { check: (name, ok, detail) => checks.push(detail === undefined ? { name, ok } : { name, ok, detail }), evidence, plans };
  let blocked: string | null = null;
  try { await body(rec); } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.startsWith('BLOCKED:')) blocked = m; else rec.check('scenario ran without an unexpected error', false, m.slice(0, 500));
  }
  try { await cleanup(ctx); } catch (e) { rec.check('cleanup through the app close path', false, String(e).slice(0, 300)); }
  const flat = flatProblems(await brokerSnapshot(ctx));
  rec.check('broker and app flat after scenario', flat.length === 0, flat.join('; ') || undefined);
  const changed = fingerprintChanges(before, await productionFingerprint(ctx.db, ctx.cfg.ownerUserId));
  rec.check('production owner records unchanged', changed.length === 0, changed.join(', ') || undefined);
  if (blocked) evidence['blocked'] = blocked;
  return { id, status: blocked ? 'blocked' : verdict(checks, changed), provenance, startedAt, endedAt: new Date().toISOString(), checks, evidence, productionChanged: changed, faults: plans.flatMap(p => p.events.map(e => ({ plan: p.label, ...e }))) };
}
const errorOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const isEntry = (p: Record<string, string | number>) => String(p['newClientOrderId'] ?? p['origClientOrderId'] ?? '').startsWith('fv-');
async function positionTrade(ctx: HarnessContext, positionId: string) {
  const [pos, trade] = await Promise.all([
    ctx.db.from('positions').select('id,is_open,quantity,futures_details').eq('id', positionId).maybeSingle(),
    ctx.db.from('trades').select('position_id,quantity,realized_pnl,funding_pnl,fees,net_pnl,costs_verified,close_reason,opened_at,closed_at').eq('position_id', positionId).maybeSingle(),
  ]);
  return { position: pos.data, trade: trade.data };
}

// 1. Partial fill — the app must trust only a terminal broker lookup and contain any mismatch reduce-only.
export const partialFill = (ctx: HarnessContext) => scenario(ctx, 'partial_fill', ['injected'], async r => {
  const since = Date.now(), t = ticket(ctx);
  const plan = faultPlan('partial-fill', [{ id: 'entry-lookup-partial', method: 'GET', path: '/fapi/v1/order', when: isEntry, times: 1,
    effect: { kind: 'respond', body: real => { const o = real as BrokerOrder; return { ...o, status: 'EXPIRED', executedQty: String(Number(o.executedQty) / 2) }; } } }]);
  r.plans.push(plan);
  const err = await errorOf(open(ctx, t, plan));
  r.check('entry refused to proceed on a partial terminal fill', !!err && /Partial entry|did not complete/i.test(err), err ?? 'entry completed');
  const entries = await brokerEntries(ctx, since);
  r.check('exactly one entry order reached the broker (no remainder resubmitted)', entries.length === 1, `${entries.length} entry orders`);
  const { position, trade } = await positionTrade(ctx, t.requestId);
  r.check('position was contained and closed', position?.is_open === false, JSON.stringify(position?.futures_details ?? null).slice(0, 300));
  r.check('closed trade records the real broker quantity', !!trade && Math.abs(Number(trade.quantity) - Number(entries[0]?.executedQty ?? NaN)) < 1e-8, trade ? `trade ${trade.quantity} vs broker ${entries[0]?.executedQty}` : 'no trade row');
  r.evidence['entryOrders'] = entries.map(o => ({ orderId: o.orderId, status: o.status, executedQty: o.executedQty }));
  r.evidence['realPartialFill'] = 'not exercised: app entries are MARKET orders; Testnet cannot deterministically produce a real partial fill';
});

// 2. Protection rejection — a real Binance rejection (stop placed on the wrong side) and an injected rejection.
export const protectionRejection = (ctx: HarnessContext) => scenario(ctx, 'protection_rejection', ['real_broker_response_to_injected_input', 'injected'], async r => {
  for (const variant of ['real', 'injected'] as const) {
    const t = ticket(ctx);
    const plan = faultPlan(`protection-${variant}`, [variant === 'real'
      ? { id: 'stop-wrong-side', method: 'POST', path: '/fapi/v1/algoOrder', when: p => p['type'] === 'STOP_MARKET', times: 1,
          effect: { kind: 'mutate', params: p => ({ ...p, triggerPrice: Number(p['triggerPrice']) * (t.side === 'buy' ? 1.05 : 0.95) }) } }
      : { id: 'tp-rejected', method: 'POST', path: '/fapi/v1/algoOrder', when: p => p['type'] === 'TAKE_PROFIT_MARKET', times: 1,
          effect: { kind: 'reject', code: -2021, msg: 'Order would immediately trigger.' } }]);
    r.plans.push(plan);
    const err = await errorOf(open(ctx, t, plan));
    r.check(`${variant}: entry reported failure instead of an unprotected position`, !!err, err ?? 'entry reported success');
    const { position } = await positionTrade(ctx, t.requestId);
    r.check(`${variant}: position flattened reduce-only`, position?.is_open === false, JSON.stringify(position?.futures_details ?? null).slice(0, 300));
    const algos = await futuresCall<AlgoOrder[]>(ctx.account, 'GET', '/fapi/v1/openAlgoOrders', { symbol: sym(ctx.cfg) });
    r.check(`${variant}: no orphan protective order left`, algos.length === 0, `${algos.length} open algo orders`);
    await cleanup(ctx);
  }
});

// 3. Unknown submission status — request sent, response lost; settle by client-ID lookup, never resubmit.
export const unknownSubmission = (ctx: HarnessContext) => scenario(ctx, 'unknown_submission', ['injected'], async r => {
  const since = Date.now(), t = ticket(ctx);
  const plan = faultPlan('unknown-submit', [{ id: 'entry-response-lost', method: 'POST', path: '/fapi/v1/order', when: isEntry, times: 1, effect: { kind: 'drop_response' } }]);
  r.plans.push(plan);
  const err = await errorOf(open(ctx, t, plan));
  r.check('entry settled from broker lookup despite the lost response', err === null, err ?? undefined);
  const entries = await brokerEntries(ctx, since);
  r.check('exactly one entry order exists at the broker', entries.length === 1, `${entries.length} entry orders`);
  const intents = await ctx.db.from('orders').select('id,status,client_order_id').eq('idempotency_key', `futures:${t.requestId}`);
  r.check('exactly one durable entry intent', (intents.data ?? []).length === 1, `${(intents.data ?? []).length} intents`);
  const { position } = await positionTrade(ctx, t.requestId);
  const d = (position?.futures_details ?? {}) as Record<string, unknown>;
  r.check('position reached confirmed protection', d['protection'] === 'confirmed', String(d['protection']));
});

// 4. Isolated kill switch — the TEST account's own emergency stop; production is checked only by fingerprint.
export const isolatedKillSwitch = (ctx: HarnessContext) => scenario(ctx, 'isolated_kill_switch', ['real'], async r => {
  if (ctx.cfg.testUserId === ctx.cfg.ownerUserId) throw new Error('Refusing: kill switch target is the production owner');
  const t = ticket(ctx);
  r.check('test position opened', (await errorOf(open(ctx, t))) === null);
  const { emergencyCloseAll } = await import('./engine.server');
  const stop = await emergencyCloseAll(ctx.cfg.testUserId);
  r.evidence['emergency'] = stop;
  const { position } = await positionTrade(ctx, t.requestId);
  r.check('test position closed by the test account emergency stop (exit path allowed)', position?.is_open === false);
  const risk = await ctx.db.from('risk_settings').select('trading_halted').eq('user_id', ctx.cfg.testUserId).single();
  r.check('test account halted', risk.data?.trading_halted === true);
  const blocked = ticket(ctx), err = await errorOf(open(ctx, blocked));
  r.check('new entry refused while halted', !!err && /halt/i.test(err), err ?? 'entry accepted');
  const claimed = await ctx.db.from('orders').select('id,status').eq('idempotency_key', `futures:${blocked.requestId}`);
  r.check('refused entry never reached submission', (claimed.data ?? []).every(o => o.status === 'cancelled'), JSON.stringify(claimed.data));
  // Clear ONLY the test account's own halt so later scenarios can run; recorded as evidence.
  const reset = await ctx.db.from('risk_settings').update({ trading_halted: false, updated_at: new Date().toISOString() }).eq('user_id', ctx.cfg.testUserId);
  r.check('test account halt cleared after the scenario', !reset.error);
});

// 5. Concurrent requests — same request ID ×3 and two different IDs in parallel.
export const concurrentRequests = (ctx: HarnessContext) => scenario(ctx, 'concurrent_requests', ['real'], async r => {
  const since = Date.now(), same = ticket(ctx), others = [ticket(ctx), ticket(ctx)];
  const results = await Promise.all([same, same, same, ...others].map(t => errorOf(open(ctx, t))));
  r.evidence['outcomes'] = results.map(e => e ?? 'ok');
  const succeeded = results.filter(e => e === null).length;
  const entries = await brokerEntries(ctx, since);
  r.check('broker entries equal successful requests (no duplicates)', entries.length === succeeded, `${entries.length} broker entries, ${succeeded} successes`);
  r.check('at most one entry for the symbol at a time', succeeded <= 1, `${succeeded} succeeded`);
  const dup = await ctx.db.from('orders').select('id').eq('idempotency_key', `futures:${same.requestId}`);
  r.check('repeated request ID created at most one intent', (dup.data ?? []).length <= 1, `${(dup.data ?? []).length} intents`);
});

// 6. Crash/restart — the child process is force-killed by scripts/futures-harness; this verifies recovery afterwards.
export async function recoverAfterCrash(ctx: HarnessContext, label: string, positionId: string, since: number, r: Rec) {
  await waitLeaseFree(ctx);
  const { checkFutures } = await import('./futures.server');
  for (let i = 0; i < 6; i++) {
    const p = await ctx.db.from('positions').select('*').eq('id', positionId).maybeSingle();
    if (!p.data || !p.data.is_open) break;
    const err = await errorOf(checkFutures(ctx.db, p.data));
    if (err) { r.evidence[`${label}:recoveryAttempt${i}`] = err.slice(0, 300); await sleep(30_000); await waitLeaseFree(ctx); }
  }
  const after = await positionTrade(ctx, positionId), entries = await brokerEntries(ctx, since);
  r.check(`${label}: fresh process recovered the position to closed`, !after.position || after.position.is_open === false, JSON.stringify(after.position?.futures_details ?? null).slice(0, 300));
  r.check(`${label}: no entry was replayed after restart`, entries.length <= 1, `${entries.length} broker entries`);
  r.evidence[`${label}:entries`] = entries.map(o => ({ orderId: o.orderId, status: o.status, executedQty: o.executedQty }));
}

// 7. Funding reconciliation — hold a tiny position across the next funding time, then compare with broker income.
export const fundingReconciliation = (ctx: HarnessContext) => scenario(ctx, 'funding_reconciliation', ['real'], async r => {
  const idx = await futuresCall<{ nextFundingTime: number }>(ctx.account, 'GET', '/fapi/v1/premiumIndex', { symbol: sym(ctx.cfg) }, false);
  const wait = idx.nextFundingTime - Date.now();
  if (!(wait > 60_000) || wait > ctx.cfg.fundingWaitMaxMin * 60_000) throw new Error(`BLOCKED: next funding ${new Date(idx.nextFundingTime).toISOString()} is outside the ${ctx.cfg.fundingWaitMaxMin}-minute window; run again closer to it`);
  const t = ticket(ctx, { holdMin: Math.min(240, Math.ceil(wait / 60_000) + 10), slPct: Math.max(ctx.cfg.slPct, 2), tpPct: Math.max(ctx.cfg.tpPct, 4) });
  const err = await errorOf(open(ctx, t));
  r.check('funding position opened', err === null, err ?? undefined);
  await sleep(wait + 120_000);
  const { closeFutures } = await import('./futures.server');
  const p = await ctx.db.from('positions').select('*').eq('id', t.requestId).single();
  if (p.data?.is_open) { await waitLeaseFree(ctx); await closeFutures(ctx.db, p.data, 'harness_funding'); }
  const { trade } = await positionTrade(ctx, t.requestId);
  if (!trade) { r.check('trade finalized', false); return; }
  const ev = await futuresEvidence(ctx.account, sym(ctx.cfg), Date.parse(trade.opened_at), Date.parse(trade.closed_at ?? new Date().toISOString()));
  r.evidence['fundingEvents'] = ev.income.map(e => ({ tranId: e.tranId, income: e.income, time: e.time }));
  r.check('position was open across a funding time (position not closed early)', Date.parse(trade.closed_at ?? '') > idx.nextFundingTime, `closed ${trade.closed_at}`);
  r.check('at least one funding event recorded by Binance', ev.income.length > 0);
  r.check('stored funding equals Binance income history', fundingMatches(trade.funding_pnl, ev.income), `stored ${trade.funding_pnl}`);
  r.check('net = gross + funding − fees', ledgerProblems([trade]).length === 0, ledgerProblems([trade]).join('; ') || undefined);
});

// 8. Final broker state — flat broker and app, released leases, and every harness trade's ledger verified.
export const finalBrokerState = (ctx: HarnessContext) => scenario(ctx, 'final_broker_state', ['real'], async r => {
  const trades = await ctx.db.from('trades').select('position_id,realized_pnl,funding_pnl,fees,net_pnl,costs_verified').eq('exchange_connection_id', ctx.cfg.connectionId).eq('execution_environment', 'testnet').gte('closed_at', ctx.runStartedAt);
  if (trades.error) throw new Error('Harness trade ledger unavailable');
  const problems = ledgerProblems(trades.data);
  r.check('every harness trade ledger reconciles', problems.length === 0, problems.join('; ') || `${trades.data.length} trades`);
  const certs = await ctx.db.from('futures_certifications').select('id', { count: 'exact', head: true }).eq('user_id', ctx.cfg.testUserId);
  r.check('harness created no certification records', !certs.error && certs.count === 0);
  r.evidence['tradesChecked'] = trades.data.length;
});

export const SCENARIO_RUNNERS = { partial_fill: partialFill, protection_rejection: protectionRejection, unknown_submission: unknownSubmission,
  isolated_kill_switch: isolatedKillSwitch, concurrent_requests: concurrentRequests, funding_reconciliation: fundingReconciliation, final_broker_state: finalBrokerState } as const;
