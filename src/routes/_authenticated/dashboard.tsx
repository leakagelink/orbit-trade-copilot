import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LineChart as LineIcon, Cable } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { computeMetrics, fmtMoney } from "@/lib/metrics";
import { exchangeName } from "@/lib/exchanges";
import { cn } from "@/lib/utils";

const D = "Portfolio metrics computed from your recorded trades, positions and balance snapshots.";
export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Dashboard — Quantra" }, { property: "og:description", content: D }] }),
  component: Dashboard,
});

const PERIODS = { "7": "7 days", "30": "30 days", "90": "90 days", "365": "1 year", all: "All time" } as const;

async function fetchAll() {
  const [trades, positions, snaps, bots, strategies, orders, conns] = await Promise.all([
    supabase.from("trades").select("*").order("closed_at", { ascending: false }).limit(1000),
    supabase.from("positions").select("*").eq("is_open", true),
    supabase.from("portfolio_snapshots").select("*").order("captured_at").limit(1000),
    supabase.from("trading_bots").select("id,status,name"),
    supabase.from("strategies").select("id,name,status"),
    supabase.from("orders").select("id,status,trading_pair,side,quantity,price,mode,exchange,exchange_connection_id,bot_id,created_at").in("status", ["pending", "open", "partially_filled"]),
    supabase.from("exchange_connections").select("id,label,exchange"),
  ]);
  const err = [trades, positions, snaps, bots, strategies, orders, conns].find((r) => r.error)?.error;
  if (err) throw new Error(err.message);
  return { trades: trades.data!, positions: positions.data!, snaps: snaps.data!, bots: bots.data!, strategies: strategies.data!, orders: orders.data!, conns: conns.data! };
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "gain" | "loss" | undefined }) {
  return (
    <div className="bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 font-mono text-lg font-medium", tone === "gain" && "text-gain", tone === "loss" && "text-loss")}>{value}</div>
    </div>
  );
}
const tone = (v: number | null) => (v == null || v === 0 ? undefined : v > 0 ? "gain" : "loss");

function Dashboard() {
  const q = useQuery({ queryKey: ["dashboard"], queryFn: fetchAll });
  const [account, setAccount] = useState("all");
  const [mode, setMode] = useState("all");
  const [pair, setPair] = useState("all");
  const [strategy, setStrategy] = useState("all");
  const [period, setPeriod] = useState<keyof typeof PERIODS>("30");

  const view = useMemo(() => {
    if (!q.data) return null;
    const cutoff = period === "all" ? 0 : Date.now() - Number(period) * 86_400_000;
    const match = (r: { exchange_connection_id: string | null; mode: string; trading_pair?: string; strategy_id?: string | null | undefined }) =>
      (account === "all" || r.exchange_connection_id === account) && (mode === "all" || r.mode === mode) &&
      (pair === "all" || r.trading_pair === pair) && (strategy === "all" || r.strategy_id === strategy);
    const trades = q.data.trades.filter((t) => match(t) && (!t.closed_at || new Date(t.closed_at).getTime() >= cutoff));
    const positions = q.data.positions.filter((p) => match({ ...p, strategy_id: undefined }) || (strategy !== "all" && match({ ...p, strategy_id: strategy })));
    const snaps = q.data.snaps.filter((s) => (account === "all" || s.exchange_connection_id === account) && (mode === "all" || s.mode === mode) && new Date(s.captured_at).getTime() >= cutoff);
    const orders = q.data.orders.filter((o) => match(o));
    const pairs = Array.from(new Set([...q.data.trades.map((t) => t.trading_pair), ...q.data.positions.map((p) => p.trading_pair)]));
    return { m: computeMetrics(trades, positions, snaps), trades, positions, orders, pairs };
  }, [q.data, account, mode, pair, strategy, period]);

  if (q.isError) return <div className="p-6 text-sm text-destructive">Couldn't load dashboard: {q.error.message}</div>;

  const filters = q.data && view && (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      <F value={account} onChange={setAccount} items={[["all", "All accounts"], ...q.data.conns.map((c) => [c.id, `${c.label} · ${exchangeName(c.exchange)}`] as [string, string])]} />
      <F value={mode} onChange={setMode} items={[["all", "All modes"], ["paper", "Paper"], ["live", "Live"]]} />
      <F value={pair} onChange={setPair} items={[["all", "All pairs"], ...view.pairs.map((p) => [p, p] as [string, string])]} />
      <F value={strategy} onChange={setStrategy} items={[["all", "All strategies"], ...q.data.strategies.map((s) => [s.id, s.name] as [string, string])]} />
      <F value={period} onChange={(v) => setPeriod(v as keyof typeof PERIODS)} items={Object.entries(PERIODS)} />
    </div>
  );

  return (
    <div>
      <PageHeader title="Dashboard" description="All figures come from your recorded trades — nothing is estimated." />
      <div className="space-y-6 p-6">
        {!q.data || !view ? (
          <div className="grid gap-3 sm:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
        ) : (
          <>
            {filters}
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
              <Stat label="Portfolio value" value={fmtMoney(view.m.portfolioValue)} />
              <Stat label="Available capital" value={fmtMoney(view.m.availableCapital)} />
              <Stat label="Realized PnL" value={fmtMoney(view.m.realizedPnl)} tone={tone(view.m.realizedPnl)} />
              <Stat label="Unrealized PnL" value={fmtMoney(view.m.unrealizedPnl)} tone={tone(view.m.unrealizedPnl)} />
              <Stat label="Daily PnL" value={fmtMoney(view.m.dailyPnl)} tone={tone(view.m.dailyPnl)} />
              <Stat label="Weekly PnL" value={fmtMoney(view.m.weeklyPnl)} tone={tone(view.m.weeklyPnl)} />
              <Stat label="Monthly PnL" value={fmtMoney(view.m.monthlyPnl)} tone={tone(view.m.monthlyPnl)} />
              <Stat label="Win rate" value={view.m.winRate == null ? "—" : `${view.m.winRate.toFixed(1)}%`} />
              <Stat label="Max drawdown" value={view.m.maxDrawdownPct == null ? "—" : `${view.m.maxDrawdownPct.toFixed(2)}%`} tone={view.m.maxDrawdownPct ? "loss" : undefined} />
              <Stat label="Active bots" value={String(q.data.bots.filter((b) => ["running", "paper_trading"].includes(b.status)).length)} />
              <Stat label="Running strategies" value={String(q.data.strategies.filter((s) => s.status === "deployed").length)} />
              <Stat label="Open positions / orders" value={`${view.positions.length} / ${view.orders.length}`} />
            </div>

            <div className="rounded-lg border bg-card p-4">
              <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"><h2 className="min-w-0 text-sm font-medium">Portfolio performance</h2><span className="shrink-0 font-mono text-xs text-muted-foreground">{view.m.closedTrades} closed trades</span></div>
              {view.m.equityCurve.length < 2 ? (
                <EmptyState icon={LineIcon} title="No performance history yet" body="Balance snapshots are recorded once a connected account or paper bot is running." action={q.data.conns.length === 0 ? <Button asChild size="sm"><Link to="/exchanges"><Cable className="mr-1 h-4 w-4" />Connect an exchange</Link></Button> : undefined} />
              ) : (
                <div className="h-64">
                  <ResponsiveContainer>
                    <AreaChart data={view.m.equityCurve}>
                      <defs><linearGradient id="eq" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} /><stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} /></linearGradient></defs>
                      <CartesianGrid stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="t" tickFormatter={(t: string) => new Date(t).toLocaleDateString()} stroke="var(--muted-foreground)" fontSize={11} />
                      <YAxis stroke="var(--muted-foreground)" fontSize={11} width={70} />
                      <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 6 }} labelFormatter={(t: string) => new Date(t).toLocaleString()} />
                      <Area dataKey="value" stroke="var(--chart-1)" fill="url(#eq)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <TableCard title="Open positions" empty="No open positions." rows={view.positions.map((p) => [p.trading_pair, p.side.toUpperCase(), Number(p.quantity).toString(), Number(p.entry_price).toString(), fmtMoney(Number(p.unrealized_pnl)), p.mode])} head={["Pair", "Side", "Qty", "Entry", "uPnL", "Mode"]} />
              <TableCard title="Recent closed trades" empty="No closed trades yet." rows={view.trades.filter((t) => t.closed_at).slice(0, 10).map((t) => [t.trading_pair, t.side.toUpperCase(), Number(t.entry_price).toString(), t.exit_price ? Number(t.exit_price).toString() : "—", fmtMoney(Number(t.realized_pnl) - Number(t.fees)), t.mode])} head={["Pair", "Side", "Entry", "Exit", "Net PnL", "Mode"]} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function F({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: [string, string][] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-full min-w-0 text-xs sm:w-auto sm:min-w-36"><SelectValue /></SelectTrigger>
      <SelectContent>{items.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function TableCard({ title, head, rows, empty }: { title: string; head: string[]; rows: string[][]; empty: string }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b px-4 py-3 text-sm font-medium">{title}</div>
      {rows.length === 0 ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">{empty}</p> : (
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground">{head.map((h) => <th key={h} className="px-4 py-2 font-normal">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t font-mono text-xs">{r.map((c, j) => <td key={j} className="px-4 py-2">{c}</td>)}</tr>)}</tbody></table></div>
      )}
    </div>
  );
}
