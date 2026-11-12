import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, FlaskConical, OctagonX } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setPaperEmergencyStop, setPaperStrategyStatus } from "@/lib/paper.functions";
import { paperSummary, periodPnl, PAPER_EVALUATION_THRESHOLD } from "@/lib/paper-metrics";
import { SIMULATED_FILL_LABEL, type PaperState } from "@/lib/paper-engine";
import { fmtMoney } from "@/lib/metrics";

// Rows come from the paper ledger tables, which are not in the generated types until draft migration 0044 is applied.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = any;
const num = (x: unknown) => Number(x ?? 0);
const when = (t: number | string | null | undefined) => (t == null ? "—" : new Date(typeof t === "string" && !/^\d+$/.test(t) ? t : Number(t)).toLocaleString());
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(2)}%`);

export function NotEnabled({ notice, strategies }: { notice: string; strategies: number }) {
  return (
    <div className="space-y-4">
      <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /><div><p className="font-medium">Not running yet</p><p className="text-muted-foreground">{notice}</p></div></div>
      <Assumptions />
      <p className="text-xs text-muted-foreground">You have {strategies} saved strateg{strategies === 1 ? "y" : "ies"} that could be paper traded once the ledger is enabled.</p>
    </div>
  );
}

function Assumptions({ costs, risk }: { costs?: Row; risk?: Row }) {
  const items = [
    ["Data", "Public Binance Spot candles, closed candles only; a missing candle pauses the strategy, a feed outage changes nothing"],
    ["Signals", "Your strategy rules are checked when a candle closes, using only candles that had closed by then"],
    ["Entries", "Market orders fill at the next candle's open plus half the spread and slippage; limit orders fill only if price trades through the limit"],
    ["Partial fills", "Each fill takes at most the set share of the candle's volume; the rest keeps working until the order expires"],
    ["Stops", "Stop-loss is required; if stop and target both trade inside one candle the stop wins; a gap through the stop fills at the worse open"],
    ["Sizing", "The paper Risk Engine sizes every entry from your limits (risk per trade, size, budget, exposure, cash); AI output never sets size"],
    ["Limits", "Account exposure, open positions, max position size, daily loss stops and an emergency paper stop"],
    ["Marking", "Equity is marked at the candle close before exit costs"],
  ];
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-2 text-sm font-medium">Execution assumptions</h3>
      <dl className="grid gap-2 text-xs sm:grid-cols-2">{items.map(([k, v]) => <div key={k}><dt className="font-medium">{k}</dt><dd className="text-muted-foreground">{v}</dd></div>)}</dl>
      {costs && risk && <p className="mt-3 font-mono text-xs text-muted-foreground">fee {costs.feePct}% · spread {costs.spreadPct}% · slippage {costs.slippagePct}% · volume cap {costs.maxParticipationPct ?? "none"}% · risk {risk.riskPerTradePct}% · size {risk.positionSizePct}% · max {risk.maxPositionNotional} · stop {risk.stopLossPct}% · target {risk.takeProfitPct ?? "none"}% · daily stop {risk.dailyLossLimit} · budget {risk.strategyBudget} · {risk.entryOrder} entries · {risk.orderTtlBars}-candle orders</p>}
    </div>
  );
}

export function Enabled({ d }: { d: Row }) {
  const qc = useQueryClient();
  const halt = useServerFn(setPaperEmergencyStop);
  const setStatus = useServerFn(setPaperStrategyStatus);
  const [confirm, setConfirm] = useState("");
  const paper: Row[] = d.paper ?? [];
  const [selId, setSelId] = useState<string | null>(null);
  const sel = paper.find((p) => p.id === selId) ?? paper[0];
  const refresh = () => qc.invalidateQueries({ queryKey: ["paper-dashboard"] });
  const act = async (f: () => Promise<unknown>, ok: string) => { try { await f(); toast.success(ok); refresh(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); } };
  const halted = !!d.account?.halted;
  return (
    <div className="space-y-5">
      <div className={`flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${halted ? "border-loss/50 bg-loss/10" : "bg-card"}`}>
        <div className="text-sm"><p className="font-medium">{halted ? "Emergency paper stop is ON" : "Paper account"}</p><p className="text-xs text-muted-foreground">{halted ? `Since ${when(d.account.halted_at)}: no new paper entries; open paper positions exit at the next candle open.` : d.account ? `Limits: exposure ${fmtMoney(num(d.account.max_exposure))} · daily loss ${fmtMoney(num(d.account.max_daily_loss))} · ${d.account.max_open_positions} open positions · max position ${fmtMoney(num(d.account.max_position_notional))}` : "Created with default limits when you start your first paper strategy."}</p></div>
        {halted ? (
          <div className="flex gap-2"><Input aria-label="Type RESUME PAPER" placeholder="Type RESUME PAPER" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-44" /><Button variant="outline" disabled={confirm !== "RESUME PAPER"} onClick={() => act(() => halt({ data: { on: false, confirm } }), "Emergency paper stop lifted")}>Lift stop</Button></div>
        ) : <Button variant="destructive" onClick={() => act(() => halt({ data: { on: true } }), "Emergency paper stop is on")}><OctagonX className="mr-1 h-4 w-4" />Emergency paper stop</Button>}
      </div>
      {!paper.length ? <EmptyState icon={FlaskConical} title="No paper strategies yet" body="Start one of your strategies to paper trade it forward on live public prices." /> : (
        <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="space-y-2">{paper.map((p) => (
            <button key={p.id} onClick={() => setSelId(p.id)} className={`w-full rounded-lg border p-3 text-left text-sm transition-colors hover:bg-accent ${sel?.id === p.id ? "border-primary bg-accent" : "bg-card"}`}>
              <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{p.strategy_name}</span><Badge variant={p.status === "active" ? "default" : p.status === "paused" ? "secondary" : "outline"}>{p.status}</Badge></div>
              <div className="mt-1 font-mono text-xs text-muted-foreground">{p.pair} · {p.timeframe} · {fmtMoney(num(p.equity))}</div>
            </button>))}
          </div>
          {sel && <StrategyReport p={sel} d={d} onStatus={(status: "active" | "paused" | "stopped") => act(() => setStatus({ data: { id: sel.id, status } }), `Paper strategy ${status}`)} />}
        </div>
      )}
    </div>
  );
}

function StrategyReport({ p, d, onStatus }: { p: Row; d: Row; onStatus: (s: "active" | "paused" | "stopped") => void }) {
  const bars = useMemo(() => (d.bars as Row[]).filter((b) => b.paper_strategy_id === p.id).map((b) => ({ ...b, bar_t: num(b.bar_t), equity: num(b.equity), unrealized: num(b.unrealized) })), [d.bars, p.id]);
  const trades = useMemo(() => (d.trades as Row[]).filter((t) => t.paper_strategy_id === p.id).map((t) => ({ ...t, opened_bar_t: num(t.opened_bar_t), closed_bar_t: num(t.closed_bar_t), gross_pnl: num(t.gross_pnl), fees: num(t.fees), spread_cost: num(t.spread_cost), slippage_cost: num(t.slippage_cost), net_pnl: num(t.net_pnl) })), [d.trades, p.id]);
  const events = (d.events as Row[]).filter((e) => e.paper_strategy_id === p.id);
  const capital = num(p.starting_capital), tf = num(p.tf_ms);
  const m = paperSummary(trades, bars, capital, tf);
  const daily = periodPnl(bars, capital, "day").slice(-14).reverse();
  const weekly = periodPnl(bars, capital, "week").slice(-8).reverse();
  const curve = [...bars].sort((a, b) => a.bar_t - b.bar_t).map((b) => ({ t: new Date(b.bar_t).toLocaleString(), v: b.equity }));
  const state = p.state as PaperState;
  const lastBar = bars.reduce((a, b) => Math.max(a, b.bar_t), 0);
  const lagMs = lastBar ? d.serverNow - (lastBar + tf) : null;
  const fresh = lagMs !== null && lagMs <= 2 * tf;
  const latest = bars.reduce<Row | null>((a, b) => (!a || b.bar_t > a.bar_t ? b : a), null);
  const card = (l: string, v: string, tone?: boolean | null) => <div key={l} className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">{l}</div><div className={`mt-1 font-mono text-base ${tone === true ? "text-gain" : tone === false ? "text-loss" : ""}`}>{v}</div></div>;
  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div><h2 className="text-lg font-medium">{p.strategy_name} <span className="font-mono text-sm text-muted-foreground">{p.pair} · Spot · {p.timeframe}</span></h2>
          <p className="text-xs text-muted-foreground">Started {when(p.started_at)} with {fmtMoney(capital)} simulated · engine {p.engine_version} · config {String(p.config_sha256).slice(0, 12)}</p>
          {p.status_reason && <p className="mt-1 text-xs text-warning">{p.status_reason}</p>}</div>
        <div className="flex gap-2">
          {p.status === "active" && <Button size="sm" variant="outline" onClick={() => onStatus("paused")}>Pause entries</Button>}
          {p.status === "paused" && <Button size="sm" variant="outline" onClick={() => onStatus("active")}>Resume</Button>}
          {p.status !== "stopped" && <Button size="sm" variant="ghost" disabled={num(p.open_positions) > 0} title={num(p.open_positions) > 0 ? "Wait for the paper position to close" : undefined} onClick={() => onStatus("stopped")}>Stop for good</Button>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div className="rounded-lg border bg-card p-3"><div className="text-muted-foreground">Data freshness</div><div className={`mt-1 ${fresh ? "text-gain" : "text-warning"}`}>{lastBar ? (fresh ? "Fresh" : "Behind / stale") : "Waiting for first candle"}</div></div>
        <div className="rounded-lg border bg-card p-3"><div className="text-muted-foreground">Last candle processed</div><div className="mt-1 font-mono">{lastBar ? when(lastBar) : "—"}</div></div>
        <div className="rounded-lg border bg-card p-3"><div className="text-muted-foreground">Last check</div><div className="mt-1 font-mono">{when(p.last_checked_at)}</div></div>
        <div className="rounded-lg border bg-card p-3"><div className="text-muted-foreground">Feed status</div><div className="mt-1">{p.data_status ?? "—"}</div></div>
      </div>
      <div className={`rounded-lg border p-3 text-sm ${m.thresholdReached ? "bg-card" : "border-warning/40 bg-warning/10"}`}>{m.verdict} <span className="text-xs text-muted-foreground">Threshold: {PAPER_EVALUATION_THRESHOLD} settled trades.</span></div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {card("Equity (marked at close)", fmtMoney(m.equity), m.equity >= capital)}
        {card("Realized net P&L", fmtMoney(m.realizedNet), m.realizedNet >= 0)}
        {card("Unrealized P&L (before exit costs)", fmtMoney(m.unrealized), m.unrealized >= 0)}
        {card("Settled trades", String(m.settled))}
        {card("Win rate", pct(m.winRatePct))}
        {card("Net expectancy / trade", m.expectancy == null ? "—" : fmtMoney(m.expectancy), m.expectancy == null ? null : m.expectancy >= 0)}
        {card("Profit factor", m.profitFactor == null ? (m.profitFactorNote ?? "—") : m.profitFactor.toFixed(2))}
        {card("Max drawdown", pct(m.maxDrawdownPct))}
        {card("Fees", fmtMoney(m.totalFees))}
        {card("Spread cost", fmtMoney(m.totalSpread))}
        {card("Slippage cost", fmtMoney(m.totalSlippage))}
        {card("Today (UTC) net", fmtMoney(num(p.day_net)), num(p.day_net) >= 0)}
      </div>
      <div className="h-56 rounded-lg border bg-card p-3">{curve.length < 2 ? <p className="text-sm text-muted-foreground">The equity curve appears after two processed candles.</p> : <ResponsiveContainer width="100%" height="100%"><AreaChart data={curve}><XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={50} /><YAxis domain={["auto", "auto"]} width={70} tick={{ fontSize: 11 }} /><Tooltip formatter={(v: number) => v.toFixed(2)} /><Area dataKey="v" name="Paper equity" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.1} isAnimationActive={false} /></AreaChart></ResponsiveContainer>}</div>
      <div className="grid gap-4 md:grid-cols-2">
        <PeriodTable title="Daily (UTC)" rows={daily} />
        <PeriodTable title="Weekly (ISO)" rows={weekly} />
      </div>
      <div className="rounded-lg border bg-card p-3 text-sm">
        <h3 className="mb-2 font-medium">Open paper position</h3>
        {state?.position ? <p className="font-mono text-xs">{state.position.qty.toPrecision(6)} {p.pair.split("/")[0]} @ avg {(state.position.buyNotional / state.position.buyQty).toFixed(4)} · stop {state.position.stop.toFixed(4)} · target {state.position.target?.toFixed(4) ?? "none"} · mark {latest ? num(latest.candle?.c).toFixed(4) : "—"} · unrealized {fmtMoney(m.unrealized)}</p> : <p className="text-xs text-muted-foreground">None</p>}
        {!!state?.orders?.length && <p className="mt-2 text-xs text-muted-foreground">Working orders: {state.orders.map((o) => `${o.intent} ${o.kind} ${(o.qty - o.filled).toPrecision(6)}${o.limitPrice ? ` @ ${o.limitPrice.toFixed(4)}` : ""}`).join(" · ")}</p>}
      </div>
      <Table title="Settled paper trades" note={SIMULATED_FILL_LABEL} head={["Opened", "Closed", "Qty", "Avg entry", "Avg exit", "Fees", "Net P&L", "Reason"]} rows={trades.slice(0, 200).map((t) => [when(t.opened_bar_t), when(t.closed_bar_t), num(t.qty).toPrecision(6), num(t.avg_entry).toFixed(4), num(t.avg_exit).toFixed(4), num(t.fees).toFixed(4), <span key="n" className={t.net_pnl >= 0 ? "text-gain" : "text-loss"}>{t.net_pnl.toFixed(4)}</span>, String(t.close_reason).replace(/_/g, " ")])} />
      <Table title="Paper order history" note={SIMULATED_FILL_LABEL} head={["Candle", "Event", "Order", "Side", "Qty", "Price", "Fee", "Reason"]} rows={events.slice(0, 300).map((e) => [when(e.bar_t), e.event.replace("_", " "), `${e.intent} ${e.kind.replace("_", " ")}`, e.side, num(e.qty).toPrecision(6), e.price == null ? "—" : num(e.price).toFixed(4), num(e.fee).toFixed(4), String(e.reason).replace(/_/g, " ")])} />
      <Assumptions costs={p.costs} risk={p.risk} />
    </div>
  );
}

function PeriodTable({ title, rows }: { title: string; rows: { period: string; equity: number; pnl: number }[] }) {
  return <Table title={title} head={["Period", "Closing equity", "Change"]} rows={rows.map((r) => [r.period, r.equity.toFixed(2), <span key="p" className={r.pnl >= 0 ? "text-gain" : "text-loss"}>{r.pnl.toFixed(2)}</span>])} />;
}
function Table({ title, note, head, rows }: { title: string; note?: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 pt-3"><h3 className="text-sm font-medium">{title}</h3>{note && <span className="text-xs text-muted-foreground">{note}</span>}</div>
      {!rows.length ? <p className="p-3 text-xs text-muted-foreground">Nothing yet.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground">{head.map((h) => <th key={h} className="px-3 py-2 font-normal">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t font-mono text-xs">{r.map((c, j) => <td key={j} className="whitespace-nowrap px-3 py-2">{c}</td>)}</tr>)}</tbody></table></div>
      )}
    </div>
  );
}
