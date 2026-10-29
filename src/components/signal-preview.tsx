import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Area, ComposedChart, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { getCandles } from "@/lib/market.functions";
import { computeAll, evalRules, type Candle } from "@/lib/indicators";
import type { StrategyConfig } from "@/lib/strategy";
import { EXCHANGES } from "@/lib/exchanges";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

type Ex = "binance" | "bybit" | "okx" | "kucoin" | "coinbase";

/** Replays the rules over recent candles (long-only, one position) to show where they would fire. */
export function simulateSignals(cfg: StrategyConfig, cs: Candle[]) {
  const m = computeAll(cfg, cs);
  const marks: { i: number; kind: "entry" | "exit"; price: number }[] = [];
  let entry: number | null = null;
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i]!.c;
    if (entry == null) {
      if (evalRules(cfg.entry, m, i)) { entry = c; marks.push({ i, kind: "entry", price: c }); }
    } else {
      const sl = cfg.risk.stop_loss_pct != null && c <= entry * (1 - cfg.risk.stop_loss_pct / 100);
      const tp = cfg.risk.take_profit_pct != null && c >= entry * (1 + cfg.risk.take_profit_pct / 100);
      if (sl || tp || evalRules(cfg.exit, m, i)) { marks.push({ i, kind: "exit", price: c }); entry = null; }
    }
  }
  return marks;
}

export function SignalPreview({ cfg }: { cfg: StrategyConfig }) {
  const [exchange, setExchange] = useState<Ex>("binance");
  const pair = cfg.pairs[0] ?? "BTC/USDT";
  const fetchC = useServerFn(getCandles);
  const q = useQuery({
    queryKey: ["candles", exchange, pair, cfg.timeframe],
    queryFn: () => fetchC({ data: { exchange, pair, timeframe: cfg.timeframe as never } }),
    refetchInterval: 60_000,
    retry: false,
  });
  const cs = q.data?.candles ?? [];
  const marks = useMemo(() => (cs.length ? simulateSignals(cfg, cs) : []), [cfg, cs]);
  const data = cs.map((c, i) => ({ i, t: c.t, price: c.c }));
  const entries = marks.filter((x) => x.kind === "entry").map((x) => ({ i: x.i, price: x.price }));
  const exits = marks.filter((x) => x.kind === "exit").map((x) => ({ i: x.i, price: x.price }));
  const last = cs[cs.length - 1];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-sm">{pair} · {cfg.timeframe}{last && <span className="ml-3 text-lg">{last.c.toLocaleString()}</span>}</div>
        <Select value={exchange} onValueChange={(v) => setExchange(v as Ex)}>
          <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{EXCHANGES.filter((e) => e.available).map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {q.isLoading ? <Skeleton className="h-56" /> : q.data?.error ? <p className="text-sm text-destructive">{q.data.error}</p> : (
        <>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <XAxis dataKey="i" type="number" domain={[0, Math.max(data.length - 1, 1)]} hide />
                <YAxis dataKey="price" domain={["auto", "auto"]} width={70} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => v.toLocaleString()} labelFormatter={(i: number) => (data[i] ? new Date(data[i].t).toLocaleString() : "")} />
                <Area dataKey="price" type="monotone" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.08} dot={false} isAnimationActive={false} />
                <Scatter name="Entry" data={entries} dataKey="price" fill="var(--gain)" isAnimationActive={false} />
                <Scatter name="Exit" data={exits} dataKey="price" fill="var(--loss)" isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-muted-foreground">
            Live prices. <span className="text-gain">●</span> {entries.length} entries · <span className="text-loss">●</span> {exits.length} exits over the last {cs.length} candles — a quick preview of where your rules fire, not a backtest.
          </p>
        </>
      )}
    </div>
  );
}
