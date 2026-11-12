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
  risk: { max_daily_loss: 2, max_open_exposure: 10, trading_halted: false },
};
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
