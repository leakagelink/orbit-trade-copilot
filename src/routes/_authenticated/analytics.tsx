import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { LineChart as LineIcon } from "lucide-react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, EmptyState } from "@/components/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtMoney, groupStats, monthlyPnl } from "@/lib/metrics";

const D = "Performance by bot, strategy and pair, computed from your closed trades.";
export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({ meta: [{ title: "Analytics — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Analytics — Quantra" }, { property: "og:description", content: D }] }),
  component: Analytics,
});

function Analytics() {
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [by, setBy] = useState<"bot" | "strategy" | "pair">("bot");
  const q = useQuery({
    queryKey: ["analytics", mode],
    queryFn: async () => {
      const [t, b, s] = await Promise.all([
        supabase.from("trades").select("realized_pnl,fees,closed_at,bot_id,strategy_id,trading_pair").eq("mode", mode).not("closed_at", "is", null).limit(5000),
        supabase.from("trading_bots").select("id,name"),
        supabase.from("strategies").select("id,name"),
      ]);
      if (t.error) throw new Error(t.error.message);
      return { trades: t.data, bots: new Map((b.data ?? []).map((x) => [x.id, x.name])), strats: new Map((s.data ?? []).map((x) => [x.id, x.name])) };
    },
  });
  const rows = q.data ? groupStats(q.data.trades, (t) => (by === "bot" ? t.bot_id : by === "strategy" ? t.strategy_id : t.trading_pair)) : [];
  const label = (k: string) => (by === "bot" ? q.data?.bots.get(k) : by === "strategy" ? q.data?.strats.get(k) : k) ?? (k === "—" ? "Manual" : "Deleted");
  const months = q.data ? monthlyPnl(q.data.trades) : [];

  return (
    <div>
      <PageHeader title="Analytics" description={D} actions={<>
        <Select value={mode} onValueChange={(v) => setMode(v as "paper" | "live")}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="paper">Paper</SelectItem><SelectItem value="live">Live</SelectItem></SelectContent></Select>
        <Select value={by} onValueChange={(v) => setBy(v as typeof by)}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bot">By bot</SelectItem><SelectItem value="strategy">By strategy</SelectItem><SelectItem value="pair">By pair</SelectItem></SelectContent></Select>
      </>} />
      <div className="space-y-6 p-6">
        {q.isLoading ? <Skeleton className="h-64" /> : q.isError ? <p className="text-sm text-destructive">{q.error.message}</p> : !q.data?.trades.length ? (
          <EmptyState icon={LineIcon} title="No closed trades yet" body="Start a bot in paper mode. Reports fill in as trades close." />
        ) : (
          <>
            <div className="h-56 rounded-lg border bg-card p-3">
              <div className="mb-2 text-sm font-medium">Monthly net PnL</div>
              <ResponsiveContainer width="100%" height="85%">
                <BarChart data={months}><XAxis dataKey="month" tick={{ fontSize: 11 }} /><YAxis width={70} tick={{ fontSize: 11 }} /><Tooltip formatter={(v: number) => v.toFixed(2)} />
                  <Bar dataKey="pnl" isAnimationActive={false}>{months.map((m) => <Cell key={m.month} fill={m.pnl >= 0 ? "var(--gain)" : "var(--loss)"} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted-foreground">{[by === "pair" ? "Pair" : by === "bot" ? "Bot" : "Strategy", "Trades", "Net PnL", "Win rate", "Profit factor", "Avg win", "Avg loss", "Best", "Worst"].map((h) => <th key={h} className="px-4 py-2 font-normal">{h}</th>)}</tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.key} className="border-t font-mono text-xs">
                    <td className="px-4 py-2 font-sans text-sm">{label(r.key)}</td><td className="px-4 py-2">{r.trades}</td>
                    <td className={`px-4 py-2 ${r.net >= 0 ? "text-gain" : "text-loss"}`}>{fmtMoney(r.net)}</td>
                    <td className="px-4 py-2">{r.winRate.toFixed(1)}%</td><td className="px-4 py-2">{r.profitFactor == null ? "—" : r.profitFactor.toFixed(2)}</td>
                    <td className="px-4 py-2">{fmtMoney(r.avgWin, "")}</td><td className="px-4 py-2">{fmtMoney(r.avgLoss, "")}</td>
                    <td className="px-4 py-2">{r.best.toFixed(2)}</td><td className="px-4 py-2">{r.worst.toFixed(2)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
