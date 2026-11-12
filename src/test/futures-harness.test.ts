// Offline checks of the Phase 1.6 harness: fault injection is Testnet-only and labelled, isolation refuses unsafe setups,
// and a scenario can only pass when the production fingerprint is unchanged. No network or database access.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { futuresCall } from '@/lib/binance-futures.server';
import { faultPlan, INJECTED } from '@/lib/futures-faults.server';
import { isolationProblems, fingerprint, fingerprintChanges, flatProblems, ledgerProblems, fundingMatches, verdict, type IsolationFacts } from '@/lib/futures-harness';
import { harnessConfig } from '@/lib/futures-harness.server';

const creds = { apiKey: 'k', apiSecret: 's' } as never;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe('Testnet fault injection', () => {
  it('refuses any fault plan on a production account before sending anything', async () => {
    const fetch = vi.fn(async () => ok({})); vi.stubGlobal('fetch', fetch);
    const faults = faultPlan('p', []);
    await expect(futuresCall({ testnet: false, creds, faults }, 'GET', '/fapi/v1/order')).rejects.toThrow(/Testnet-only/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('injected rejection is never sent and is labelled as injected', async () => {
    const fetch = vi.fn(async () => ok({})); vi.stubGlobal('fetch', fetch);
    const faults = faultPlan('r', [{ id: 'x', method: 'POST', path: '/fapi/v1/algoOrder', effect: { kind: 'reject', code: -2021, msg: 'nope' } }]);
    await expect(futuresCall({ testnet: true, creds, faults }, 'POST', '/fapi/v1/algoOrder')).rejects.toThrow(INJECTED);
    expect(fetch).not.toHaveBeenCalled();
    expect(faults.events[0]).toMatchObject({ rule: 'x', sent: false });
  });
  it('lost response is sent exactly once, then reported as a timeout; later calls are untouched', async () => {
    const fetch = vi.fn(async () => ok({ status: 'FILLED' })); vi.stubGlobal('fetch', fetch);
    const faults = faultPlan('d', [{ id: 'drop', method: 'POST', path: '/fapi/v1/order', times: 1, effect: { kind: 'drop_response' } }]);
    await expect(futuresCall({ testnet: true, creds, faults }, 'POST', '/fapi/v1/order')).rejects.toThrow(/TimeoutError/);
    await expect(futuresCall({ testnet: true, creds, faults }, 'POST', '/fapi/v1/order')).resolves.toEqual({ status: 'FILLED' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(faults.events).toHaveLength(1);
  });
  it('mutated input really reaches the broker with the altered value', async () => {
    const fetch = vi.fn(async (_url: string) => ok({})); vi.stubGlobal('fetch', fetch);
    const faults = faultPlan('m', [{ id: 'm', method: 'POST', path: '/fapi/v1/algoOrder', effect: { kind: 'mutate', params: p => ({ ...p, triggerPrice: 9 }) } }]);
    await futuresCall({ testnet: true, creds, faults }, 'POST', '/fapi/v1/algoOrder', { triggerPrice: 1 });
    expect(String(fetch.mock.calls[0]![0])).toContain('triggerPrice=9');
    expect(String(fetch.mock.calls[0]![0])).toContain('testnet.binancefuture.com');
  });
  it('without a plan the call is unchanged', async () => {
    const fetch = vi.fn(async () => ok({ a: 1 })); vi.stubGlobal('fetch', fetch);
    await expect(futuresCall({ testnet: false, creds }, 'GET', '/fapi/v1/premiumIndex', {}, false)).resolves.toEqual({ a: 1 });
  });
});

const good: IsolationFacts = {
  testUserId: 't', ownerUserId: 'o', connectionId: 'c', testIsAdmin: false,
  testConnections: [{ id: 'c', exchange: 'binance', is_testnet: true, status: 'connected', account_type: 'futures' }],
  autopilot: { enabled: false, live_enabled: false }, elite: true,
  limits: { max_margin: 5, max_leverage: 2, max_loss: 2, live_enabled: false },
  risk: { max_daily_loss: 2, max_open_exposure: 10, max_total_positions: 1, trading_halted: false },
};
describe('owner-stated test-account limits', () => {
  it('requires 5 USDT margin', () => expect(isolationProblems({ ...good, limits: { ...good.limits!, max_margin: 6 } })).toContain('Margin per trade (USDT) must be 5 (found 6)'));
  it('requires a 2 USDT per-trade loss reserve', () => expect(isolationProblems({ ...good, limits: { ...good.limits!, max_loss: 3 } })).toContain('Per-trade loss reserve (USDT) must be 2 (found 3)'));
  it('requires a 2 USDT daily loss limit', () => expect(isolationProblems({ ...good, risk: { ...good.risk!, max_daily_loss: 5 } })).toContain('Daily loss limit (USDT) must be 2 (found 5)'));
  it('requires 10 USDT maximum exposure', () => expect(isolationProblems({ ...good, risk: { ...good.risk!, max_open_exposure: 20 } })).toContain('Maximum exposure (USDT) must be 10 (found 20)'));
  it('requires exactly one open position', () => expect(isolationProblems({ ...good, risk: { ...good.risk!, max_total_positions: 2 } })).toContain('Open positions must be 1 (found 2)'));
  it('allows up to 10x leverage and refuses 11x', () => {
    expect(isolationProblems({ ...good, limits: { ...good.limits!, max_leverage: 10 } })).toEqual([]);
    expect(isolationProblems({ ...good, limits: { ...good.limits!, max_leverage: 11 } })).toContain('Leverage must be between 1x and 10x (found 11)');
  });
});
describe('harness isolation', () => {
  it('accepts a dedicated, Testnet-only, limited test account', () => expect(isolationProblems(good)).toEqual([]));
  it('refuses the production owner as the test account', () => expect(isolationProblems({ ...good, testUserId: 'o' })).toContain('Dedicated test account must differ from the production owner'));
  it('refuses a test account that also owns a production connection', () =>
    expect(isolationProblems({ ...good, testConnections: [...good.testConnections, { id: 'p', exchange: 'binance', is_testnet: false, status: 'connected', account_type: 'futures' }] })).toContain('Test account owns a production or non-Testnet connection'));
  it('refuses a production connection as the target', () =>
    expect(isolationProblems({ ...good, testConnections: [{ ...good.testConnections[0]!, is_testnet: false }] })).toContain('Selected connection must be Binance Futures Testnet'));
  it('refuses admin role, Autopilot ON, Live ON, missing limits and missing Elite', () => {
    expect(isolationProblems({ ...good, testIsAdmin: true })).toHaveLength(1);
    expect(isolationProblems({ ...good, autopilot: { enabled: true, live_enabled: false } })).toContain('Test account Autopilot must be OFF');
    expect(isolationProblems({ ...good, limits: { ...good.limits!, live_enabled: true } })).toContain('Test account Live Futures must stay OFF');
    expect(isolationProblems({ ...good, limits: null })).toContain('Owner-stated Testnet Futures limits are missing');
    expect(isolationProblems({ ...good, elite: false })).toContain('Test account needs Elite access for Futures entries');
  });
  it('requires explicit TESTNET confirmation and UUIDs', () => {
    expect(() => harnessConfig({})).toThrow(/HARNESS_CONFIRM=TESTNET/);
    expect(() => harnessConfig({ HARNESS_CONFIRM: 'TESTNET', HARNESS_TEST_USER_ID: 'x' })).toThrow(/UUID/);
  });
});

describe('harness verdicts', () => {
  it('detects any change in production records', async () => {
    const a = await fingerprint({ risk: [{ trading_halted: false }], futures: [{ live_enabled: false }] });
    const b = await fingerprint({ risk: [{ trading_halted: true }], futures: [{ live_enabled: false }] });
    expect(fingerprintChanges(a, a)).toEqual([]);
    expect(fingerprintChanges(a, b)).toEqual(['risk']);
  });
  it('fails a scenario whose checks pass if production changed', () => {
    expect(verdict([{ name: 'x', ok: true }], [])).toBe('pass');
    expect(verdict([{ name: 'x', ok: true }], ['risk'])).toBe('fail');
    expect(verdict([], [])).toBe('fail');
  });
  it('treats any exposure, order, lease or pending intent as not flat', () => {
    const flat = { positions: [{ symbol: 'DOGEUSDT', positionAmt: '0' }], regularOrders: 0, algoOrders: 0, activeLeases: 0, pendingOrders: 0, openPositions: 0 };
    expect(flatProblems(flat)).toEqual([]);
    expect(flatProblems({ ...flat, positions: [{ symbol: 'DOGEUSDT', positionAmt: '76' }] })).toHaveLength(1);
    expect(flatProblems({ ...flat, algoOrders: 1, activeLeases: 1 })).toHaveLength(2);
  });
  it('requires net = gross + funding − fees and broker-matching funding', () => {
    expect(ledgerProblems([{ position_id: 'p', realized_pnl: 0.1, funding_pnl: -0.01, fees: 0.02, net_pnl: 0.07, costs_verified: true }])).toEqual([]);
    expect(ledgerProblems([{ position_id: 'p', realized_pnl: 0.1, funding_pnl: -0.01, fees: 0.02, net_pnl: 0.08, costs_verified: true }])).toHaveLength(1);
    expect(fundingMatches(-0.003, [{ income: '-0.001' }, { income: '-0.002' }])).toBe(true);
    expect(fundingMatches(null, [{ income: '-0.001' }])).toBe(false);
  });
});

describe('Phase 1.6 read-only preflight rules', () => {
  const safe = { autopilotOn: 0, futuresLiveOn: 0, passCertifications: 0, productionPendingOrders: 0, productionOpenFutures: 0, activeLeases: 0 };
  it('production is safe only with Autopilot OFF, Live Futures OFF, no PASS and nothing open', async () => {
    const { productionSafetyProblems } = await import('@/lib/futures-harness');
    expect(productionSafetyProblems(safe)).toEqual([]);
    expect(productionSafetyProblems({ ...safe, autopilotOn: 1 })).toHaveLength(1);
    expect(productionSafetyProblems({ ...safe, futuresLiveOn: 1 })).toHaveLength(1);
    expect(productionSafetyProblems({ ...safe, passCertifications: 1 })).toHaveLength(1);
    expect(productionSafetyProblems({ ...safe, productionOpenFutures: 1, productionPendingOrders: 1 })).toHaveLength(2);
  });
  it('allows only GET reads of account state, never order or settings endpoints', async () => {
    const { assertReadOnlyCall } = await import('@/lib/futures-harness');
    expect(() => assertReadOnlyCall('GET', '/fapi/v3/account')).not.toThrow();
    expect(() => assertReadOnlyCall('POST', '/fapi/v1/order')).toThrow(/refused/);
    expect(() => assertReadOnlyCall('GET', '/fapi/v1/order')).toThrow(/refused/);
    expect(() => assertReadOnlyCall('POST', '/fapi/v1/leverage')).toThrow(/refused/);
    expect(() => assertReadOnlyCall('DELETE', '/fapi/v1/allOpenOrders')).toThrow(/refused/);
  });
});
