import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, EmptyState } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { futuresScore, netPnl } from "@/lib/futures-score";
import { Bot } from "lucide-react";

const D = "Every AI Futures trade with entry, exit, fees, net result and performance score.";
export const Route = createFileRoute("/_authenticated/ai-trades")({
  head: () => ({ meta: [{ title: "AI Trades — AlgoVirt" }, { name: "description", content: D }, { property: "og:title", content: "AI Trades — AlgoVirt" }, { property: "og:description", content: D }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }] }),
  component: AiTrades,
});
const usd = (n: number | null | undefined, d = 4) => (n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(d)}`);
const tone = (n: number) => (n > 0 ? "text-success" : n < 0 ? "text-destructive" : "");

function AiTrades() {
  const [acct, setAcct] = useState<"live" | "testnet">("live");
  const q = useQuery({
    queryKey: ["ai-trades"],
    queryFn: async () => {
      const [t, c, p] = await Promise.all([
        supabase.from("trades").select("id,trading_pair,side,quantity,entry_price,exit_price,realized_pnl,fees,funding_pnl,opened_at,closed_at,close_reason,exchange_connection_id").eq("market_type", "usd_m_futures").order("closed_at", { ascending: false }).limit(1000),
        supabase.from("exchange_connections").select("id,label,is_testnet,permissions").eq("exchange", "binance"),
        supabase.from("positions").select("id,trading_pair,side,quantity,entry_price,stop_loss,take_profit,opened_at,exchange_connection_id").eq("market_type", "usd_m_futures").eq("is_open", true),
      ]);
      if (t.error) throw new Error(t.error.message);
      return { trades: t.data ?? [], conns: c.data ?? [], open: p.data ?? [] };
    },
    refetchInterval: 15000,
  });
  const testIds = new Set((q.data?.conns ?? []).filter((c) => c.is_testnet).map((c) => c.id));
  const pick = <T extends { exchange_connection_id: string | null }>(rows: T[]) => rows.filter((r) => (acct === "testnet") === testIds.has(r.exchange_connection_id ?? ""));
  const trades = pick(q.data?.trades ?? []), open = pick(q.data?.open ?? []);
  const s = futuresScore(trades);
  const conn = (q.data?.conns ?? []).find((c) => !c.is_testnet === (acct === "live"));
  const bal = (conn?.permissions as { balances?: { asset: string; free: number; locked: number }[] } | null)?.balances ?? [];

  return (
    <div>
      <PageHeader title="AI Trades" description={D} actions={
        <Select value={acct} onValueChange={(v) => setAcct(v as "live" | "testnet")}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="live">Real money</SelectItem><SelectItem value="testnet">Practice (testnet)</SelectItem></SelectContent></Select>} />
      {q.isLoading ? <Skeleton className="h-64" /> : q.error ? <p className="text-destructive">{(q.error as Error).message}</p> : <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[["Net result", usd(s.netPnl), tone(s.netPnl)], ["Trades", String(s.count), ""], ["Win rate", s.winRate == null ? "—" : `${(s.winRate * 100).toFixed(0)}%`, ""], ["Profit factor", s.profitFactor == null ? "—" : s.profitFactor.toFixed(2), ""], ["Fees paid", usd(s.fees), ""], ["Avg per trade", usd(s.avgPnl), tone(s.avgPnl ?? 0)], ["Max drawdown", usd(s.maxDrawdown), ""], ["Wins / Losses", `${s.wins} / ${s.losses}`, ""]].map(([k, v, c]) => (
            <Card key={k}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{k}</p><p className={`font-mono text-lg font-semibold ${c}`}>{v}</p></CardContent></Card>))}
        </div>
        <Card><CardContent className="flex flex-wrap items-center gap-2 p-4 text-sm">
          <Badge variant={s.enoughEvidence ? "default" : "outline"}>{s.enoughEvidence ? "Enough trades to judge" : `Score is early: ${s.count}/30 trades`}</Badge>
          <span className="text-muted-foreground">Results include fees. A score is only meaningful after many trades.</span>
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Binance balance{conn ? ` · ${conn.label}` : ""}</CardTitle></CardHeader><CardContent className="font-mono text-sm">
          {bal.length ? bal.slice(0, 8).map((b) => <span key={b.asset} className="mr-4 inline-block">{b.asset} {(b.free + b.locked).toFixed(4)}</span>) : <span className="text-muted-foreground">No balance yet — click Verify on Exchanges.</span>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Open trades</CardTitle></CardHeader><CardContent className="overflow-x-auto">
          {open.length ? <table className="w-full text-sm"><thead className="text-left text-muted-foreground"><tr><th>Pair</th><th>Side</th><th>Qty</th><th>Entry</th><th>Stop</th><th>Target</th></tr></thead><tbody>
            {open.map((p) => <tr key={p.id} className="border-t"><td>{p.trading_pair}</td><td>{p.side === "buy" ? "Long" : "Short"}</td><td>{p.quantity}</td><td>{p.entry_price}</td><td>{p.stop_loss ?? "—"}</td><td>{p.take_profit ?? "—"}</td></tr>)}
          </tbody></table> : <p className="text-sm text-muted-foreground">No open trades.</p>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Trade history</CardTitle></CardHeader><CardContent className="overflow-x-auto">
          {trades.length ? <table className="w-full min-w-[720px] text-sm"><thead className="text-left text-muted-foreground"><tr><th>Closed</th><th>Pair</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Gross</th><th>Fees</th><th>Net</th><th>Reason</th></tr></thead><tbody>
            {trades.map((t) => { const n = netPnl(t); return <tr key={t.id} className="border-t"><td>{t.closed_at ? new Date(t.closed_at).toLocaleString() : "—"}</td><td>{t.trading_pair}</td><td>{t.side === "buy" ? "Long" : "Short"}</td><td>{t.quantity}</td><td>{t.entry_price}</td><td>{t.exit_price ?? "—"}</td><td className="font-mono">{usd(t.realized_pnl)}</td><td className="font-mono">{usd(t.fees)}</td><td className={`font-mono ${tone(n)}`}>{usd(n)}</td><td>{t.close_reason ?? "—"}</td></tr>; })}
          </tbody></table> : <EmptyState icon={Bot} title="No trades yet" body="AI Futures trades will appear here." />}
        </CardContent></Card>
      </div>}
    </div>
  );
}
