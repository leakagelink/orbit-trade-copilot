import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, FlaskConical, Lock, Radio, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { FeedEngine, LIVE_SYMBOLS, restUrl, type LiveSymbol } from "@/lib/live-feed";
import { LiveFeedClient, platformDeps } from "@/lib/live-feed-client";
import { newPaperState, parseExchangeFilters, restorePaper, serializePaper, equity, unrealized, dayNet, PAPER_LABEL, type SymbolFilters } from "@/lib/live-paper-exec";
import { EMPTY_PAPER_RISK, OWNER_PROPOSED_PAPER_VALUES, TESTNET_PRESET, type PaperRiskConfig } from "@/lib/live-scalp-risk";
import { LiveScalpPipeline } from "@/lib/live-scalp-pipeline";
import { getScalpExecutionGate } from "@/lib/scalp-execution.functions";

const D = "Live Binance USD-M market data, scalping signals, Central Risk decisions and PAPER fills for BTCUSDT and ETHUSDT. Real-money execution is disabled.";
export const Route = createFileRoute("/_authenticated/scalp-center")({
  head: () => ({ meta: [{ title: "Live Scalping Command Center — AlgoVirt" }, { name: "description", content: D }, { property: "og:title", content: "Live Scalping Command Center — AlgoVirt" }, { property: "og:description", content: D }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }] }),
  component: ScalpCenterPage,
});

function ScalpCenterPage() {
  const gateFn = useServerFn(getScalpExecutionGate);
  const gate = useQuery({ queryKey: ["scalp-exec-gate"], queryFn: () => gateFn(), staleTime: 60_000 });
  return (
    <div>
      <PageHeader title="Live Scalping Command Center" description={D} />
      <div className="space-y-4 px-5 pb-8 md:px-7">
        <div className="grid gap-3 md:grid-cols-2">
          <p className="flex gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-xs"><FlaskConical className="h-4 w-4 shrink-0 text-warning" /><span><b>PAPER.</b> {PAPER_LABEL}. Signals are UNVALIDATED: earlier research found no positive net expectancy for 1–5 minute rules after costs.</span></p>
          <p className="flex gap-2 rounded-lg border bg-card p-3 text-xs"><Lock className="h-4 w-4 shrink-0 text-loss" /><span><b>Real-money and Testnet execution: DISABLED</b> by a server-side gate{gate.data ? ` (${gate.data.version}, transport ${gate.data.transport})` : ""}. No control on this page can submit an exchange order.</span></p>
        </div>
        <ClientOnly fallback={<Skeleton className="h-96" />}><LiveCenter /></ClientOnly>
      </div>
    </div>
  );
}

const fmt = (n: number | null | undefined, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const ago = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const clock = (t: number | null | undefined) => (t ? new Date(t).toISOString().slice(11, 23) : "—");
const tone = (x: number | null | undefined) => (x === null || x === undefined || x === 0 ? "" : x > 0 ? "text-gain" : "text-loss");
const STATUS_TONE: Record<string, string> = { LIVE: "bg-gain/15 text-gain", STALE: "bg-loss/15 text-loss", NO_DATA: "bg-muted text-muted-foreground", SYNCED: "bg-gain/15 text-gain" };
const Chip = ({ s, label }: { s: string; label?: string }) => <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${STATUS_TONE[s] ?? "bg-warning/15 text-warning"}`}>{label ?? s}</span>;
const Panel = ({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) => (
  <section className="min-w-0 rounded-lg border bg-card p-4"><h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">{icon}{title}</h2>{children}</section>
);
const LIMIT_FIELDS: [keyof PaperRiskConfig, string][] = [["maxExposure", "Max exposure (USDT)"], ["maxDailyLoss", "Daily loss limit (USDT)"], ["maxPositions", "Max open positions"], ["maxLossPerTrade", "Max loss per trade (USDT)"], ["maxMarginPerTrade", "Max margin per trade (USDT)"], ["maxLeverage", "Max leverage (×)"], ["strategyBudget", "Strategy risk budget (USDT)"], ["liquidationBufferPct", "Liquidation buffer (%)"], ["maxDataAgeMs", "Max mark-price age (ms)"], ["maxProposalAgeMs", "Proposal expiry (ms)"], ["roundTripCostPct", "Round-trip cost (%)"]];

function LiveCenter() {
  const [userId, setUserId] = useState<string | null>(null);
  const [, setVersion] = useState(0);
  const [autoPaper, setAutoPaper] = useState(false);
  const [killSwitch, setKillSwitch] = useState(false);
  const [limits, setLimits] = useState<PaperRiskConfig>({ ...EMPTY_PAPER_RISK });
  const [filters, setFilters] = useState<Partial<Record<LiveSymbol, SymbolFilters>>>({});
  const [startEquity, setStartEquity] = useState("1000");
  const [recovery, setRecovery] = useState<string>("");
  const ref = useRef<{ engine: FeedEngine; client: LiveFeedClient; pipe: LiveScalpPipeline } | null>(null);
  const key = userId ? `algovirt.paper-scalp.v1.${userId}` : null;

  useEffect(() => { void supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? "anonymous")); }, []);
  useEffect(() => {
    if (!key) return;
    const engine = new FeedEngine(LIVE_SYMBOLS), client = new LiveFeedClient(engine, platformDeps());
    const saved = restorePaper(window.localStorage.getItem(key));
    const state = saved.ok ? saved.state : newPaperState(key, 1000, Date.now());
    setRecovery(saved.ok ? `Restored paper ledger (restart ${saved.state.restarts}); duplicate market events are ignored by id.` : `New paper ledger (${saved.reason}).`);
    if (saved.ok) engine.monitor.emit("WORKER_RESTART", "info", null, { restarts: saved.state.restarts });
    const pipe = new LiveScalpPipeline(engine, state, { limits: { ...EMPTY_PAPER_RISK }, filters: {}, autoPaper: false, killSwitch: false });
    client.onEvent = (e) => pipe.onEvent(e);
    ref.current = { engine, client, pipe };
    client.start();
    void fetch(restUrl("/fapi/v1/exchangeInfo", {}), { credentials: "omit" }).then((r) => r.ok ? r.json() : null).then((b: { symbols?: unknown[] } | null) => {
      const f: Partial<Record<LiveSymbol, SymbolFilters>> = {};
      for (const s of b?.symbols ?? []) { const x = parseExchangeFilters(s); if (x) f[x.symbol] = x; }
      setFilters(f);
    }).catch(() => engine.monitor.emit("REST_ERROR", "warn", null, { path: "/fapi/v1/exchangeInfo" }));
    let n = 0;
    const t = window.setInterval(() => {
      pipe.tick(Date.now()); n++;
      if (n % 5 === 0) { try { window.localStorage.setItem(key, serializePaper(pipe.paper.state)); } catch { /* storage full: ledger stays in memory */ } }
      setVersion((v) => v + 1);
    }, 1000);
    return () => { window.clearInterval(t); client.stop(); try { window.localStorage.setItem(key, serializePaper(pipe.paper.state)); } catch { /* ignore */ } ref.current = null; };
  }, [key]);
  useEffect(() => { const r = ref.current; if (r) r.pipe.o = { ...r.pipe.o, autoPaper, killSwitch, limits, filters }; }, [autoPaper, killSwitch, limits, filters]);

  const r = ref.current;
  const now = Date.now();
  const marks = r ? r.pipe.marks() : {};
  const st = r?.pipe.paper.state;
  const m = r?.client.metrics();
  const missingLimits = useMemo(() => LIMIT_FIELDS.filter(([k]) => limits[k] === null).map(([, l]) => l), [limits]);
  if (!r || !st || !m) return <Skeleton className="h-96" />;
  const setLimit = (k: keyof PaperRiskConfig, v: string) => setLimits((x) => ({ ...x, [k]: v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v) }));
  const resetPaper = () => { const eq = Number(startEquity); if (!(eq > 0) || !key) return; r.pipe.paper.state = newPaperState(key, eq, Date.now()); window.localStorage.setItem(key, serializePaper(r.pipe.paper.state)); setRecovery(`New paper ledger with ${eq} USDT.`); };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        {LIVE_SYMBOLS.map((sym) => {
          const h = r.engine.health(sym, now), top = r.engine.top(sym, now), mk = r.engine.mark(sym), sig = r.pipe.latest[sym], sp = top ? ((top.ask - top.bid) / ((top.ask + top.bid) / 2)) * 10_000 : null;
          return (
            <Panel key={sym} title={`${sym} perpetual`} icon={<Radio className={`h-4 w-4 ${h.ready ? "text-gain" : "text-loss"}`} />}>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div><div className="font-mono text-2xl font-semibold">{top ? fmt((top.bid + top.ask) / 2, sym === "BTCUSDT" ? 1 : 2) : "—"}</div><div className="text-xs text-muted-foreground">mid · bid {fmt(top?.bid, 2)} / ask {fmt(top?.ask, 2)} · spread {fmt(sp, 2)} bps · from {top?.source ?? "—"}</div></div>
                <Chip s={h.ready ? "LIVE" : "STALE"} label={h.ready ? "FEED READY" : "NOT READY"} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                <div><dt className="text-muted-foreground">Mark / index</dt><dd className="font-mono">{fmt(mk?.markPrice)} / {fmt(mk?.indexPrice)}</dd></div>
                <div><dt className="text-muted-foreground">Funding (est.)</dt><dd className="font-mono">{mk ? `${(mk.fundingRate * 100).toFixed(4)}% · in ${ago(mk.nextFundingTime - now)}` : "—"}</dd></div>
                <div><dt className="text-muted-foreground">Volatility (ATR 1m)</dt><dd className="font-mono">{sig?.features["atrPct"] != null ? `${sig.features["atrPct"]}%` : "—"}</dd></div>
                <div><dt className="text-muted-foreground">Exchange time</dt><dd className="font-mono">{clock(top?.exchangeTs)}</dd></div>
                <div><dt className="text-muted-foreground">Received</dt><dd className="font-mono">{clock(top?.receivedAt)}</dd></div>
                <div><dt className="text-muted-foreground">Latency p50</dt><dd className="font-mono">{ago(h.latencyP50Ms)}</dd></div>
              </dl>
              <div className="mt-3 flex flex-wrap gap-1.5">{(Object.entries(h.streams) as [string, { status: string; ageMs: number | null }][]).map(([k, v]) => <Chip key={k} s={v.status} label={`${k} ${v.status === "LIVE" ? ago(v.ageMs) : v.status}`} />)}<Chip s={h.book} label={`book ${h.book}`} /></div>
              {!h.ready && <p className="mt-2 text-xs text-loss">{h.reasons.join(" · ")}</p>}
              <p className="mt-2 text-[11px] text-muted-foreground">Resyncs {h.counters.resyncs} · sequence gaps {h.counters.gaps} · duplicates {h.counters.bookDuplicates + h.counters.tradeDuplicates} · trade-id gaps {h.counters.tradeGaps} · missing candles {h.counters.missingCandles}</p>
              <div className="mt-3 rounded-md border p-3">
                {!sig ? <p className="text-xs text-muted-foreground">First signal at the next closed 1-minute candle.</p> : <>
                  <div className="flex flex-wrap items-center gap-2"><span className={`rounded px-2 py-0.5 text-xs font-semibold ${sig.action === "LONG" ? "bg-gain/15 text-gain" : sig.action === "SHORT" ? "bg-loss/15 text-loss" : "bg-muted text-muted-foreground"}`}>{sig.action.replace("_", " ")}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{sig.strategyId} {sig.strategyVersion} · {sig.validation}</span>
                    <span className="text-[11px] text-muted-foreground">age {ago(now - sig.decidedAt)} · {now > sig.expiresAt ? "expired" : `expires in ${ago(sig.expiresAt - now)}`}</span></div>
                  <p className="mt-1 text-[11px] text-muted-foreground">Score {sig.confidence.score ?? "—"} ({sig.confidence.agreeing}/{sig.confidence.total}) — {sig.confidence.label}</p>
                  {sig.entryReference !== null && <p className="mt-1 font-mono text-xs">entry ref {fmt(sig.entryReference)} · stop {fmt(sig.stopReference)} · target {fmt(sig.takeProfitReference)}</p>}
                  {sig.costs && <p className="mt-1 text-[11px] text-muted-foreground">Est. round trip: fees {sig.costs.feePctRoundTrip.toFixed(3)}% + spread {sig.costs.spreadPct.toFixed(4)}% + slippage {sig.costs.slippagePctRoundTrip.long?.toFixed(4) ?? "—"}% + funding {sig.costs.fundingPct.long.toFixed(4)}% (long) — {sig.costs.basis}</p>}
                  {sig.reasons.length > 0 && <ul className="mt-1 list-disc pl-4 text-[11px]">{sig.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
                  {sig.rejections.length > 0 && <ul className="mt-1 list-disc pl-4 text-[11px] text-loss">{sig.rejections.map((x) => <li key={x}>{x}</li>)}</ul>}
                </>}
              </div>
            </Panel>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title="Paper account (PAPER — simulated)" icon={<FlaskConical className="h-4 w-4 text-warning" />}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div><dt className="text-muted-foreground">Paper equity</dt><dd className="font-mono">{fmt(equity(st, marks))} USDT</dd></div>
            <div><dt className="text-muted-foreground">Unrealized (mark)</dt><dd className={`font-mono ${tone(unrealized(st, marks))}`}>{fmt(unrealized(st, marks), 4)}</dd></div>
            <div><dt className="text-muted-foreground">Realized</dt><dd className={`font-mono ${tone(st.totals.realized)}`}>{fmt(st.totals.realized, 4)}</dd></div>
            <div><dt className="text-muted-foreground">Today (paper)</dt><dd className={`font-mono ${tone(dayNet(st, marks))}`}>{fmt(dayNet(st, marks), 4)}</dd></div>
            <div><dt className="text-muted-foreground">Fees</dt><dd className="font-mono">{fmt(st.totals.fees, 4)}</dd></div>
            <div><dt className="text-muted-foreground">Funding (net)</dt><dd className="font-mono">{fmt(st.totals.funding, 4)}</dd></div>
            <div><dt className="text-muted-foreground">Slippage cost</dt><dd className="font-mono">{fmt(st.totals.slippage, 4)}</dd></div>
            <div><dt className="text-muted-foreground">Max drawdown</dt><dd className="font-mono">{(st.maxDrawdown * 100).toFixed(2)}%</dd></div>
          </dl>
          <p className="mt-2 text-[11px] text-muted-foreground">{recovery} Stored in this browser only; not an audited ledger.</p>
          <div className="mt-3 space-y-1 text-xs">{Object.values(st.positions).filter(Boolean).length === 0 ? <p className="text-muted-foreground">No open paper position.</p> : Object.values(st.positions).map((p) => p && (
            <div key={p.id} className="rounded border p-2 font-mono"><b className={p.side === "LONG" ? "text-gain" : "text-loss"}>{p.side}</b> {p.symbol} {p.qty} @ {fmt(p.entryPrice)} · {p.leverage}× · margin {fmt(p.margin)} · liq {fmt(p.liquidationPrice)} · stop {fmt(p.stop)} · tp {fmt(p.takeProfit)} · uPnL <span className={tone(marks[p.symbol] ? (p.side === "LONG" ? marks[p.symbol]! - p.entryPrice : p.entryPrice - marks[p.symbol]!) : 0)}>{fmt(marks[p.symbol] ? (p.side === "LONG" ? marks[p.symbol]! - p.entryPrice : p.entryPrice - marks[p.symbol]!) * p.qty : null, 4)}</span>{p.exitPending ? ` · exit pending (${p.exitPending})` : ""}
              <Button size="sm" variant="outline" className="ml-2 h-6 px-2 text-[11px]" onClick={() => r.pipe.paper.closeManually(p.symbol, { now: Date.now(), depth: r.engine.depth(p.symbol, Date.now(), 200), filters: filters[p.symbol] ?? null })}>Close paper</Button></div>))}</div>
          <div className="mt-3 max-h-40 overflow-auto text-[11px]">{st.fills.slice(-12).reverse().map((f) => <div key={f.id} className="font-mono">{clock(f.at)} {f.reason} {f.action} {f.symbol} {f.qty} @ {fmt(f.price)} fee {fmt(f.fee, 4)} {f.liquidity} ({f.source})</div>)}</div>
        </Panel>

        <Panel title="Paper risk limits & controls" icon={<ShieldCheck className="h-4 w-4 text-primary" />}>
          <div className="flex items-center justify-between gap-2 text-xs"><Label htmlFor="auto">Auto-paper from signals (this tab only)</Label><Switch id="auto" checked={autoPaper} onCheckedChange={setAutoPaper} /></div>
          <div className="mt-2 flex items-center justify-between gap-2 text-xs"><Label htmlFor="kill">Paper emergency stop</Label><Switch id="kill" checked={killSwitch} onCheckedChange={setKillSwitch} /></div>
          <div className="mt-3 grid grid-cols-2 gap-2">{LIMIT_FIELDS.map(([k, l]) => <div key={k}><Label className="text-[11px]" htmlFor={k}>{l}</Label><Input id={k} className="h-8 text-xs" inputMode="decimal" value={limits[k] ?? ""} placeholder="not set" onChange={(e) => setLimit(k, e.target.value)} /></div>)}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setLimits((x) => ({ ...x, ...OWNER_PROPOSED_PAPER_VALUES }))}>Fill owner-proposed paper values</Button>
            <Button size="sm" variant="outline" onClick={() => setLimits((x) => ({ ...x, ...TESTNET_PRESET }))}>Fill owner Testnet limits</Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">Proposed values are NOT APPROVED. Empty limits make the Central Risk Engine return INSUFFICIENT DATA{missingLimits.length ? ` (missing: ${missingLimits.join(", ")})` : ""}. The engine alone sizes quantity and leverage.</p>
          <div className="mt-3 flex items-end gap-2"><div className="flex-1"><Label className="text-[11px]" htmlFor="eq">Paper starting equity (USDT)</Label><Input id="eq" className="h-8 text-xs" value={startEquity} onChange={(e) => setStartEquity(e.target.value)} /></div><Button size="sm" variant="outline" onClick={resetPaper}>Reset paper ledger</Button></div>
        </Panel>

        <Panel title="Pipeline health" icon={<Activity className="h-4 w-4 text-primary" />}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {(["market", "public"] as const).map((k) => <div key={k}><dt className="text-muted-foreground">Socket /{k}</dt><dd className="font-mono">{m.sockets[k].state} · reconnects {m.sockets[k].reconnects} · last {ago(m.sockets[k].lastMessageAt ? now - m.sockets[k].lastMessageAt : null)}</dd></div>)}
            <div><dt className="text-muted-foreground">Message processing</dt><dd className="font-mono">p50 {ago(m.processing.p50Ms)} · p95 {ago(m.processing.p95Ms)} · n {m.processing.count}</dd></div>
            <div><dt className="text-muted-foreground">Signal compute / latency</dt><dd className="font-mono">{ago(r.pipe.timings.lastSignalMs)} / {ago(r.pipe.timings.lastLatencyMs)}</dd></div>
            <div><dt className="text-muted-foreground">Clock offset</dt><dd className={`font-mono ${r.engine.clock.drift ? "text-loss" : ""}`}>{r.engine.clock.offsetMs === null ? "—" : `${r.engine.clock.offsetMs} ms (rtt ${r.engine.clock.rttMs} ms)`}</dd></div>
            <div><dt className="text-muted-foreground">REST</dt><dd className="font-mono">{m.rest.requests} req · {m.rest.errors} err · {m.rest.limited} limited</dd></div>
            <div><dt className="text-muted-foreground">Messages</dt><dd className="font-mono">{r.engine.counts.accepted} ok · {r.engine.counts.malformed} refused</dd></div>
            <div><dt className="text-muted-foreground">Reconciliation</dt><dd className={`font-mono ${r.pipe.reconcile && !r.pipe.reconcile.ok ? "text-loss" : ""}`}>{r.pipe.reconcile ? (r.pipe.reconcile.ok ? `OK (${r.pipe.reconcile.checked} checks)` : r.pipe.reconcile.mismatches.join("; ")) : "first check within 60 s"}</dd></div>
            <div><dt className="text-muted-foreground">Duplicates ignored (paper)</dt><dd className="font-mono">{st.duplicatesIgnored}</dd></div>
          </dl>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Central Risk Engine decisions (paper)" icon={<ShieldCheck className="h-4 w-4 text-primary" />}>
          {r.pipe.decisions.length === 0 ? <p className="text-xs text-muted-foreground">{autoPaper ? "Waiting for a LONG or SHORT signal." : "Turn on auto-paper to send LONG/SHORT signals to the Risk Engine."}</p> :
            <div className="max-h-72 overflow-auto text-[11px]">{r.pipe.decisions.slice(0, 25).map((d) => <div key={d.correlationId} className="border-b py-1"><span className="font-mono">{clock(d.at)}</span> {d.symbol} {d.action} → <b className={d.verdict === "ACCEPT" ? "text-gain" : "text-loss"}>{d.verdict}</b>{d.qty !== null ? ` qty ${d.qty} · ${d.leverage}×` : ""}{d.orderStatus ? ` · paper ${d.orderStatus}` : ""}{d.failed.length > 0 && <div className="text-muted-foreground">{d.failed.slice(0, 4).join(" · ")}</div>}<div className="font-mono text-muted-foreground">{d.correlationId}</div></div>)}</div>}
        </Panel>
        <Panel title="Monitoring events" icon={<AlertTriangle className="h-4 w-4 text-warning" />}>
          <div className="max-h-72 overflow-auto text-[11px]">{[...r.engine.monitor.events].slice(-40).reverse().map((e) => <div key={e.id} className="border-b py-1"><span className="font-mono">{clock(e.at)}</span> <b className={e.severity === "error" ? "text-loss" : e.severity === "warn" ? "text-warning" : ""}>{e.type}</b> {e.symbol ?? ""} <span className="text-muted-foreground">{Object.entries(e.detail).map(([k, v]) => `${k}=${v}`).join(" ")}</span><div className="font-mono text-muted-foreground">{e.id} · {e.correlationId}</div></div>)}</div>
        </Panel>
      </div>
    </div>
  );
}
