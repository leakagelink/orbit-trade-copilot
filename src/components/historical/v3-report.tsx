// Read-only view of one v3 historical evaluation stored in backtest_results.trade_log. Shows stored values only.
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmtMoney } from "@/lib/metrics";
import type { PerformanceMetrics } from "@/lib/backtest-metrics";
import type { SimTrade } from "@/lib/backtest-v3";
import type { DataIssue, DataCoverage } from "@/lib/historical-data";
import type { Segment } from "@/lib/backtest-splits";

export interface V3Log {
  status: "completed"; metrics: PerformanceMetrics; trades: SimTrade[]; equity: { t: number; v: number }[];
  reconciliation: { finalEquity: number; expected: number; difference: number }; liquidityLimited: number;
  manifest: { exchange: string; market: string; feePct: number; spreadPct: number; slippagePct: number; maxParticipationPct: number | null; tfMs: number };
  data: { candleSha256: string; fetchedAt: number; decisionCutoff: number; source: { provider: string; endpoint: string; market: string } };
  integrity: { ok: boolean; issues: DataIssue[]; coverage: DataCoverage };
  splits: { plan: { purgeBars: number; embargoBars: number }; segments: Segment[]; frozen: { configSha256: string; selectedBy: string }; train: PerformanceMetrics; validation: PerformanceMetrics; test: PerformanceMetrics } | null;
  splitError: string | null;
  walkForward: { train: Segment; test: Segment; metrics: PerformanceMetrics }[];
  benchmarks: { key: string; label: string; metrics: PerformanceMetrics; equity: { t: number; v: number }[]; trades: number }[];
  limitations: string[]; evidenceHash: string; costAssumptions: string;
}
export interface InsufficientLog { status: "insufficient_data"; integrity: { ok: boolean; issues: DataIssue[]; coverage: DataCoverage }; data: { candleSha256: string; source: { provider: string } } }

const pct = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}%`);
const num = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const day = (t: number) => new Date(t).toLocaleDateString();
const hold = (ms: number | null) => (ms == null ? "—" : ms >= 86_400_000 ? `${(ms / 86_400_000).toFixed(1)} d` : `${(ms / 3_600_000).toFixed(1)} h`);
const tone = (v: number | null | undefined) => (v == null ? "" : v > 0 ? "text-gain" : v < 0 ? "text-loss" : "");

export function DataCompleteness({ integrity, sha }: { integrity: V3Log["integrity"]; sha: string }) {
  const c = integrity.coverage;
  return (
    <section className="rounded-lg border bg-card p-4" aria-label="Data completeness">
      <div className="flex flex-wrap items-center gap-2">
        {integrity.ok ? <CheckCircle2 className="h-4 w-4 text-gain" /> : <AlertTriangle className="h-4 w-4 text-loss" />}
        <h3 className="text-sm font-medium">Data completeness: {pct(c.completenessPct, 1)}</h3>
        <span className="text-xs text-muted-foreground">{c.actual} of {c.expected} candles · {c.missing} missing · fingerprint <span className="font-mono">{sha.slice(0, 12)}…</span></span>
      </div>
      {!!integrity.issues.length && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-loss">{integrity.issues.slice(0, 12).map((x, i) => <li key={i}>{x.detail}</li>)}</ul>}
      {integrity.issues.length > 12 && <p className="mt-1 text-xs text-muted-foreground">…and {integrity.issues.length - 12} more.</p>}
    </section>
  );
}

function MetricGrid({ m, capital }: { m: PerformanceMetrics; capital: number }) {
  const rows: [string, string, number | null][] = [
    ["Starting capital", fmtMoney(capital), null], ["Final equity", fmtMoney(m.finalEquity), m.finalEquity - capital],
    ["Net return", pct(m.netReturnPct), m.netReturnPct], ["Net profit", fmtMoney(m.netProfit), m.netProfit],
    ["Win rate", pct(m.winRatePct, 1), null], ["Profit factor", m.profitFactor == null ? (m.profitFactorNote ?? "—") : num(m.profitFactor), null],
    ["Expectancy / trade", fmtMoney(m.expectancy), m.expectancy], ["Max drawdown", pct(m.maxDrawdownPct), null],
    ["Sharpe (annualised)", num(m.sharpe), null], ["Trades", String(m.trades), null], ["Avg holding", hold(m.avgHoldingMs), null],
    ["Fees", fmtMoney(m.totalFees), null], ["Spread", fmtMoney(m.totalSpread), null], ["Slippage", fmtMoney(m.totalSlippage), null], ["Funding", fmtMoney(m.totalFunding), null],
  ];
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">{rows.map(([l, v, g]) => <div key={l} className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">{l}</div><div className={`mt-1 font-mono text-base ${tone(g)}`}>{v}</div></div>)}</div>;
}

function EquityChart({ log }: { log: V3Log }) {
  const bh = log.benchmarks.find((b) => b.key === "buy_and_hold"), ema = log.benchmarks.find((b) => b.key === "ema_12_26");
  const at = (s: { t: number; v: number }[] | undefined) => new Map((s ?? []).map((e) => [e.t, e.v]));
  const b1 = at(bh?.equity), b2 = at(ema?.equity);
  const step = Math.max(1, Math.ceil(log.equity.length / 600));
  const data = log.equity.filter((_, i) => i % step === 0 || i === log.equity.length - 1).map((e) => ({ t: day(e.t), strategy: e.v, buyHold: b1.get(e.t) ?? null, ema: b2.get(e.t) ?? null }));
  return (
    <div className="h-72 rounded-lg border bg-card p-3" aria-label="Equity curve with benchmarks">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}><XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} /><YAxis domain={["auto", "auto"]} width={70} tick={{ fontSize: 11 }} /><Tooltip formatter={(v: number) => v.toFixed(2)} /><Legend wrapperStyle={{ fontSize: 12 }} />
          <Line dataKey="strategy" name="Strategy" stroke="var(--primary)" dot={false} isAnimationActive={false} strokeWidth={2} />
          <Line dataKey="buyHold" name="Buy and hold" stroke="var(--chart-2)" dot={false} isAnimationActive={false} />
          <Line dataKey="ema" name="EMA 12/26" stroke="var(--chart-3)" dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function CompareTable({ rows }: { rows: { label: string; m: PerformanceMetrics; extra?: string }[] }) {
  const head = ["", "Net return", "Trades", "Win rate", "Profit factor", "Expectancy", "Max drawdown", "Sharpe", "Costs"];
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground">{head.map((h) => <th key={h} className="px-3 py-2 font-normal">{h}</th>)}</tr></thead>
        <tbody>{rows.map(({ label, m, extra }) => (
          <tr key={label} className="border-t font-mono text-xs">
            <td className="px-3 py-2 font-sans text-sm">{label}{extra && <div className="text-[11px] text-muted-foreground">{extra}</div>}</td>
            <td className={`px-3 py-2 ${tone(m.netReturnPct)}`}>{pct(m.netReturnPct)}</td><td className="px-3 py-2">{m.trades}</td><td className="px-3 py-2">{pct(m.winRatePct, 1)}</td>
            <td className="px-3 py-2">{m.profitFactor == null ? "—" : num(m.profitFactor)}</td><td className={`px-3 py-2 ${tone(m.expectancy)}`}>{num(m.expectancy)}</td>
            <td className="px-3 py-2">{pct(m.maxDrawdownPct)}</td><td className="px-3 py-2">{num(m.sharpe)}</td><td className="px-3 py-2">{num(m.totalFees + m.totalSpread + m.totalSlippage - m.totalFunding)}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

export function V3Report({ log, capital }: { log: V3Log; capital: number }) {
  const s = log.splits;
  const gap = s ? s.plan.purgeBars + s.plan.embargoBars : 0;
  return (
    <div className="space-y-6">
      <DataCompleteness integrity={log.integrity} sha={log.data.candleSha256} />
      <MetricGrid m={log.metrics} capital={capital} />
      <p className={`text-xs ${Math.abs(log.reconciliation.difference) < 0.01 ? "text-muted-foreground" : "text-loss"}`}>
        Reconciliation: final equity {fmtMoney(log.reconciliation.finalEquity)} = starting capital + net results {fmtMoney(log.reconciliation.expected)} (difference {log.reconciliation.difference.toFixed(6)}). Open positions were closed at the last price with full costs.
        {log.liquidityLimited > 0 && ` ${log.liquidityLimited} entr${log.liquidityLimited === 1 ? "y was" : "ies were"} reduced by the candle-volume limit.`}
      </p>
      <EquityChart log={log} />
      <section className="space-y-2"><h3 className="text-sm font-medium">Benchmark comparison (same candles, capital and costs)</h3>
        <CompareTable rows={[{ label: "This strategy", m: log.metrics }, ...log.benchmarks.map((b) => ({ label: b.label, m: b.metrics }))]} />
      </section>
      <section className="space-y-2" aria-label="Chronological periods">
        <h3 className="text-sm font-medium">Train / validation / test (in time order, never shuffled)</h3>
        {s ? (<>
          <CompareTable rows={s.segments.map((seg) => ({ label: seg.name === "test" ? "Test (out-of-sample)" : seg.name[0]!.toUpperCase() + seg.name.slice(1), m: s[seg.name as "train" | "validation" | "test"], extra: `${day(seg.startT)} → ${day(seg.endT)}` }))} />
          <p className="text-xs text-muted-foreground">{gap} candles are skipped between periods ({s.plan.purgeBars} purge + {s.plan.embargoBars} embargo). Strategy settings were frozen before the test period (fingerprint <span className="font-mono">{s.frozen.configSha256.slice(0, 12)}…</span>). Each period only sees candles up to its own end.</p>
        </>) : <p className="rounded-lg border bg-card p-3 text-sm text-muted-foreground">Not enough candles for separate periods: {log.splitError ?? "unknown reason"}</p>}
        {!!log.walkForward.length && <>
          <h4 className="pt-2 text-xs font-medium text-muted-foreground">Walk-forward test windows</h4>
          <CompareTable rows={log.walkForward.map((f, i) => ({ label: `Window ${i + 1}`, m: f.metrics, extra: `${day(f.test.startT)} → ${day(f.test.endT)}` }))} />
        </>}
      </section>
      <section className="space-y-2"><h3 className="text-sm font-medium">Trade-by-trade history</h3>
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground">{["Side", "Entry", "Exit", "Entry price", "Exit price", "Bars", "Gross", "Fees", "Spread + slip", "Funding", "Net", "Reason"].map((h) => <th key={h} className="px-3 py-2 font-normal">{h}</th>)}</tr></thead>
            <tbody>{log.trades.slice().reverse().slice(0, 300).map((t, i) => (
              <tr key={i} className="border-t font-mono text-xs">
                <td className="px-3 py-2">{t.side}</td><td className="px-3 py-2">{new Date(t.entryT).toLocaleString()}</td><td className="px-3 py-2">{new Date(t.exitT).toLocaleString()}</td>
                <td className="px-3 py-2">{t.entry.toFixed(4)}</td><td className="px-3 py-2">{t.exit.toFixed(4)}</td><td className="px-3 py-2">{t.bars}</td>
                <td className={`px-3 py-2 ${tone(t.pnl)}`}>{t.pnl.toFixed(2)}</td><td className="px-3 py-2">{t.fees.toFixed(2)}</td><td className="px-3 py-2">{(t.spread + t.slippage).toFixed(2)}</td><td className="px-3 py-2">{t.funding.toFixed(2)}</td>
                <td className={`px-3 py-2 ${tone(t.net)}`}>{t.net.toFixed(2)}</td>
                <td className="px-3 py-2">{t.reason.replaceAll("_", " ")}{t.ambiguous && <Badge variant="outline" className="ml-1">stop-first</Badge>}</td>
              </tr>))}</tbody>
          </table>
          {!log.trades.length && <p className="p-4 text-sm text-muted-foreground">The rules never triggered in this period.</p>}
        </div>
      </section>
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">{[...log.limitations, log.costAssumptions].map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  );
}
