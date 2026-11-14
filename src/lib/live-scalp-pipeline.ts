// Phase 4H.8 — live PAPER scalping pipeline: feed events → signal at each closed 1m candle → Central Risk decision →
// paper order (only with the engine's sizing) → paper fills on live trades/marks → reconciliation. Pure orchestration
// (no I/O); the UI or a verification script feeds it events from LiveFeedClient. It cannot reach any exchange account.
import type { RiskDecision } from "./central-risk";
import type { FeedEngine, FeedEvent, LiveSymbol } from "./live-feed";
import { PaperBook, reconcilePaper, type PaperSimConfig, type PaperState, type ReconcileReport, type SymbolFilters, PROPOSED_PAPER_SIM } from "./live-paper-exec";
import { evaluateSignalRisk, strategyLossToday, type PaperRiskConfig } from "./live-scalp-risk";
import { evaluateLiveSignal, PROPOSED_SIGNAL_CONFIG, snapshotFor, type LiveSignal, type LiveSignalConfig } from "./live-scalp-signal";

export interface DecisionRecord { at: number; signalId: string; symbol: LiveSymbol; action: LiveSignal["action"]; verdict: RiskDecision["verdict"] | "SKIPPED"; failed: string[]; qty: number | null; leverage: number | null; orderStatus: string | null; correlationId: string }
export interface PipelineOptions { signal?: LiveSignalConfig; sim?: PaperSimConfig; limits: PaperRiskConfig; filters: Partial<Record<LiveSymbol, SymbolFilters>>; autoPaper: boolean; /** paper switch OR account emergency stop; null = unknown → INSUFFICIENT_DATA */ killSwitch: boolean | null; maxSignalLatencyMs?: number }

export class LiveScalpPipeline {
  readonly paper: PaperBook; readonly latest: Partial<Record<LiveSymbol, LiveSignal>> = {}; readonly decisions: DecisionRecord[] = [];
  private evaluated = new Set<string>(); private lastReconcileAt = 0; reconcile: ReconcileReport | null = null;
  readonly timings = { signals: 0, lastSignalMs: null as number | null, maxSignalMs: 0, lastLatencyMs: null as number | null };
  constructor(readonly engine: FeedEngine, state: PaperState, public o: PipelineOptions, private now: () => number = Date.now) {
    this.paper = new PaperBook(state, o.sim ?? PROPOSED_PAPER_SIM);
  }
  marks(): Partial<Record<LiveSymbol, number>> { const m: Partial<Record<LiveSymbol, number>> = {}; for (const s of this.engine.symbols) { const x = this.engine.mark(s); if (x) m[s] = x.markPrice; } return m; }
  private mv(sym: LiveSymbol, now: number) { return { now, depth: this.engine.depth(sym, now, 200), filters: this.o.filters[sym] ?? null }; }

  /** Call for every accepted feed event, in arrival order. */
  onEvent(e: FeedEvent) {
    const now = e.receivedAt;
    if (e.kind === "trade") this.paper.onTrade(e, this.o.filters[e.symbol] ?? null);
    else if (e.kind === "mark") this.paper.onMark(e, this.mv(e.symbol, now));
    else if (e.kind === "depth") { const p = this.paper.state.positions[e.symbol]; if (p?.exitPending) this.paper.tryExit(p, this.mv(e.symbol, now)); }
    else if (e.kind === "kline" && e.interval === "1m" && e.closed) this.decide(e.symbol, now, e.closeTime + 1);
    this.flushPaperEvents();
  }
  /** Signal at a closed candle; risk and a paper order only when auto-paper is on. */
  decide(sym: LiveSymbol, now: number, candleCloseAt: number | null = null): LiveSignal {
    const t0 = this.now(), sig = evaluateLiveSignal(snapshotFor(this.engine, sym, now), this.o.signal ?? PROPOSED_SIGNAL_CONFIG), dt = this.now() - t0;
    this.latest[sym] = sig; this.timings.signals++; this.timings.lastSignalMs = dt; this.timings.maxSignalMs = Math.max(this.timings.maxSignalMs, dt);
    const corr = `corr_${sig.id}`, mon = this.engine.monitor;
    mon.emit("SIGNAL_EMITTED", "info", sym, { signalId: sig.id, action: sig.action, score: sig.confidence.score, rejections: sig.rejections.slice(0, 3).join("; ") }, corr);
    if (candleCloseAt !== null) {
      const lat = now - candleCloseAt; this.timings.lastLatencyMs = lat;
      if (lat > (this.o.maxSignalLatencyMs ?? 2_000)) mon.emit("SIGNAL_LATENCY", "warn", sym, { latencyMs: lat, computeMs: dt }, corr);
    }
    if (this.o.autoPaper) this.act(sig, now, corr);
    return sig;
  }
  /** LONG/SHORT signal → Central Risk decision → paper order sized ONLY by the decision. */
  act(sig: LiveSignal, now: number, corr = `corr_${sig.id}`): DecisionRecord | null {
    const sym = sig.symbol, mon = this.engine.monitor;
    if (sig.action !== "LONG" && sig.action !== "SHORT") return null;
    const marks = this.marks();
    const r = evaluateSignalRisk(sig, { now, state: this.paper.state, limits: this.o.limits, filters: this.o.filters[sym] ?? null, mark: this.engine.mark(sym), marks, killSwitch: this.o.killSwitch, strategyUsedLoss: strategyLossToday(this.paper.state, now), evaluated: this.evaluated });
    if (r.proposal) this.evaluated.add(r.proposal.proposalId);
    const rec: DecisionRecord = { at: now, signalId: sig.id, symbol: sym, action: sig.action, verdict: r.decision?.verdict ?? "SKIPPED", failed: r.decision ? r.decision.checks.filter((c) => c.status !== "pass" && c.status !== "not_applicable").map((c) => `${c.id}: ${c.detail}`) : [r.skipped ?? "skipped"], qty: r.decision?.sizing?.qty ?? null, leverage: r.decision?.sizing?.leverage ?? null, orderStatus: null, correlationId: corr };
    if (r.decision?.verdict === "ACCEPT" && r.decision.sizing) {
      mon.emit("RISK_ACCEPTED", "info", sym, { signalId: sig.id, qty: r.decision.sizing.qty, leverage: r.decision.sizing.leverage, binding: r.decision.sizing.binding }, corr);
      const o = this.paper.submit({ proposalId: sig.id, signalId: sig.id, symbol: sym, side: sig.action, type: "MARKET", qty: r.decision.sizing.qty, leverage: r.decision.sizing.leverage, limitPrice: null, stop: sig.stopReference!, takeProfit: sig.takeProfitReference, ttlMs: 0, createdAt: now }, this.mv(sym, now));
      rec.orderStatus = o.status === "REJECTED" ? `REJECTED: ${o.reason}` : o.status;
      if (o.status === "REJECTED") mon.emit("PAPER_ORDER_REJECTED", "warn", sym, { signalId: sig.id, reason: o.reason }, corr);
    } else if (r.decision) mon.emit(r.decision.verdict === "REJECT" ? "RISK_REJECTED" : "RISK_INSUFFICIENT_DATA", "warn", sym, { signalId: sig.id, failed: rec.failed.slice(0, 3).join("; ") }, corr);
    this.decisions.unshift(rec); if (this.decisions.length > 100) this.decisions.pop();
    this.flushPaperEvents(corr);
    return rec;
  }
  private seen = 0;
  private flushPaperEvents(corr?: string) {
    const evs = this.paper.events, mon = this.engine.monitor;
    for (; this.seen < evs.length; this.seen++) {
      const e = evs[this.seen]!;
      if (e.type === "ORDER_FILLED" || e.type === "ORDER_PARTIAL") mon.emit("PAPER_FILL", "info", e.symbol, e.detail, corr);
      else if (e.type === "LIQUIDATION") mon.emit("PAPER_LIQUIDATION", "error", e.symbol, e.detail, corr);
      else if (e.type === "EXIT_PENDING") mon.emit("PAPER_ERROR", "warn", e.symbol, e.detail, corr);
    }
    if (evs.length >= 500) { evs.splice(0, evs.length); this.seen = 0; }
  }
  /** Periodic: order expiry, day roll, drawdown, reconciliation (every 60 s). */
  tick(now: number) {
    this.paper.onTick(now, this.marks()); this.flushPaperEvents();
    if (now - this.lastReconcileAt >= 60_000) {
      this.lastReconcileAt = now; this.reconcile = reconcilePaper(this.paper.state);
      this.engine.monitor.emit(this.reconcile.ok ? "RECONCILIATION_OK" : "RECONCILIATION_MISMATCH", this.reconcile.ok ? "info" : "error", null, { checked: this.reconcile.checked, mismatches: this.reconcile.mismatches.slice(0, 3).join("; ") });
    }
  }
}
