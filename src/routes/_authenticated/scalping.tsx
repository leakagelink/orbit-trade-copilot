import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowUpRight, ArrowDownRight, Zap, Timer, Bot, Wallet, XCircle } from "lucide-react";
import { ClientOnly } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CATEGORY_LABEL, MARKETS, marketOf, type MarketCategory } from "@/lib/markets";
import { EXCHANGES, exchangeName } from "@/lib/exchanges";
import { getMarketCandles, placeScalp, checkScalps, closeAllScalps, closeManualPosition } from "@/lib/trade.functions";
import { DEFAULT_SCALP, SCALP_TIMEFRAMES, WALLET_ROUND_TRIP_PCT, scalpBracket, scalpStats, scalpTemplates, validateScalp } from "@/lib/scalping";
import { createStrategy } from "@/lib/strategies.api";
import { TvChart } from "@/components/tv-chart";
import { fmtMoney } from "@/lib/metrics";

const D = "Fast one-click trades with an automatic tight stop, target and time limit. Elite plan.";
export const Route = createFileRoute("/_authenticated/scalping")({
  head: () => ({ meta: [{ title: "Scalping — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Scalping — Quantra" }, { property: "og:description", content: D }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }] }),
  component: ScalpingPage,
});

type Tf = (typeof SCALP_TIMEFRAMES)[number];
const HOLD_OPTIONS = [["off", "No limit"], ["1", "1 min"], ["3", "3 min"], ["5", "5 min"], ["15", "15 min"], ["30", "30 min"], ["60", "1 hour"]] as const;
const fmtPx = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 5 : 2 });

function Countdown({ until }: { until: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!until) return <span className="text-muted-foreground">—</span>;
  const s = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return <span className={s < 30 ? "text-loss" : ""}>{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

function ScalpingPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [cat, setCat] = useState<MarketCategory>("crypto");
  const [symbol, setSymbol] = useState("BTC/USDT");
  const [tf, setTf] = useState<Tf>("1m");
  const [accountId, setAccountId] = useState("paper");
  const [paperEx, setPaperEx] = useState("binance");
  const [amount, setAmount] = useState("100");
  const [tpPct, setTpPct] = useState(String(DEFAULT_SCALP.tpPct));
  const [slPct, setSlPct] = useState(String(DEFAULT_SCALP.slPct));
  const [hold, setHold] = useState(String(DEFAULT_SCALP.holdMin));
  const [busy, setBusy] = useState<"buy" | "sell" | null>(null);
  const [closing, setClosing] = useState(false);

  const getCandles = useServerFn(getMarketCandles);
  const place = useServerFn(placeScalp);
  const check = useServerFn(checkScalps);
  const closeAll = useServerFn(closeAllScalps);
  const closeOne = useServerFn(closeManualPosition);

  const market = marketOf(symbol)!;
  const nonCrypto = market.category !== "crypto";
  const accounts = useQuery({
    queryKey: ["trade_accounts"],
    queryFn: async () => {
      const { data, error } = await supabase.from("exchange_connections").select("id,label,exchange,is_testnet,status").eq("status", "connected");
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const usable = useMemo(
    () => (accounts.data ?? []).filter((c) => (nonCrypto ? c.exchange === "oanda" && market.oanda : c.exchange !== "oanda")),
    [accounts.data, nonCrypto, market.oanda],
  );
  const chosen = usable.find((c) => c.id === accountId);
  const isWallet = !chosen;
  const liveCrypto = !!chosen && chosen.exchange !== "oanda";

  const wallet = useQuery({
    queryKey: ["wallet_balance"],
    queryFn: async () => Number((await supabase.from("wallets").select("balance").maybeSingle()).data?.balance ?? 0),
  });
  const candles = useQuery({
    queryKey: ["scalp_candles", symbol, tf, chosen?.id ?? null, paperEx],
    queryFn: () => getCandles({ data: { symbol, timeframe: tf, connectionId: chosen?.id ?? null, paperExchange: paperEx as never } }),
    refetchInterval: 10_000,
    retry: false,
  });
  const scalps = useQuery({
    queryKey: ["open_scalps"],
    queryFn: async () => {
      const { data, error } = await supabase.from("positions").select("*").eq("is_scalp", true).eq("is_open", true).is("bot_id", null).order("opened_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const startOfDay = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }, []);
  const history = useQuery({
    queryKey: ["scalp_history", startOfDay],
    queryFn: async () => {
      const { data, error } = await supabase.from("trades").select("id,trading_pair,side,entry_price,exit_price,realized_pnl,fees,close_reason,closed_at").eq("is_scalp", true).gte("closed_at", startOfDay).order("closed_at", { ascending: false }).limit(200);
      if (error) throw new Error(error.message);
      return data;
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["open_scalps"] });
    qc.invalidateQueries({ queryKey: ["scalp_history"] });
    qc.invalidateQueries({ queryKey: ["wallet_balance"] });
  };

  // While scalps are open, ask the server to check stops/targets/time limits every 5 seconds.
  const openCount = scalps.data?.length ?? 0;
  useQuery({
    queryKey: ["scalp_check", openCount],
    enabled: openCount > 0,
    refetchInterval: 5_000,
    queryFn: async () => {
      const r = await check();
      const label: Record<string, string> = { stop_loss: "stop loss", take_profit: "take profit", time_stop: "time limit", broker_closed: "broker" };
      for (const c of r.closed) toast(`Scalp closed by ${label[c.reason] ?? c.reason}`);
      qc.invalidateQueries({ queryKey: ["open_scalps"] });
      if (r.closed.length) refresh();
      return r;
    },
  });

  const price = candles.data?.candles.at(-1)?.c;
  const settings = { tpPct: Number(tpPct), slPct: Number(slPct), holdMin: hold === "off" ? null : Number(hold) };
  const problem = validateScalp(settings, isWallet) ?? (Number(amount) > 0 ? null : "Enter an amount");
  const notional = chosen?.exchange === "oanda" ? Number(amount) * (price ?? 0) : Number(amount);
  const costPct = isWallet ? WALLET_ROUND_TRIP_PCT : 0;
  const winUsd = (notional * (settings.tpPct - costPct)) / 100;
  const lossUsd = (notional * (settings.slPct + costPct)) / 100;
  const stats = scalpStats((history.data ?? []).map((t) => ({ realized_pnl: Number(t.realized_pnl), fees: Number(t.fees) })));

  function pickCat(c: MarketCategory) {
    setCat(c);
    setSymbol(MARKETS.find((m) => m.category === c)!.symbol);
    setAccountId("paper");
  }

  async function go(side: "buy" | "sell") {
    if (busy || problem) return;
    setBusy(side);
    try {
      const r = await place({ data: { symbol, side, amount: Number(amount), tpPct: settings.tpPct, slPct: settings.slPct, holdMin: settings.holdMin, connectionId: chosen?.id ?? null, paperExchange: paperEx as never } });
      toast.success(`${side === "buy" ? "Long" : "Short"} ${symbol} @ ${fmtPx(r.price)} · SL ${r.sl != null ? fmtPx(r.sl) : "—"} · TP ${r.tp != null ? fmtPx(r.tp) : "—"}`);
      refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Order failed"); }
    setBusy(null);
  }

  async function exitOne(id: string) {
    try { const r = await closeOne({ data: { id } }); toast.success(`Closed · net ${fmtMoney(r.pnl)}`); refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Close failed"); }
  }
  async function exitAll() {
    setClosing(true);
    try {
      const r = await closeAll();
      toast.success(`Closed ${r.closed} scalp${r.closed === 1 ? "" : "s"} · net ${fmtMoney(r.net)}`);
      r.failed.forEach((f) => toast.error(f));
      refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Close failed"); }
    setClosing(false);
  }
  async function applyTemplate(t: ReturnType<typeof scalpTemplates>[number]) {
    try {
      const id = await createStrategy(t.name, t.config, "manual", t.description);
      toast.success("Scalping strategy created — review it, then deploy it to a bot");
      navigate({ to: "/strategies/$id", params: { id } });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not create the strategy"); }
  }

  const symbolScalps = (scalps.data ?? []).filter((p) => p.trading_pair === symbol);
  const preview = price != null ? { buy: scalpBracket("buy", price, settings.tpPct, settings.slPct), sell: scalpBracket("sell", price, settings.tpPct, settings.slPct) } : null;
  const chartLines = [
    ...symbolScalps.map((p) => ({ price: Number(p.entry_price), color: "--primary", title: p.side === "buy" ? "Long" : "Short" })),
    ...symbolScalps.filter((p) => p.stop_loss != null).map((p) => ({ price: Number(p.stop_loss), color: "--loss", title: "SL" })),
    ...symbolScalps.filter((p) => p.take_profit != null).map((p) => ({ price: Number(p.take_profit), color: "--gain", title: "TP" })),
  ];

  return (
    <div>
      <PageHeader title="Scalping" description={D} />
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(CATEGORY_LABEL) as MarketCategory[]).map((c) => (
              <Button key={c} size="sm" variant={cat === c ? "default" : "outline"} onClick={() => pickCat(c)}>{CATEGORY_LABEL[c]}</Button>
            ))}
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-96">
                {[...new Set(MARKETS.filter((m) => m.category === cat).map((m) => m.group ?? ""))].map((g) => (
                  <SelectGroup key={g}>
                    {g && <SelectLabel>{g}</SelectLabel>}
                    {MARKETS.filter((m) => m.category === cat && (m.group ?? "") === g).map((m) => <SelectItem key={m.symbol} value={m.symbol}>{m.symbol} — {m.name}</SelectItem>)}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <div className="flex rounded-md border">
              {SCALP_TIMEFRAMES.map((t) => (
                <Button key={t} size="sm" variant={tf === t ? "secondary" : "ghost"} className="rounded-none first:rounded-l-md last:rounded-r-md" onClick={() => setTf(t)}>{t}</Button>
              ))}
            </div>
            {price != null && <span className="font-mono text-lg">{fmtPx(price)}</span>}
            <span className="text-xs text-muted-foreground">Chart refreshes every 10s</span>
          </div>

          {candles.isLoading ? <Skeleton className="h-[420px]" /> : candles.data?.error ? (
            <p className="rounded-lg border bg-card p-4 text-sm text-destructive">{candles.data.error}</p>
          ) : (
            <div className="rounded-lg border bg-card p-2">
              <ClientOnly fallback={<Skeleton className="h-[420px]" />}>
                <TvChart candles={candles.data!.candles} lines={chartLines} />
              </ClientOnly>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Scalps today", String(stats.count)],
              ["Win rate", stats.count ? `${stats.winRate.toFixed(0)}%` : "—"],
              ["Wins / losses", `${stats.wins} / ${stats.count - stats.wins}`],
              ["Net today", fmtMoney(stats.net, "USD")],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border bg-card px-4 py-3">
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className={`font-mono text-lg ${k === "Net today" ? (stats.net >= 0 ? "text-gain" : "text-loss") : ""}`}>{v}</div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-2">
              <span className="text-sm font-medium">Open scalps</span>
              {openCount > 0 && <Button size="sm" variant="destructive" onClick={exitAll} disabled={closing}><XCircle className="mr-1 h-4 w-4" />{closing ? "Closing…" : "Close all"}</Button>}
            </div>
            {!openCount ? (
              <p className="p-4 text-sm text-muted-foreground">No open scalps. Stops, targets and time limits are checked every 5 seconds while this page is open, and every minute otherwise.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground">{["Market", "Side", "Entry", "Now", "PnL", "SL / TP", "Time left", ""].map((h) => <th key={h} className="px-4 py-2 font-normal">{h}</th>)}</tr></thead>
                  <tbody>
                    {scalps.data!.map((p) => (
                      <tr key={p.id} className="border-t font-mono text-xs">
                        <td className="px-4 py-2 font-sans text-sm">{p.trading_pair}<div className="text-xs text-muted-foreground">{p.wallet_margin != null ? "Demo wallet" : `${exchangeName(p.exchange)} · ${p.mode}`}</div></td>
                        <td className={`px-4 py-2 ${p.side === "buy" ? "text-gain" : "text-loss"}`}>{p.side === "buy" ? "long" : "short"}</td>
                        <td className="px-4 py-2">{fmtPx(Number(p.entry_price))}</td>
                        <td className="px-4 py-2">{p.current_price == null ? "—" : fmtPx(Number(p.current_price))}</td>
                        <td className={`px-4 py-2 ${Number(p.unrealized_pnl) >= 0 ? "text-gain" : "text-loss"}`}>{Number(p.unrealized_pnl).toFixed(2)}</td>
                        <td className="px-4 py-2 text-muted-foreground">{p.stop_loss != null ? fmtPx(Number(p.stop_loss)) : "—"} / {p.take_profit != null ? fmtPx(Number(p.take_profit)) : "—"}</td>
                        <td className="px-4 py-2"><Countdown until={p.max_hold_until} /></td>
                        <td className="px-4 py-2"><Button size="sm" variant="outline" onClick={() => exitOne(p.id)}>Close</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card">
            <div className="border-b px-4 py-2 text-sm font-medium">Today's scalps</div>
            {!history.data?.length ? (
              <p className="p-4 text-sm text-muted-foreground">No closed scalps today.</p>
            ) : (
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground">{["Time", "Market", "Side", "Entry → Exit", "Net", "Exit by"].map((h) => <th key={h} className="px-4 py-2 font-normal">{h}</th>)}</tr></thead>
                  <tbody>
                    {history.data.map((t) => {
                      const net = Number(t.realized_pnl) - Number(t.fees);
                      return (
                        <tr key={t.id} className="border-t font-mono text-xs">
                          <td className="px-4 py-2">{new Date(t.closed_at ?? 0).toLocaleTimeString()}</td>
                          <td className="px-4 py-2 font-sans">{t.trading_pair}</td>
                          <td className="px-4 py-2">{t.side === "buy" ? "long" : "short"}</td>
                          <td className="px-4 py-2">{fmtPx(Number(t.entry_price))} → {t.exit_price == null ? "—" : fmtPx(Number(t.exit_price))}</td>
                          <td className={`px-4 py-2 ${net >= 0 ? "text-gain" : "text-loss"}`}>{net.toFixed(2)}</td>
                          <td className="px-4 py-2 text-muted-foreground">{(t.close_reason ?? "").replace("_", " ")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-3 rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-sm font-medium"><Zap className="h-4 w-4 text-primary" />Scalp ticket</div>
            <div className="space-y-1.5">
              <Label className="text-xs">Account</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paper">Demo wallet</SelectItem>
                  {usable.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}{c.is_testnet ? " (testnet)" : ""}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {isWallet && (
              <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-xs">
                <span className="flex items-center gap-1.5 text-muted-foreground"><Wallet className="h-3.5 w-3.5" />Wallet</span>
                <span className="font-mono">{fmtMoney(wallet.data ?? 0, "USD")}</span>
                <Link to="/wallet" className="text-primary hover:underline">Deposit</Link>
              </div>
            )}
            {isWallet && !nonCrypto && (
              <div className="space-y-1.5">
                <Label className="text-xs">Prices from</Label>
                <Select value={paperEx} onValueChange={setPaperEx}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{EXCHANGES.filter((e) => e.available && e.kind === "crypto").map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">{chosen?.exchange === "oanda" ? "Units" : isWallet ? "Amount (USD)" : "Amount (USDT)"}</Label>
              <Input type="number" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" />
              {chosen?.exchange !== "oanda" && (
                <div className="flex gap-1">{[50, 100, 250, 500, 1000].map((v) => <Button key={v} size="sm" variant="outline" className="h-7 flex-1 px-1 text-xs" onClick={() => setAmount(String(v))}>{v}</Button>)}</div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label className="text-xs">Take profit %</Label><Input type="number" min={0} step="0.05" value={tpPct} onChange={(e) => setTpPct(e.target.value)} className="font-mono" /></div>
              <div className="space-y-1.5"><Label className="text-xs">Stop loss %</Label><Input type="number" min={0} step="0.05" value={slPct} onChange={(e) => setSlPct(e.target.value)} className="font-mono" /></div>
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-xs"><Timer className="h-3.5 w-3.5" />Close automatically after</Label>
              <Select value={hold} onValueChange={setHold}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{HOLD_OPTIONS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {problem ? <p className="text-xs text-destructive">{problem}</p> : (
              <div className="space-y-1 rounded-md bg-muted/50 px-3 py-2 font-mono text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">If target hit</span><span className="text-gain">≈ +{fmtMoney(winUsd, "USD")}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">If stop hit</span><span className="text-loss">≈ −{fmtMoney(lossUsd, "USD")}</span></div>
                {isWallet && <div className="text-muted-foreground">Includes ≈{WALLET_ROUND_TRIP_PCT.toFixed(2)}% fees + slippage</div>}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button variant="buy" className="h-14 flex-col gap-0" disabled={!!busy || !!problem} onClick={() => go("buy")}>
                <span className="flex items-center font-semibold"><ArrowUpRight className="mr-1 h-4 w-4" />{busy === "buy" ? "Buying…" : "Buy"}</span>
                {preview && <span className="font-mono text-[10px] opacity-80">TP {fmtPx(preview.buy.tp)}</span>}
              </Button>
              <Button variant="sell" className="h-14 flex-col gap-0" disabled={!!busy || !!problem || liveCrypto} onClick={() => go("sell")}>
                <span className="flex items-center font-semibold"><ArrowDownRight className="mr-1 h-4 w-4" />{busy === "sell" ? "Selling…" : "Sell"}</span>
                {preview && <span className="font-mono text-[10px] opacity-80">TP {fmtPx(preview.sell.tp)}</span>}
              </Button>
            </div>
            {liveCrypto && <p className="text-xs text-muted-foreground">Spot crypto accounts can only buy. Use the demo wallet or OANDA to sell short.</p>}
            {!isWallet && <p className="text-xs text-destructive">Real order on {exchangeName(chosen!.exchange)}{chosen!.is_testnet ? " (testnet)" : ""}. Exits are market orders, so the fill can be worse than your stop.</p>}
            <p className="text-xs text-muted-foreground">One click places the trade at market. Stop and target are set from the live price on the server.</p>
          </div>

          <div className="space-y-3 rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-sm font-medium"><Bot className="h-4 w-4 text-primary" />Scalping bots</div>
            <p className="text-xs text-muted-foreground">Start from a ready-made fast strategy for {symbol}, backtest it, then deploy it to a bot (paper first). Bots check every minute.</p>
            {scalpTemplates(nonCrypto ? "BTC/USDT" : symbol).map((t) => (
              <div key={t.name} className="space-y-1 rounded-md border p-3">
                <div className="text-sm font-medium">{t.name}</div>
                <p className="text-xs text-muted-foreground">{t.description} SL {t.config.risk.stop_loss_pct}% · TP {t.config.risk.take_profit_pct}%</p>
                <Button size="sm" variant="outline" onClick={() => applyTemplate(t)}>Use template</Button>
              </div>
            ))}
            {nonCrypto && <p className="text-xs text-muted-foreground">Bots trade crypto; templates use BTC/USDT.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
