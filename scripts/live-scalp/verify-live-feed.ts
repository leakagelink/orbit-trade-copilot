// Phase 4H.8 live verification on REAL public Binance USD-M data (no key, no signed request, no order). Runs the
// production feed client + pipeline for N seconds, forces one disconnect of each socket mid-run to exercise reconnect,
// resubscription and order-book resync on the real stream, then runs ONE labelled test proposal through the Central
// Risk Engine and the paper simulator against the live book. Writes a JSON report.
// Usage: bun scripts/live-scalp/verify-live-feed.ts <seconds> <out.json>
import { writeFileSync } from "node:fs";
import { FeedEngine, LIVE_SYMBOLS, restUrl } from "../../src/lib/live-feed";
import { LiveFeedClient, platformDeps } from "../../src/lib/live-feed-client";
import { LiveScalpPipeline } from "../../src/lib/live-scalp-pipeline";
import { newPaperState, parseExchangeFilters, PaperBook, reconcilePaper, type SymbolFilters } from "../../src/lib/live-paper-exec";
import { evaluateProposal } from "../../src/lib/central-risk";
import { buildPaperRiskContext, EMPTY_PAPER_RISK, OWNER_PROPOSED_PAPER_VALUES } from "../../src/lib/live-scalp-risk";
import { evaluateLiveSignal, snapshotFor } from "../../src/lib/live-scalp-signal";

const SECONDS = Number(process.argv[2] ?? 100), OUT = process.argv[3] ?? "/tmp/live-verify.json";
const t0 = Date.now(), engine = new FeedEngine(LIVE_SYMBOLS), client = new LiveFeedClient(engine, platformDeps());
const ex = (await (await fetch(restUrl("/fapi/v1/exchangeInfo", {}))).json()) as { symbols: unknown[] };
const filters: Record<string, SymbolFilters> = {}; for (const s of ex.symbols) { const f = parseExchangeFilters(s); if (f) filters[f.symbol] = f; }
// Paper limits for this run only (verification values, not proposals): owner-proposed paper values + generous sizing.
const limits = { ...EMPTY_PAPER_RISK, ...OWNER_PROPOSED_PAPER_VALUES, maxExposure: 2_000, maxDailyLoss: 50, maxPositions: 2, maxLossPerTrade: 5, maxMarginPerTrade: 200, maxLeverage: 10, strategyBudget: 20 };
const pipe = new LiveScalpPipeline(engine, newPaperState("verify", 10_000, t0), { limits, filters, autoPaper: true, killSwitch: false });
client.onEvent = (e) => pipe.onEvent(e);
client.start();
const samples: unknown[] = [];
const sample = (label: string) => { const now = Date.now(); samples.push({ label, t: Math.round((now - t0) / 1000), health: LIVE_SYMBOLS.map((s) => { const h = engine.health(s, now); return { s, ready: h.ready, book: h.book, reasons: h.reasons, counters: h.counters, latencyP50Ms: h.latencyP50Ms, top: engine.top(s, now), sizes: engine.bookSizes(s) }; }), clock: engine.clock, metrics: client.metrics() }); };
const at = (s: number, f: () => void) => setTimeout(f, s * 1000);
at(8, () => sample("warm"));
at(Math.round(SECONDS * 0.35), () => { sample("before public disconnect"); client.forceReconnect("public", "verification: forced disconnect"); });
at(Math.round(SECONDS * 0.35) + 6, () => sample("6 s after public disconnect"));
at(Math.round(SECONDS * 0.6), () => { sample("before market disconnect"); client.forceReconnect("market", "verification: forced disconnect"); });
at(Math.round(SECONDS * 0.6) + 6, () => sample("6 s after market disconnect"));
const ticker = setInterval(() => pipe.tick(Date.now()), 1000);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
sample("end");
// One labelled TEST proposal (not a signal) through the Central Risk Engine and the paper simulator on the live book.
const now = Date.now(), sym = "ETHUSDT" as const, top = engine.top(sym, now)!, mark = engine.mark(sym)!;
const proposal = { proposalId: `verify-test-${now}`, engine: "scalp_intraday" as const, strategyId: "verification-test-proposal", symbol: sym, market: "usdm_futures" as const, environment: "paper" as const, side: "LONG" as const, referencePrice: top.ask, stopPrice: top.ask * 0.997, takeProfitPrice: top.ask * 1.0045, createdAt: now };
const book = new PaperBook(newPaperState("verify-test", 10_000, now));
const decision = evaluateProposal(proposal, buildPaperRiskContext(sym, proposal.proposalId, { now, state: book.state, limits, filters: filters[sym]!, mark, marks: { [sym]: mark.markPrice }, killSwitch: false, strategyUsedLoss: 0, evaluated: new Set() }));
const order = decision.sizing ? book.submit({ proposalId: proposal.proposalId, signalId: "test", symbol: sym, side: "LONG", type: "MARKET", qty: decision.sizing.qty, leverage: decision.sizing.leverage, limitPrice: null, stop: proposal.stopPrice, takeProfit: proposal.takeProfitPrice, ttlMs: 0, createdAt: now }, { now, depth: engine.depth(sym, now, 200), filters: filters[sym]! }) : null;
const finalSignals = LIVE_SYMBOLS.map((s) => evaluateLiveSignal(snapshotFor(engine, s, Date.now())));
client.stop(); clearInterval(ticker);
writeFileSync(OUT, JSON.stringify({
  source: "binance-public-usdm (live)", startedAt: new Date(t0).toISOString(), seconds: SECONDS, filters, samples,
  monitorCounts: engine.monitor.counts, monitorEvents: engine.monitor.events.filter((e) => e.type !== "SIGNAL_EMITTED" && e.type !== "FEED_RECOVERED").slice(-80),
  counts: engine.counts, signals: { pipelineLatest: pipe.latest, timings: pipe.timings, finalSignals }, decisions: pipe.decisions, paperState: pipe.paper.state, reconcile: reconcilePaper(pipe.paper.state),
  testProposal: { note: "TEST proposal built by this script (not a strategy signal), evaluated by the unchanged Central Risk Engine and filled by the paper simulator against the live book", proposal, decision, order, fills: book.state.fills, position: book.state.positions[sym] ?? null, reconcile: reconcilePaper(book.state) },
}, null, 1));
console.log("wrote", OUT, JSON.stringify(engine.monitor.counts));
process.exit(0);
