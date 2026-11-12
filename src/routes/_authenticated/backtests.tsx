import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, EmptyState } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtMoney } from "@/lib/metrics";
import { DataCompleteness, V3Report, type InsufficientLog, type V3Log } from "@/components/historical/v3-report";
import { ResearchOutcomesPanel } from "@/components/historical/research-outcomes-panel";

const D = "Historical evaluation of your strategies on real past prices: data checks, time-ordered test periods, costs and benchmarks.";
export const Route = createFileRoute("/_authenticated/backtests")({
  head: () => ({ meta: [{ title: "Historical evaluation — AlgoVirt" }, { name: "description", content: D }, { property: "og:title", content: "Historical evaluation — AlgoVirt" }, { property: "og:description", content: D }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }] }),
  validateSearch: (s: Record<string, unknown>): { id?: string } => (typeof s["id"] === "string" ? { id: s["id"] } : {}),
  component: Backtests,
});

interface LogTrade { entryT: number; exitT: number; entry: number; exit: number; pnl: number; fees: number; reason: string }
const STATUS_LABEL: Record<string, string> = { completed: "completed", failed: "failed", running: "running", insufficient_data: "insufficient data" };

function Backtests() {
  const { id } = Route.useSearch();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["backtests"],
    queryFn: async () => {
      // The list stays light; the full evidence (candles, trades, benchmarks) is loaded only for the selected run.
      const { data, error } = await supabase.from("backtests").select("id,status,error,trading_pair,timeframe,created_at,strategy_version,start_date,end_date,starting_capital,fee_pct,slippage_pct,strategies(name)").order("created_at", { ascending: false }).limit(100);
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const sel = q.data?.find((b) => b.id === id) ?? q.data?.[0];
  const detail = useQuery({
    queryKey: ["backtest-result", sel?.id], enabled: !!sel,
    queryFn: async () => {
      const { data, error } = await supabase.from("backtest_results").select("*").eq("backtest_id", sel!.id).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const res = detail.data ?? null;
  const raw = (res?.trade_log ?? {}) as Record<string, unknown>;
  const isV3 = (raw["manifest"] as { simulatorVersion?: string } | undefined)?.simulatorVersion === "next-bar-v3" && raw["status"] === "completed";
  const insufficient = raw["status"] === "insufficient_data" ? (raw as unknown as InsufficientLog) : null;
  const tfLabel = sel ? `${sel.trading_pair} · Spot · ${sel.timeframe}` : "";

  return (
    <div>
      <PageHeader title="Historical evaluation" description={D} />
      <div className="px-6 pt-4">
        <Tabs defaultValue="strategies">
          <TabsList><TabsTrigger value="strategies">Strategy backtests</TabsTrigger><TabsTrigger value="research">Stored AI research decisions</TabsTrigger></TabsList>
          <TabsContent value="research" className="pb-6 pt-4"><ResearchOutcomesPanel /></TabsContent>
          <TabsContent value="strategies">
            <div className="grid gap-6 py-4 lg:grid-cols-[300px_minmax(0,1fr)]">
              <div className="max-h-80 space-y-2 overflow-y-auto lg:max-h-none lg:overflow-visible">
                {q.isLoading ? <Skeleton className="h-40" /> : q.error ? <p className="text-sm text-loss">Backtests could not be loaded.</p> : !q.data?.length ? (
                  <EmptyState icon={FlaskConical} title="No backtests yet" body="Open a strategy and click Backtest." action={<Link to="/strategies" className="text-sm text-primary hover:underline">Open strategies</Link>} />
                ) : q.data.map((b) => (
                  <button key={b.id} onClick={() => navigate({ to: "/backtests", search: { id: b.id } })} className={`w-full rounded-lg border p-3 text-left text-sm transition-colors hover:bg-accent ${sel?.id === b.id ? "border-primary bg-accent" : "bg-card"}`}>
                    <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{b.strategies?.name ?? "Strategy"}</span><Badge variant={b.status === "completed" ? "default" : b.status === "failed" || b.status === "insufficient_data" ? "destructive" : "secondary"}>{STATUS_LABEL[b.status] ?? b.status}</Badge></div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{b.trading_pair} · {b.timeframe} · {new Date(b.created_at).toLocaleString()}</div>
                  </button>
                ))}
              </div>
              {sel && (
                <div className="min-w-0 space-y-6">
                  <div>
                    <h2 className="text-lg font-medium">{sel.strategies?.name} <span className="font-mono text-sm text-muted-foreground">v{sel.strategy_version} · {tfLabel}</span></h2>
                    <p className="text-xs text-muted-foreground">{new Date(sel.start_date).toLocaleDateString()} → {new Date(sel.end_date).toLocaleDateString()} · {String(raw["candles"] ?? "—")} candles from {String(raw["exchange"] ?? (insufficient?.data.source.provider ?? "—"))} · starting capital {fmtMoney(sel.starting_capital)} · fee {Number(sel.fee_pct)}% · slippage {Number(sel.slippage_pct)}%{isV3 ? ` · spread ${(raw as unknown as V3Log).manifest.spreadPct}% · max ${(raw as unknown as V3Log).manifest.maxParticipationPct ?? "—"}% of candle volume` : ""}</p>
                    {sel.error && <p className={`mt-2 text-sm ${sel.status === "insufficient_data" ? "text-warning" : "text-loss"}`}>{sel.error}</p>}
                  </div>
                  {detail.isLoading && <Skeleton className="h-64" />}
                  {detail.error && <p className="text-sm text-loss">The saved results could not be loaded.</p>}
                  {insufficient && <><p className="flex gap-2 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 text-warning" />Insufficient data: nothing was simulated, and no missing candles were filled in.</p><DataCompleteness integrity={insufficient.integrity} sha={insufficient.data.candleSha256} /></>}
                  {res && isV3 && <V3Report log={raw as unknown as V3Log} capital={Number(sel.starting_capital)} />}
                  {res && !isV3 && !insufficient && <LegacyReport res={res} log={raw as { sharpe?: number | null; trades?: LogTrade[] }} />}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function LegacyReport({ res, log }: { res: { net_profit: number | null; total_return_pct: number | null; win_rate_pct: number | null; total_trades: number | null; profit_factor: number | null; max_drawdown_pct: number | null; avg_win: number | null; avg_loss: number | null; equity_curve: unknown }; log: { sharpe?: number | null; trades?: LogTrade[] } }) {
  const curve = ((res.equity_curve ?? []) as { t: number; v: number }[]).map((e) => ({ t: new Date(e.t).toLocaleDateString(), v: e.v }));
  const pct = (v: number | null | undefined) => (v == null ? "—" : `${Number(v).toFixed(2)}%`);
  return (
    <>
      <p className="rounded-lg border bg-card p-3 text-xs text-muted-foreground">Earlier engine (v2). Kept exactly as recorded so its evidence still replays. It has no data checks, time-ordered periods or benchmarks, processed intrabar stops before opening exits and left final closing costs out of the equity curve. Run a new backtest for the corrected engine.</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[["Net profit", fmtMoney(res.net_profit), Number(res.net_profit) >= 0], ["Return", pct(res.total_return_pct), Number(res.total_return_pct) >= 0], ["Win rate", pct(res.win_rate_pct), null], ["Trades", String(res.total_trades ?? 0), null],
          ["Profit factor", res.profit_factor == null ? "—" : Number(res.profit_factor).toFixed(2), null], ["Max drawdown", pct(res.max_drawdown_pct), null], ["Sharpe (annualized)", log.sharpe == null ? "—" : log.sharpe.toFixed(2), null], ["Avg win / loss", `${fmtMoney(res.avg_win, "")} / ${fmtMoney(res.avg_loss, "")}`, null],
        ].map(([l, v, g]) => <div key={l as string} className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">{l}</div><div className={`mt-1 font-mono text-lg ${g === true ? "text-gain" : g === false ? "text-loss" : ""}`}>{v}</div></div>)}
      </div>
      <div className="h-64 rounded-lg border bg-card p-3"><ResponsiveContainer width="100%" height="100%"><AreaChart data={curve}><XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} /><YAxis domain={["auto", "auto"]} width={70} tick={{ fontSize: 11 }} /><Tooltip formatter={(v: number) => v.toFixed(2)} /><Area dataKey="v" name="Equity" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.1} isAnimationActive={false} /></AreaChart></ResponsiveContainer></div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground">{["Entry", "Exit", "Entry price", "Exit price", "Net PnL", "Reason"].map((h) => <th key={h} className="px-3 py-2 font-normal">{h}</th>)}</tr></thead>
          <tbody>{(log.trades ?? []).slice().reverse().slice(0, 200).map((t, i) => (
            <tr key={i} className="border-t font-mono text-xs"><td className="px-3 py-2">{new Date(t.entryT).toLocaleString()}</td><td className="px-3 py-2">{new Date(t.exitT).toLocaleString()}</td><td className="px-3 py-2">{t.entry.toFixed(2)}</td><td className="px-3 py-2">{t.exit.toFixed(2)}</td><td className={`px-3 py-2 ${t.pnl - t.fees >= 0 ? "text-gain" : "text-loss"}`}>{(t.pnl - t.fees).toFixed(2)}</td><td className="px-3 py-2">{t.reason.replace("_", " ")}</td></tr>
          ))}</tbody>
        </table>
        {!log.trades?.length && <p className="p-4 text-sm text-muted-foreground">The rules never triggered in this period.</p>}
      </div>
    </>
  );
}
