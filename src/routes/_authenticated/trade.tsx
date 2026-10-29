import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowUpRight, ArrowDownRight, Bot, Sparkles } from "lucide-react";
import { ClientOnly } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CATEGORY_LABEL, MARKETS, marketOf, type MarketCategory } from "@/lib/markets";
import { EXCHANGES, exchangeName } from "@/lib/exchanges";
import { TIMEFRAMES } from "@/lib/strategy";
import { closeManualPosition, getMarketCandles, placeManualOrder, aiTradeIdea, type TradeIdea } from "@/lib/trade.functions";
import { TvChart } from "@/components/tv-chart";
import { fmtMoney } from "@/lib/metrics";

const D = "Manual trading: crypto, forex and commodities with an AI trade idea.";
export const Route = createFileRoute("/_authenticated/trade")({
  head: () => ({ meta: [{ title: "Trade — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Trade — Quantra" }, { property: "og:description", content: D }] }),
  validateSearch: (s: Record<string, unknown>): { symbol?: string } => (typeof s["symbol"] === "string" ? { symbol: s["symbol"] } : {}),
  component: TradePage,
});

type Tf = (typeof TIMEFRAMES)[number];

function TradePage() {
  const qc = useQueryClient();
  const preset = Route.useSearch().symbol;
  const [cat, setCat] = useState<MarketCategory>(marketOf(preset ?? "")?.category ?? "crypto");
  const [symbol, setSymbol] = useState(preset && marketOf(preset) ? preset : "BTC/USDT");
  const [tf, setTf] = useState<Tf>("1h");
  const [accountId, setAccountId] = useState("paper");
  const [paperEx, setPaperEx] = useState("binance");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("100");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [busy, setBusy] = useState(false);
  const [ideaBusy, setIdeaBusy] = useState(false);
  const [idea, setIdea] = useState<TradeIdea | null>(null);

  const getCandles = useServerFn(getMarketCandles);
  const place = useServerFn(placeManualOrder);
  const closePos = useServerFn(closeManualPosition);
  const getIdea = useServerFn(aiTradeIdea);

  const connId = accountId === "paper" ? null : accountId;
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
    () => (accounts.data ?? []).filter((c) => (nonCrypto ? c.exchange === "oanda" : c.exchange !== "oanda")),
    [accounts.data, nonCrypto],
  );
  const chosen = usable.find((c) => c.id === connId);
  const needsOanda = nonCrypto && !chosen;
  const canTrade = !needsOanda && !busy;

  const candles = useQuery({
    queryKey: ["trade_candles", symbol, tf, connId, paperEx],
    queryFn: () => getCandles({ data: { symbol, timeframe: tf, connectionId: connId, paperExchange: paperEx as never } }),
    refetchInterval: 30_000,
    retry: false,
  });
  const positions = useQuery({
    queryKey: ["manual_positions"],
    queryFn: async () => {
      const { data, error } = await supabase.from("positions").select("*").is("bot_id", null).eq("is_open", true).order("opened_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data;
    },
    refetchInterval: 30_000,
  });

  const price = candles.data?.candles.at(-1)?.c;
  const symbolPositions = (positions.data ?? []).filter((p) => p.trading_pair === symbol);
  const liveCrypto = !!chosen && chosen.exchange !== "oanda";
  const sellBlocked = side === "sell" && liveCrypto;

  function pickCat(c: MarketCategory) {
    setCat(c);
    const first = MARKETS.find((m) => m.category === c)!;
    setSymbol(first.symbol);
    setIdea(null);
    if (c !== "crypto") setAccountId((accounts.data ?? []).find((a) => a.exchange === "oanda")?.id ?? "paper");
  }

  async function submit() {
    if (!canTrade) return;
    setBusy(true);
    try {
      const r = await place({ data: { symbol, side, amount: Number(amount), sl: sl === "" ? null : Number(sl), tp: tp === "" ? null : Number(tp), connectionId: connId, paperExchange: paperEx as never } });
      toast.success(`${side === "buy" ? "Bought" : "Sold"} ${r.qty.toPrecision(6)} ${symbol} @ ${r.price.toFixed(4)}`);
      setSl(""); setTp(""); setIdea(null);
      qc.invalidateQueries({ queryKey: ["manual_positions"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Order failed"); }
    setBusy(false);
  }

  async function close(id: string) {
    try {
      const r = await closePos({ data: { id } });
      toast.success(`Closed @ ${r.exit.toFixed(4)} · net ${fmtMoney(r.pnl)}`);
      qc.invalidateQueries({ queryKey: ["manual_positions"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Close failed"); }
  }

  async function analyze() {
    setIdeaBusy(true); setIdea(null);
    try {
      const r = await getIdea({ data: { symbol, timeframe: tf, connectionId: connId, paperExchange: paperEx as never } });
      setIdea(r);
      if (r.entry != null && r.stop_loss != null) setSl(String(+r.stop_loss.toFixed(5)));
      if (r.entry != null && r.take_profit != null) setTp(String(+r.take_profit.toFixed(5)));
    } catch (e) { toast.error(e instanceof Error ? e.message : "AI analysis failed"); }
    setIdeaBusy(false);
  }

  const chartLines = [
    ...(symbolPositions.map((p) => ({ price: Number(p.entry_price), color: "--primary", title: `${p.side === "buy" ? "Long" : "Short"} ${Number(p.quantity).toPrecision(4)}` }))),
    ...symbolPositions.filter((p) => p.stop_loss != null).map((p) => ({ price: Number(p.stop_loss), color: "--loss", title: "SL" })),
    ...symbolPositions.filter((p) => p.take_profit != null).map((p) => ({ price: Number(p.take_profit), color: "--gain", title: "TP" })),
    ...(idea?.entry != null ? [{ price: idea.entry, color: "--primary", title: "AI entry" }] : []),
  ];

  return (
    <div>
      <PageHeader title="Trade" description={D} />
      <div className="grid gap-4 p-4 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(CATEGORY_LABEL) as MarketCategory[]).map((c) => (
              <Button key={c} size="sm" variant={cat === c ? "default" : "outline"} onClick={() => pickCat(c)}>{CATEGORY_LABEL[c]}</Button>
            ))}
            <Select value={symbol} onValueChange={(v) => { setSymbol(v); setIdea(null); }}>
              <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
              <SelectContent>{MARKETS.filter((m) => m.category === cat).map((m) => <SelectItem key={m.symbol} value={m.symbol}>{m.symbol} — {m.name}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={tf} onValueChange={(v) => setTf(v as Tf)}>
              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>{TIMEFRAMES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
            {price != null && <span className="font-mono text-lg">{price.toLocaleString(undefined, { maximumFractionDigits: 5 })}</span>}
            <Button size="sm" variant="outline" onClick={analyze} disabled={ideaBusy || needsOanda}>
              <Sparkles className="mr-1 h-4 w-4" />{ideaBusy ? "Analyzing…" : "AI analyze"}
            </Button>
          </div>

          {needsOanda ? (
            <div className="rounded-lg border bg-card p-6 text-sm">
              <p className="font-medium">Forex & commodities need an OANDA account</p>
              <p className="mt-1 text-muted-foreground">Create a free practice account at oanda.com, then add it on the Exchanges page (Practice account on). Crypto works without it.</p>
              <Button className="mt-3" size="sm" asChild><Link to="/exchanges">Open Exchanges</Link></Button>
            </div>
          ) : candles.isLoading ? <Skeleton className="h-[420px]" /> : candles.data?.error ? (
            <p className="rounded-lg border bg-card p-4 text-sm text-destructive">{candles.data.error}</p>
          ) : (
            <div className="rounded-lg border bg-card p-2">
              <ClientOnly fallback={<Skeleton className="h-[420px]" />}>
                <TvChart candles={candles.data!.candles} lines={chartLines} />
              </ClientOnly>
            </div>
          )}

          {idea && (
            <div className="space-y-2 rounded-lg border bg-card p-4 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <Sparkles className="h-4 w-4 text-primary" />AI view on {symbol}
                <Badge variant={idea.bias === "long" ? "default" : idea.bias === "short" ? "destructive" : "secondary"}>{idea.bias}</Badge>
                <span className="font-mono text-xs text-muted-foreground">confidence {idea.confidence}%</span>
              </div>
              <p className="text-muted-foreground">{idea.rationale}</p>
              <div className="flex flex-wrap gap-4 font-mono text-xs">
                {idea.entry != null && <span>entry {idea.entry}</span>}
                {idea.stop_loss != null && <span className="text-loss">SL {idea.stop_loss}</span>}
                {idea.take_profit != null && <span className="text-gain">TP {idea.take_profit}</span>}
              </div>
              <p className="text-xs text-muted-foreground">Not financial advice. The stop/target fields were filled for you — review before ordering.</p>
            </div>
          )}

          <div className="rounded-lg border bg-card">
            <div className="border-b px-4 py-2 text-sm font-medium">Open positions</div>
            {!positions.data?.length ? (
              <p className="p-4 text-sm text-muted-foreground">No manual positions.</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted-foreground">{["Market", "Side", "Qty", "Entry", "Current", "PnL", "SL / TP", ""].map((h) => <th key={h} className="px-4 py-2 font-normal">{h}</th>)}</tr></thead>
                <tbody>
                  {positions.data.map((p) => (
                    <tr key={p.id} className="border-t font-mono text-xs">
                      <td className="px-4 py-2 font-sans text-sm">{p.trading_pair}<div className="text-xs text-muted-foreground">{exchangeName(p.exchange)} · {p.mode}</div></td>
                      <td className={`px-4 py-2 ${p.side === "buy" ? "text-gain" : "text-loss"}`}>{p.side}</td>
                      <td className="px-4 py-2">{Number(p.quantity).toPrecision(6)}</td>
                      <td className="px-4 py-2">{Number(p.entry_price).toFixed(5)}</td>
                      <td className="px-4 py-2">{p.current_price == null ? "—" : Number(p.current_price).toFixed(5)}</td>
                      <td className={`px-4 py-2 ${Number(p.unrealized_pnl) >= 0 ? "text-gain" : "text-loss"}`}>{Number(p.unrealized_pnl).toFixed(2)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{p.stop_loss ?? "—"} / {p.take_profit ?? "—"}</td>
                      <td className="px-4 py-2"><Button size="sm" variant="outline" onClick={() => close(p.id)}>Close</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-3 rounded-lg border bg-card p-4">
            <div className="text-sm font-medium">Order ticket</div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant={side === "buy" ? "default" : "outline"} className={side === "buy" ? "bg-gain text-black hover:bg-gain/90" : ""} onClick={() => setSide("buy")}><ArrowUpRight className="mr-1 h-4 w-4" />Buy</Button>
              <Button variant={side === "sell" ? "default" : "outline"} className={side === "sell" ? "bg-loss text-white hover:bg-loss/90" : ""} onClick={() => setSide("sell")}><ArrowDownRight className="mr-1 h-4 w-4" />Sell</Button>
            </div>
            {sellBlocked && <p className="text-xs text-destructive">Spot crypto accounts can't open shorts. Use paper mode or OANDA to sell first.</p>}
            <div className="space-y-1.5">
              <Label className="text-xs">Account</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {!nonCrypto && <SelectItem value="paper">Paper (simulated)</SelectItem>}
                  {usable.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}{c.is_testnet ? " (testnet)" : ""}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {accountId === "paper" && !nonCrypto && (
              <div className="space-y-1.5">
                <Label className="text-xs">Paper prices from</Label>
                <Select value={paperEx} onValueChange={setPaperEx}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{EXCHANGES.filter((e) => e.available && e.kind === "crypto").map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">{nonCrypto ? "Units" : "Amount (quote, e.g. USDT)"}</Label>
              <Input type="number" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label className="text-xs">Stop loss</Label><Input type="number" min={0} step="any" value={sl} onChange={(e) => setSl(e.target.value)} className="font-mono" placeholder="optional" /></div>
              <div className="space-y-1.5"><Label className="text-xs">Take profit</Label><Input type="number" min={0} step="any" value={tp} onChange={(e) => setTp(e.target.value)} className="font-mono" placeholder="optional" /></div>
            </div>
            <Button className="w-full" disabled={!canTrade || sellBlocked || !(Number(amount) > 0)} variant={side === "buy" ? "default" : "destructive"} onClick={submit}>
              {busy ? "Placing…" : `${side === "buy" ? "Buy" : "Sell"} ${symbol}${accountId === "paper" ? " (paper)" : ""}`}
            </Button>
            {accountId !== "paper" && <p className="text-xs text-muted-foreground">Real order on {chosen ? exchangeName(chosen.exchange) : "your exchange"}{chosen?.is_testnet ? " (testnet)" : ""}. SL/TP are checked every minute (crypto) or held by OANDA (forex/commodities).</p>}
          </div>

          <div className="space-y-2 rounded-lg border bg-card p-4 text-sm">
            <div className="flex items-center gap-2 font-medium"><Bot className="h-4 w-4 text-primary" />AI strategy for {symbol}</div>
            <p className="text-xs text-muted-foreground">Ask the assistant to design an automated strategy for this market, then attach it to a bot.</p>
            <Button size="sm" variant="outline" asChild>
              <Link to="/assistant" search={{ prompt: `Design a trading strategy for ${symbol} on the ${tf} timeframe with clear entry and exit rules and a stop loss.` }}>Ask the AI</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
