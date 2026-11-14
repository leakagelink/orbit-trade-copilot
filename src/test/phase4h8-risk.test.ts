// Phase 4H.8 — Central Risk Engine integration: the only path from a live signal to a paper order.
import { describe, expect, it } from "vitest";
import { evaluateProposal } from "@/lib/central-risk";
import { FeedEngine } from "@/lib/live-feed";
import { newPaperState, parseExchangeFilters, type SymbolFilters } from "@/lib/live-paper-exec";
import { buildPaperRiskContext, EMPTY_PAPER_RISK, evaluateSignalRisk, OWNER_PROPOSED_PAPER_VALUES, signalToProposal, TESTNET_PRESET, type PaperRiskConfig, type PaperRiskInputs } from "@/lib/live-scalp-risk";
import { LiveScalpPipeline } from "@/lib/live-scalp-pipeline";
import type { LiveSignal } from "@/lib/live-scalp-signal";
import { recorded } from "./helpers/recorded-usdm";

const F = (sym: string): SymbolFilters => parseExchangeFilters(recorded().exchangeInfo.symbols.find((s) => (s as { symbol: string }).symbol === sym))!;
const NOW = 5_000_000;
const sig = (o: Partial<LiveSignal> = {}): LiveSignal => ({ id: "futures-scalp-live:live-scalp-v1:ETHUSDT:4980000", strategyId: "futures-scalp-live", strategyVersion: "live-scalp-v1", featureVersion: "live-scalp-features-v1", symbol: "ETHUSDT", action: "LONG", decidedAt: NOW, decisionCandleT: 4_980_000, expiresAt: NOW + 15_000, validation: "UNVALIDATED", entryReference: 1900.1, stopReference: 1890, takeProfitReference: 1915, costs: null, confidence: { score: 1, agreeing: 8, total: 8, calibration: "UNCALIBRATED", label: "x" }, freshness: {} as never, features: {}, reasons: [], rejections: [], ...o });
const LIMITS: PaperRiskConfig = { ...EMPTY_PAPER_RISK, ...OWNER_PROPOSED_PAPER_VALUES, maxExposure: 5_000, maxDailyLoss: 50, maxPositions: 2, maxLossPerTrade: 5, maxMarginPerTrade: 200, maxLeverage: 10, strategyBudget: 20 };
const inputs = (o: Partial<PaperRiskInputs> = {}): PaperRiskInputs => ({ now: NOW, state: newPaperState("r", 10_000, 1), limits: LIMITS, filters: F("ETHUSDT"), mark: { kind: "mark", symbol: "ETHUSDT", markPrice: 1900, indexPrice: 1900, fundingRate: 0.0001, nextFundingTime: NOW + 3_600_000, E: NOW - 500, receivedAt: NOW - 400 }, marks: { ETHUSDT: 1900 }, killSwitch: false, strategyUsedLoss: 0, evaluated: new Set(), ...o });
const failed = (r: ReturnType<typeof evaluateSignalRisk>) => r.decision!.checks.filter((c) => c.status === "fail").map((c) => c.id);

describe("owner values are shown separately and never invented", () => {
  it("owner-proposed paper values and the Testnet preset carry exactly the owner's numbers", () => {
    expect(OWNER_PROPOSED_PAPER_VALUES).toEqual({ liquidationBufferPct: 5, maxDataAgeMs: 5_000, maxProposalAgeMs: 60_000, roundTripCostPct: 0.13 });
    expect(TESTNET_PRESET).toEqual({ maxMarginPerTrade: 5, maxLossPerTrade: 2, maxDailyLoss: 2, maxExposure: 10, maxPositions: 1, maxLeverage: 10 });
    expect(Object.values(EMPTY_PAPER_RISK).every((v) => v === null)).toBe(true);
  });
  it("with no limits entered the engine answers INSUFFICIENT_DATA and sizes nothing", () => {
    const r = evaluateSignalRisk(sig(), inputs({ limits: { ...EMPTY_PAPER_RISK } }));
    expect(r.decision!.verdict).toBe("INSUFFICIENT_DATA"); expect(r.decision!.sizing).toBeNull();
  });
});

describe("signal → proposal carries no size, leverage or authority", () => {
  it("only LONG/SHORT become proposals; environment paper; strict schema has no size fields", () => {
    expect(signalToProposal(sig({ action: "NO_TRADE" }))).toBeNull(); expect(signalToProposal(sig({ action: "INSUFFICIENT_DATA" }))).toBeNull();
    const p = signalToProposal(sig())!;
    expect(p).toMatchObject({ environment: "paper", market: "usdm_futures", side: "LONG", proposalId: sig().id });
    expect(Object.keys(p).sort()).toEqual(["createdAt", "engine", "environment", "market", "proposalId", "referencePrice", "side", "stopPrice", "strategyId", "symbol", "takeProfitPrice"]);
  });
  it("an injected quantity/leverage/authorization (e.g. from an AI) is refused by the strict schema", () => {
    const p = { ...signalToProposal(sig())!, quantity: 50, leverage: 125, executionAuthorized: true };
    const d = evaluateProposal(p, buildPaperRiskContext("ETHUSDT", p.proposalId, inputs()));
    expect(d.verdict).toBe("REJECT"); expect(d.checks[0]!.id).toBe("proposal_schema"); expect(d.sizing).toBeNull();
  });
  it("extra fields on the signal object never reach sizing", () => {
    const a = evaluateSignalRisk(sig(), inputs()), b = evaluateSignalRisk({ ...sig(), qty: 99, leverage: 125 } as LiveSignal, inputs());
    expect(b.decision!.sizing).toEqual(a.decision!.sizing);
  });
});

describe("Central Risk controls", () => {
  it("ACCEPT sizes from the stop distance, costs and limits; leverage ≤ max; liquidation buffer respected", () => {
    const d = evaluateSignalRisk(sig(), inputs()).decision!;
    expect(d.verdict).toBe("ACCEPT"); expect(d.executionAuthorized).toBe(false);
    expect(d.sizing!.leverage).toBeLessThanOrEqual(10); expect(d.sizing!.riskAmount).toBeLessThanOrEqual(5 + 1e-9);
    expect(d.sizing!.margin).toBeLessThanOrEqual(200 + 1e-9);
  });
  it("stale mark price → REJECT (market_data)", () => { expect(failed(evaluateSignalRisk(sig(), inputs({ mark: { ...inputs().mark!, receivedAt: NOW - 6_000 } })))).toContain("market_data"); });
  it("missing mark → INSUFFICIENT_DATA", () => { expect(evaluateSignalRisk(sig(), inputs({ mark: null })).decision!.verdict).toBe("INSUFFICIENT_DATA"); });
  it("emergency stop on → REJECT; unknown → INSUFFICIENT_DATA", () => {
    expect(failed(evaluateSignalRisk(sig(), inputs({ killSwitch: true })))).toContain("emergency_stop");
    expect(evaluateSignalRisk(sig(), inputs({ killSwitch: null })).decision!.verdict).toBe("INSUFFICIENT_DATA");
  });
  it("expired signal is not evaluated; stale proposal age → REJECT", () => {
    expect(evaluateSignalRisk(sig(), inputs({ now: NOW + 16_000 }))).toMatchObject({ decision: null, skipped: "signal expired before evaluation" });
    expect(failed(evaluateSignalRisk(sig({ expiresAt: NOW + 120_000 }), inputs({ now: NOW + 61_000, mark: { ...inputs().mark!, receivedAt: NOW + 60_900 } })))).toContain("proposal_fresh");
  });
  it("daily loss reached, strategy budget used, position limit and duplicate proposal → REJECT", () => {
    const st = newPaperState("r", 10_000, 1); st.day.startEquity = 10_060;
    expect(failed(evaluateSignalRisk(sig(), inputs({ state: st })))).toContain("daily_loss");
    expect(failed(evaluateSignalRisk(sig(), inputs({ strategyUsedLoss: 20 })))).toContain("strategy_budget");
    expect(failed(evaluateSignalRisk(sig(), inputs({ limits: { ...LIMITS, maxPositions: 0 } })))).toContain("position_count");
    expect(failed(evaluateSignalRisk(sig(), inputs({ evaluated: new Set([sig().id]) })))).toContain("duplicate");
  });
  it("the owner's Testnet limits cannot size a BTCUSDT trade above the real 50 USDT minimum", () => {
    const btc = sig({ id: "futures-scalp-live:live-scalp-v1:BTCUSDT:1", symbol: "BTCUSDT", entryReference: 67_000, stopReference: 66_800, takeProfitReference: 67_300 });
    const r = evaluateSignalRisk(btc, inputs({ limits: { ...EMPTY_PAPER_RISK, ...OWNER_PROPOSED_PAPER_VALUES, ...TESTNET_PRESET, strategyBudget: 2 }, filters: F("BTCUSDT"), mark: { ...inputs().mark!, symbol: "BTCUSDT", markPrice: 67_000 }, marks: { BTCUSDT: 67_000 } }));
    expect(r.decision!.verdict).toBe("REJECT"); expect(failed(r)).toContain("min_notional");
  });
});

describe("pipeline: sizing reaches the paper order unchanged", () => {
  const engineWithBook = () => {
    const e = new FeedEngine(["ETHUSDT"]);
    e.ingest(JSON.stringify({ stream: "ethusdt@depth@100ms", data: { e: "depthUpdate", E: NOW - 300, T: NOW - 300, s: "ETHUSDT", U: 95, u: 105, pu: 94, b: [], a: [] } }), NOW - 300);
    e.applySnapshot("ETHUSDT", { lastUpdateId: 100, bids: [["1900", "50"], ["1899.9", "50"]], asks: [["1900.1", "50"], ["1900.2", "50"]] }, NOW - 250);
    e.ingest(JSON.stringify({ stream: "ethusdt@markPrice@1s", data: { e: "markPriceUpdate", E: NOW - 500, s: "ETHUSDT", p: "1900", i: "1900", r: "0.0001", T: NOW + 3_600_000 } }), NOW - 400);
    return e;
  };
  it("auto-paper ON: ACCEPT → paper MARKET order with exactly the engine's qty and leverage", () => {
    const p = new LiveScalpPipeline(engineWithBook(), newPaperState("p", 10_000, 1), { limits: LIMITS, filters: { ETHUSDT: F("ETHUSDT") }, autoPaper: true, killSwitch: false }, () => NOW);
    const rec = p.act(sig(), NOW)!, d = evaluateSignalRisk(sig(), inputs()).decision!;
    expect(rec.verdict).toBe("ACCEPT"); expect(rec.qty).toBe(d.sizing!.qty); expect(rec.leverage).toBe(d.sizing!.leverage);
    const pos = p.paper.state.positions.ETHUSDT!; expect(pos.qty).toBeCloseTo(d.sizing!.qty, 10); expect(pos.leverage).toBe(d.sizing!.leverage);
    expect(p.engine.monitor.events.filter((e) => e.type === "RISK_ACCEPTED" || e.type === "PAPER_FILL").every((e) => e.correlationId === `corr_${sig().id}`)).toBe(true);
    expect(p.act(sig(), NOW)!.verdict).toBe("REJECT"); // same proposal twice: duplicate
  });
  it("REJECT or INSUFFICIENT_DATA never creates a paper order", () => {
    const p = new LiveScalpPipeline(engineWithBook(), newPaperState("p", 10_000, 1), { limits: { ...EMPTY_PAPER_RISK }, filters: { ETHUSDT: F("ETHUSDT") }, autoPaper: true, killSwitch: false }, () => NOW);
    expect(p.act(sig(), NOW)!.verdict).toBe("INSUFFICIENT_DATA"); expect(p.paper.state.orders.length).toBe(0); expect(p.paper.state.fills.length).toBe(0);
  });
});
