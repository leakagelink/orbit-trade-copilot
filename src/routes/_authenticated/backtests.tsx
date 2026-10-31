import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, EmptyState } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtMoney } from "@/lib/metrics";

const D = "Results of your strategy backtests on historical market data.";
export const Route = createFileRoute("/_authenticated/backtests")({
  head: () => ({ meta: [{ title: "Backtests — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Backtests — Quantra" }, { property: "og:description", content: D }] }),
  validateSearch: (s: Record<string, unknown>): { id?: string } => (typeof s["id"] === "string" ? { id: s["id"] } : {}),
  component: Backtests,
});

interface LogTrade { entryT: number; exitT: number; entry: number; exit: number; pnl: number; fees: number; reason: string }

function Backtests() {
  const { id } = Route.useSearch();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["backtests"],
    queryFn: async () => {
      const { data, error } = await supabase.from("backtests").select("*, strategies(name), backtest_results(*)").order("created_at", { ascending: false }).limit(100);
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const sel = q.data?.find((b) => b.id === id) ?? q.data?.[0];
  const res = sel ? (Array.isArray(sel.backtest_results) ? sel.backtest_results[0] : sel.backtest_results) : null;
  const log = (res?.trade_log ?? {}) as { sharpe?: number | null; candles?: number; exchange?: string; trades?: LogTrade[] };
  const curve = ((res?.equity_curve ?? []) as { t: number; v: number }[]).map((e) => ({ t: new Date(e.t).toLocaleDateString(), v: e.v }));
  const pct = (v: number | null | undefined) => (v == null ? "—" : `${Number(v).toFixed(2)}%`);

  return (
    <div>
      <PageHeader title="Backtests" description={D} />
      <div className="grid gap-6 p-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="space-y-2">
          {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.length ? (
            <EmptyState icon={FlaskConical} title="No backtests yet" body="Open a strategy and click Backtest." action={<Link to="/strategies" className="text-sm text-primary hover:underline">Open strategies</Link>} />
          ) : q.data.map((b) => (
            <button key={b.id} onClick={() => navigate({ to: "/backtests", search: { id: b.id } })} className={`w-full rounded-lg border p-3 text-left text-sm transition-colors hover:bg-accent ${sel?.id === b.id ? "border-primary bg-accent" : "bg-card"}`}>
              <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{b.strategies?.name ?? "Strategy"}</span><Badge variant={b.status === "completed" ? "default" : b.status === "failed" ? "destructive" : "secondary"}>{b.status}</Badge></div>
              <div className="mt-1 font-mono text-xs text-muted-foreground">{b.trading_pair} · {b.timeframe} · {new Date(b.created_at).toLocaleString()}</div>
            </button>
          ))}
        </div>
        {sel && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-medium">{sel.strategies?.name} <span className="font-mono text-sm text-muted-foreground">v{sel.strategy_version} · {sel.trading_pair} · {sel.timeframe}</span></h2>
              <p className="text-xs text-muted-foreground">{new Date(sel.start_date).toLocaleDateString()} → {new Date(sel.end_date).toLocaleDateString()} · {log.candles ?? "—"} candles from {log.exchange ?? "—"} · fee {Number(sel.fee_pct)}% · slippage {Number(sel.slippage_pct)}%</p>
              {sel.error && <p className="mt-2 text-sm text-destructive">{sel.error}</p>}
            </div>
            {res && (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {[
                    ["Net profit", fmtMoney(res.net_profit), Number(res.net_profit) >= 0],
                    ["Return", pct(res.total_return_pct), Number(res.total_return_pct) >= 0],
                    ["Win rate", pct(res.win_rate_pct), null],
                    ["Trades", String(res.total_trades ?? 0), null],
                    ["Profit factor", res.profit_factor == null ? "—" : Number(res.profit_factor).toFixed(2), null],
                    ["Max drawdown", pct(res.max_drawdown_pct), null],
                    ["Sharpe (annualized)", log.sharpe == null ? "—" : log.sharpe.toFixed(2), null],
                    ["Avg win / loss", `${fmtMoney(res.avg_win, "")} / ${fmtMoney(res.avg_loss, "")}`, null],
                  ].map(([l, v, g]) => (
                    <div key={l as string} className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">{l}</div><div className={`mt-1 font-mono text-lg ${g === true ? "text-gain" : g === false ? "text-loss" : ""}`}>{v}</div></div>
                  ))}
                </div>
                <div className="h-64 rounded-lg border bg-card p-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={curve}><XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} /><YAxis domain={["auto", "auto"]} width={70} tick={{ fontSize: 11 }} /><Tooltip formatter={(v: number) => v.toFixed(2)} /><Area dataKey="v" name="Equity" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.1} isAnimationActive={false} /></AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="overflow-x-auto rounded-lg border bg-card">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs text-muted-foreground">{["Entry", "Exit", "Entry price", "Exit price", "Net PnL", "Reason"].map((h) => <th key={h} className="px-3 py-2 font-normal">{h}</th>)}</tr></thead>
                    <tbody>{(log.trades ?? []).slice().reverse().slice(0, 200).map((t, i) => (
                      <tr key={i} className="border-t font-mono text-xs">
                        <td className="px-3 py-2">{new Date(t.entryT).toLocaleString()}</td><td className="px-3 py-2">{new Date(t.exitT).toLocaleString()}</td>
                        <td className="px-3 py-2">{t.entry.toFixed(2)}</td><td className="px-3 py-2">{t.exit.toFixed(2)}</td>
                        <td className={`px-3 py-2 ${t.pnl - t.fees >= 0 ? "text-gain" : "text-loss"}`}>{(t.pnl - t.fees).toFixed(2)}</td><td className="px-3 py-2">{t.reason.replace("_", " ")}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                  {!log.trades?.length && <p className="p-4 text-sm text-muted-foreground">The rules never triggered in this period.</p>}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
