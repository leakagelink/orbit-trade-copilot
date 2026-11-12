// Historical REPLAY of the Futures paper engine on real public Binance USD-M data (trade, mark and index klines plus
// funding) for BTCUSDT and ETHUSDT. Exercises sizing by the Central Risk Engine, funding, liquidation checks, partial
// fills and reconciliation end to end. This is a replay of the past, NOT forward paper trading, and nothing is stored.
// Usage: bun scripts/scalp-eval/futures-paper-replay.ts [days=14]
import { writeFileSync } from "node:fs";
import { aggregateCandles, DEFAULT_INTRADAY, intradayFeatures, intradaySignal } from "../../src/lib/scalp-intraday";
import { fromIntraday } from "../../src/lib/central-risk-proposals";
import { initialFuturesPaperState, reconcileFuturesPaper, stepFuturesPaper, FuturesPaperDataError, type FPBar, type FPConfig, type FPEvent, type FPTrade } from "../../src/lib/futures-paper-engine";
import { publicFuturesGet, publicSymbolRules } from "../../src/lib/futures-public-market.server";
import type { Candle } from "../../src/lib/indicators";

const DAYS = Number(process.argv[2] ?? 14), SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const, M = 60_000, TF = 5 * M, D = 86_400_000;
const end = Math.floor(Date.now() / D) * D, start = end - DAYS * D;
// Maintenance-margin rates are ASSUMPTIONS (first bracket); the real values need the signed leverage-bracket endpoint.
const ASSUMED_MMR: Record<string, number> = { BTCUSDT: 0.004, ETHUSDT: 0.005 };

async function series(path: string, symbol: string, key: "symbol" | "pair"): Promise<Candle[]> {
  const out: Candle[] = []; let from = start;
  while (from < end) {
    const rows = await publicFuturesGet<unknown[][]>(path, { [key]: symbol, interval: "1m", startTime: from, endTime: end - 1, limit: 1500 });
    if (!rows.length) break;
    for (const k of rows) out.push({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) || 0 });
    from = Number(rows.at(-1)![0]) + M;
  }
  return out.filter((c) => c.t >= start && c.t < end);
}
async function funding(symbol: string) { return (await publicFuturesGet<{ fundingTime: number; fundingRate: string }[]>("/fapi/v1/fundingRate", { symbol, startTime: start, endTime: end, limit: 1000 })).map((x) => ({ t: x.fundingTime, rate: Number(x.fundingRate) })); }

const specs: FPConfig["specs"] = {};
const data: Record<string, { trade: Candle[]; mark: Map<number, Candle>; index: Map<number, Candle>; funding: { t: number; rate: number }[] }> = {};
for (const s of SYMBOLS) {
  const rules = await publicSymbolRules(s); if (!rules) throw new Error(`${s}: exchangeInfo unavailable`);
  specs[s] = { stepSize: rules.stepSize, tickSize: rules.tickSize, minNotional: rules.minNotional, maintenanceMarginRate: ASSUMED_MMR[s]! };
  const [trade, mark, index, fund] = await Promise.all([series("/fapi/v1/klines", s, "symbol"), series("/fapi/v1/markPriceKlines", s, "symbol"), series("/fapi/v1/indexPriceKlines", s, "pair"), funding(s)]);
  data[s] = { trade: aggregateCandles(trade, M, 5), mark: new Map(aggregateCandles(mark, M, 5).map((c) => [c.t, c])), index: new Map(aggregateCandles(index, M, 5).map((c) => [c.t, c])), funding: fund };
}
const cfg: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 3,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: 1 },
  specs, strategyBudgets: { "futures-scalp-intraday": 50 },
  // PAPER-ONLY limits for this replay. They are not, and do not change, any production or Testnet limit.
  limits: { maxExposure: 2000, maxDailyLoss: 20, maxPositions: 2, maxLossPerTrade: 5, maxMarginPerTrade: 100, maxLeverage: 10, liquidationBufferPct: 2, maxDataAgeMs: TF, maxProposalAgeMs: TF, roundTripCostPct: 0.13 },
};
const icfg = { ...DEFAULT_INTRADAY, htfMultiple: 3 };
const feats = Object.fromEntries(SYMBOLS.map((s) => [s, intradayFeatures(data[s]!.trade, TF, icfg)]));
let state = initialFuturesPaperState(cfg.startingBalance);
const events: FPEvent[] = [], trades: FPTrade[] = [], rejections: Record<string, number> = {}; let accepted = 0, pausedBars = 0;
const times = [...new Set(SYMBOLS.flatMap((s) => data[s]!.trade.map((c) => c.t)))].sort((a, b) => a - b);
const idx = Object.fromEntries(SYMBOLS.map((s) => [s, new Map(data[s]!.trade.map((c, i) => [c.t, i]))]));
const marks: Record<string, number> = {};
for (const t of times) for (const s of SYMBOLS) {
  const i = idx[s]!.get(t); if (i === undefined) continue;
  const c = data[s]!.trade[i]!, mk = data[s]!.mark.get(t) ?? null, ix = data[s]!.index.get(t) ?? null;
  const bar: FPBar = { symbol: s, t, tfMs: TF, trade: c, mark: mk, index: ix ? { c: ix.c } : null, funding: data[s]!.funding.filter((f) => f.t >= t && f.t < t + TF) };
  const sig = i > 0 ? intradaySignal(data[s]!.trade, i, feats[s]!, icfg) : null;
  const a = sig ? fromIntraday(sig, { proposalId: `replay-${s}-${t}`, strategyId: "futures-scalp-intraday", symbol: s, market: "usdm_futures", environment: "paper", createdAt: t + TF }) : null;
  try {
    const r = stepFuturesPaper(state, cfg, bar, a?.proposal ? [{ proposal: a.proposal, maxHoldBars: icfg.maxHoldBars }] : [], marks);
    state = r.state; events.push(...r.events); trades.push(...r.trades); marks[s] = mk!.c;
    for (const e of r.events) if (e.kind === "order_accepted") accepted++;
    for (const d of r.decisions) if (d.verdict !== "ACCEPT") for (const c of d.checks) if (c.status === "fail" || c.status === "missing") rejections[`${d.verdict}:${c.id}`] = (rejections[`${d.verdict}:${c.id}`] ?? 0) + 1;
    for (const e of r.events) if (e.kind === "order_rejected" && !r.decisions.length) rejections[`refused:${e.reason.slice(0, 40)}`] = (rejections[`refused:${e.reason.slice(0, 40)}`] ?? 0) + 1;
  } catch (e) { if (e instanceof FuturesPaperDataError) pausedBars++; else throw e; }
}
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
const out = {
  generatedAt: new Date().toISOString(), kind: "historical replay of the Futures paper engine (not forward paper trading, nothing stored)",
  period: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), days: DAYS, timeframe: "5m" }, specs, assumptions: { maintenanceMarginRate: "first-bracket assumption per symbol, not read from the exchange", fees: "taker 0.05% list price, not account-verified", limits: "paper-only replay limits", fills: "volume participation cap 1% of each 5m candle" },
  config: cfg, barsPausedForMissingData: pausedBars, accepted, rejections,
  trades: trades.length, bySymbol: Object.fromEntries(SYMBOLS.map((s) => [s, trades.filter((t) => t.symbol === s).length])), byReason: Object.fromEntries(["stop", "target", "time", "liquidation"].map((k) => [k, trades.filter((t) => t.reason === k).length])),
  partialFillEvents: events.filter((e) => e.kind === "entry_fill" && e.reason.startsWith("partial")).length, cancelledRemainders: events.filter((e) => e.kind === "entry_cancelled").length,
  fundingEvents: events.filter((e) => e.kind === "funding").length, fundingTotal: sum(events.filter((e) => e.kind === "funding").map((e) => e.walletDelta)),
  feesTotal: sum(events.map((e) => e.fee)), netTotal: sum(trades.map((t) => t.net)), endingWallet: state.wallet, openPositions: Object.keys(state.positions),
  reconciliation: reconcileFuturesPaper(state, events, cfg.startingBalance), note: "Simulated from public candles. Not evidence of future profit.",
};
const file = `docs/evaluation/futures-paper-replay-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, config: undefined, specs: undefined }, null, 1).slice(0, 3000));
