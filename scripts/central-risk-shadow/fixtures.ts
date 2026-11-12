// Phase 4B offline shadow-evaluation artifact. Synthetic account state (fake SELECT-only tables — no project database
// is read) plus, for the "today's real sources" scenario, credential-free public Binance mark price and exchangeInfo.
// No orders, credentials, AI or writes. Usage: bun scripts/central-risk-shadow/fixtures.ts
import { writeFileSync } from "node:fs";
import { createShadowLog, SHADOW_SOURCE_MATRIX, type ShadowTicket } from "../../src/lib/central-risk-shadow";
import { runShadowEvaluation, shadowReadPorts } from "../../src/lib/central-risk-shadow.server";
import { selectOnly, type RiskReadPorts } from "../../src/lib/central-risk-context.server";

type Tables = Record<string, { data?: unknown; error?: unknown; count?: number }>;
function fakeDb(tables: Tables) {
  return { from(t: string) {
    const res = tables[t] ?? { data: null, error: null, count: 0 }, chain: Record<string, unknown> = {};
    for (const m of ["eq", "in", "gte"]) chain[m] = () => chain;
    chain["maybeSingle"] = () => Promise.resolve({ data: res.data ?? null, error: res.error ?? null });
    chain["then"] = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: res.data ?? null, error: res.error ?? null, count: res.count ?? null }).then(ok, bad);
    return { select: () => chain };
  } };
}
const NOW = Date.now(), USER = "00000000-0000-4000-8000-000000000001";
const LIVE = { connectionId: "11111111-1111-4111-8111-111111111111", testnet: false }, TESTNET = { connectionId: "22222222-2222-4222-8222-222222222222", testnet: true };
const GOOD: Tables = {
  risk_settings: { data: { max_daily_loss: 50, max_open_exposure: 2000, max_total_positions: 3, trading_halted: false } },
  futures_settings: { data: { max_leverage: 10, max_loss: 10, max_margin: 100 } },
  strategy_risk_budgets: { error: { message: "relation \"strategy_risk_budgets\" does not exist (draft 0045 not applied)" } },
  positions: { data: [] }, orders: { count: 0 }, trades: { data: [] },
};
const ticket = (x: Partial<ShadowTicket> = {}): ShadowTicket => ({ connectionId: LIVE.connectionId, symbol: "BTC/USDT", side: "buy", margin: 20, leverage: 5, slPct: 1, tpPct: 2, requestId: crypto.randomUUID(), confirmation: "LIVE", ...x });
const full = (t: Tables, o: Partial<RiskReadPorts> = {}): RiskReadPorts => ({ db: selectOnly(fakeDb(t)), now: () => NOW, markPrice: async () => ({ markPrice: 100_000, time: NOW - 500 }), symbolRules: async () => ({ stepSize: 0.001, minNotional: 100, maintenanceMarginRate: 0.004 }), availableMargin: async () => 500, strategyUsedLoss: async () => 0, ...o });
const withBudget = { ...GOOD, strategy_risk_budgets: { data: { max_loss: 30 } } };

const log = createShadowLog();
const scenarios: [string, Promise<ReturnType<typeof runShadowEvaluation> extends Promise<infer R> ? R : never>][] = [
  ["today's real sources (Live; public mark + lot rules; synthetic account rows)", runShadowEvaluation({ ports: shadowReadPorts({ db: fakeDb(GOOD), account: LIVE, now: () => Date.now() }), userId: USER, account: LIVE, ticket: ticket() })],
  ["today's real sources (Testnet; no Testnet market source)", runShadowEvaluation({ ports: shadowReadPorts({ db: fakeDb(GOOD), account: TESTNET, now: () => NOW }), userId: USER, account: TESTNET, ticket: ticket({ connectionId: TESTNET.connectionId, confirmation: "TESTNET" }) })],
  ["hypothetical: all four blocked sources present", runShadowEvaluation({ ports: full(withBudget), userId: USER, account: LIVE, ticket: ticket(), proposalCreatedAt: NOW - 1000 })],
  ["hypothetical: emergency stop on", runShadowEvaluation({ ports: full({ ...withBudget, risk_settings: { data: { ...(GOOD["risk_settings"]!.data as object), trading_halted: true } } }), userId: USER, account: LIVE, ticket: ticket(), proposalCreatedAt: NOW - 1000 })],
  ["hypothetical: stale mark price (60 s)", runShadowEvaluation({ ports: full(withBudget, { markPrice: async () => ({ markPrice: 100_000, time: NOW - 60_000 }) }), userId: USER, account: LIVE, ticket: ticket(), proposalCreatedAt: NOW - 1000 })],
  ["environment label mismatch (LIVE ticket on Testnet connection)", runShadowEvaluation({ ports: full(withBudget), userId: USER, account: TESTNET, ticket: ticket({ connectionId: TESTNET.connectionId, confirmation: "LIVE" }) })],
];
const rows = [];
for (const [name, p] of scenarios) { const r = await p; log.append(r); rows.push({ scenario: name, verdict: r.verdict, failedChecks: r.failedChecks.map((c) => c.id), missingInputs: r.missingInputs, proposedLeverage: r.proposedLeverage, proposedLiquidationBufferPct: r.proposedLiquidationBufferPct, ticketComparison: r.ticketComparison, marketDataTimestamp: r.marketDataTimestamp, contextSnapshotHash: r.contextSnapshotHash, executionAuthorized: r.executionAuthorized, affectsOrderPath: r.affectsOrderPath, reads: r.reads }); }
writeFileSync("docs/evaluation/phase4b-shadow-fixtures.json", JSON.stringify({ generatedAt: new Date().toISOString(), note: "Synthetic account rows; no project database read; nothing persisted beyond this file.", sourceMatrix: SHADOW_SOURCE_MATRIX, summary: log.summary(), rows }, null, 1));
for (const r of rows) console.log(r.verdict.padEnd(18), r.scenario, "| missing:", r.missingInputs.join(","), "| failed:", r.failedChecks.join(","));
