import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowUpRight, ArrowDownRight, Bot, Sparkles, Lock, Wallet, CandlestickChart, RefreshCw } from "lucide-react";
import { ClientOnly } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { usePlan } from "@/hooks/use-plan";
import { CATEGORY_LABEL, MARKETS, marketOf, type MarketCategory } from "@/lib/markets";
import { EXCHANGES, exchangeName } from "@/lib/exchanges";
import { TIMEFRAMES } from "@/lib/strategy";
import { closeManualPosition, getMarketCandles, placeManualOrder, aiTradeIdea, type TradeIdea } from "@/lib/trade.functions";
import { TvChart } from "@/components/tv-chart";
import { MarketDepthScene } from "@/components/market-depth-scene";
import { fmtMoney } from "@/lib/metrics";
import { fetchBinanceChart } from "@/lib/chart-feed";

const D = "Buy and sell crypto, forex and commodities from your wallet, with AI trade ideas on Pro.";
export const Route = createFileRoute("/_authenticated/trade")({
  head: () => ({ meta: [{ title: "Trade — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Trade — Quantra" }, { property: "og:description", content: D }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }] }),
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
  const [confirmAi, setConfirmAi] = useState(false);
  const plan = usePlan();
  const pro = plan.data?.pro ?? false;

  const getCandles = useServerFn(getMarketCandles);
  const place = useServerFn(placeManualOrder);
  const closePos = useServerFn(closeManualPosition);
  const getIdea = useServerFn(aiTradeIdea);

  const connId = accountId === "paper" ? null : accountId;
  const market = marketOf(symbol) ?? MARKETS[0];
  const nonCrypto = market?.category !== "crypto";

  const accounts = useQuery({
    queryKey: ["trade_accounts"],
    queryFn: async () => {
      const { data, error } = await supabase.from("exchange_connections").select("id,label,exchange,is_testnet,status").eq("status", "connected");
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const usable = useMemo(
    () => (accounts.data ?? []).filter((c) => (nonCrypto ? c.exchange === "oanda" && market?.oanda : c.exchange !== "oanda")),
    [accounts.data, nonCrypto, market?.oanda],
  );
  const chosen = usable.find((c) => c.id === connId);
  const isWallet = !chosen;
  const canTrade = !busy;
  const wallet = useQuery({
    queryKey: ["wallet_balance"],
    queryFn: async () => {
      const { data } = await supabase.from("wallets").select("balance").maybeSingle();
      return Number(data?.balance ?? 0);
    },
  });

  const candles = useQuery({
    queryKey: ["trade_candles", symbol, tf, chosen?.id ?? null, paperEx],
    queryFn: async () => {
      // Public display data bypasses hosting-region blocks; execution stays server-side.
      const exchange = chosen?.exchange ?? paperEx;
      if (!nonCrypto && exchange === "binance" && !chosen?.is_testnet) {
        try {
          return { candles: await fetchBinanceChart(symbol, tf), error: null };
        } catch {
          // A browser region or network can block the public feed too.
        }
      }
      return getCandles({ data: { symbol, timeframe: tf, connectionId: chosen?.id ?? null, paperExchange: paperEx as never } });
    },
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
    const first = MARKETS.find((m) => m.category === c);
    if (!first) return;
    setSymbol(first.symbol);
    setIdea(null);
    setAccountId("paper");
  }

  async function submit(o?: { side: "buy" | "sell"; sl: number | null; tp: number | null }) {
    if (!canTrade) return;
    const s = o?.side ?? side;
    setBusy(true);
    try {
      const r = await place({ data: { symbol, side: s, amount: Number(amount), sl: o ? o.sl : sl === "" ? null : Number(sl), tp: o ? o.tp : tp === "" ? null : Number(tp), connectionId: chosen?.id ?? null, paperExchange: paperEx as never } });
      toast.success(`${s === "buy" ? "Bought" : "Sold"} ${r.qty.toPrecision(6)} ${symbol} @ ${r.price.toFixed(5)}`);
      setSl(""); setTp(""); setIdea(null);
      qc.invalidateQueries({ queryKey: ["manual_positions"] });
      qc.invalidateQueries({ queryKey: ["wallet_balance"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Order failed"); }
    setBusy(false);
  }

  async function close(id: string) {
    try {
      const r = await closePos({ data: { id } });
      toast.success(`Closed @ ${r.exit.toFixed(5)} · net ${fmtMoney(r.pnl)}`);
      qc.invalidateQueries({ queryKey: ["manual_positions"] });
      qc.invalidateQueries({ queryKey: ["wallet_balance"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Close failed"); }
  }

  async function analyze() {
    setIdeaBusy(true); setIdea(null);
    try {
      const r = await getIdea({ data: { symbol, timeframe: tf, connectionId: chosen?.id ?? null, paperExchange: paperEx as never } });
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
      <PageHeader title="Trading terminal" description="Crypto / Forex / Commodities" actions={<Badge variant="outline"><Wallet className="mr-1.5 h-3 w-3" />{isWallet ? "Demo wallet" : chosen?.label}</Badge>} />
      <div className="mx-4 mb-5 md:mx-7"><OnboardingChecklist /></div>
      <div className="market-summary mx-4 mb-5 flex flex-wrap items-center justify-between gap-4 px-5 md:mx-7">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-lg border bg-card text-primary"><CandlestickChart className="h-6 w-6" /></span>
          <div><div className="text-lg font-semibold">{symbol}</div><div className="text-xs text-muted-foreground">{market?.name ?? symbol}</div></div>
        </div>
        <div className="flex flex-wrap gap-6 sm:gap-10">
          <div><div className="mb-1 text-[10px] font-mono text-muted-foreground">LAST PRICE</div><div className="font-mono text-xl">{price?.toLocaleString(undefined, { maximumFractionDigits: 5 }) ?? "—"}</div></div>
          <div><div className="mb-1 text-[10px] font-mono text-muted-foreground">OPEN POSITIONS</div><div className="font-mono text-xl">{symbolPositions.length}</div></div>
          <div className="hidden sm:block"><div className="mb-1 text-[10px] font-mono text-muted-foreground">TIMEFRAME</div><div className="font-mono text-xl">{tf}</div></div>
        </div>
      </div>
      {candles.data?.candles.length ? <ClientOnly><MarketDepthScene candles={candles.data.candles} /></ClientOnly> : null}
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2 pt-5">
            {(Object.keys(CATEGORY_LABEL) as MarketCategory[]).map((c) => (
              <Button key={c} size="sm" variant={cat === c ? "default" : "outline"} onClick={() => pickCat(c)}>{CATEGORY_LABEL[c]}</Button>
            ))}
            <Select value={symbol} onValueChange={(v) => { setSymbol(v); setIdea(null); }}>
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
            <Select value={tf} onValueChange={(v) => setTf(v as Tf)}>
              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>{TIMEFRAMES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
            {pro ? (
              <Button size="sm" variant="outline" onClick={analyze} disabled={ideaBusy}>
                <Sparkles className="mr-1 h-4 w-4" />{ideaBusy ? "Analyzing…" : "AI analyze"}
              </Button>
            ) : (
              <Button size="sm" variant="outline" asChild>
                <Link to="/plans"><Lock className="mr-1 h-3.5 w-3.5" />AI analyze · Pro</Link>
              </Button>
            )}
            {nonCrypto && isWallet && <span className="text-xs text-muted-foreground">Prices: Yahoo Finance</span>}
          </div>

          {candles.isLoading ? <Skeleton className="h-[420px]" /> : candles.isError || candles.data?.error || !candles.data?.candles.length ? (
            <div role="alert" className="flex min-h-[420px] flex-col items-center justify-center gap-4 rounded-lg border bg-card p-4 text-center text-sm">
              <p className="text-destructive">Market data is temporarily unavailable for {symbol}.</p>
              <Button variant="outline" size="sm" onClick={() => candles.refetch()} disabled={candles.isFetching}>
                <RefreshCw className={`mr-2 h-4 w-4 ${candles.isFetching ? "animate-spin" : ""}`} />{candles.isFetching ? "Retrying…" : "Retry chart"}
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border bg-card p-2">
              <ClientOnly fallback={<Skeleton className="h-[420px]" />}>
                <TvChart candles={candles.data?.candles ?? []} lines={chartLines} />
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
              {idea.bias !== "neutral" && (
                <Button size="sm" onClick={() => setConfirmAi(true)} disabled={busy || (idea.bias === "short" && liveCrypto)}>
                  <Sparkles className="mr-1 h-4 w-4" />{idea.bias === "long" ? "Buy" : "Sell"} with AI levels
                </Button>
              )}
              <p className="text-xs text-muted-foreground">Not financial advice. The stop/target fields were filled for you — review before ordering.</p>
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border bg-card">
            <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-medium">Open positions <Badge variant="secondary">{positions.data?.length ?? 0}</Badge></div>
            {!positions.data?.length ? (
              <p className="p-4 text-sm text-muted-foreground">No manual positions.</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted-foreground">{["Market", "Side", "Qty", "Entry", "Current", "PnL", "SL / TP", ""].map((h) => <th key={h} className="px-4 py-2 font-normal">{h}</th>)}</tr></thead>
                <tbody>
                  {positions.data.map((p) => (
                    <tr key={p.id} className="border-t font-mono text-xs">
                      <td className="px-4 py-2 font-sans text-sm">{p.trading_pair}<div className="text-xs text-muted-foreground">{p.wallet_margin != null ? "Demo wallet" : `${exchangeName(p.exchange)} · ${p.mode}`}</div></td>
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
          <div className="order-ticket space-y-4 rounded-lg border bg-card p-5 xl:mt-5">
            <div className="flex items-center justify-between text-sm font-semibold">Place order <Badge variant="secondary">Market</Badge></div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant={side === "buy" ? "buy" : "outline"} onClick={() => setSide("buy")}><ArrowUpRight className="mr-1 h-4 w-4" />Buy</Button>
              <Button variant={side === "sell" ? "sell" : "outline"} onClick={() => setSide("sell")}><ArrowDownRight className="mr-1 h-4 w-4" />Sell</Button>
            </div>
            {sellBlocked && <p className="text-xs text-destructive">Spot crypto accounts can't open shorts. Use paper mode or OANDA to sell first.</p>}
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
                <span className="flex items-center gap-1.5 text-muted-foreground"><Wallet className="h-3.5 w-3.5" />Wallet balance</span>
                <span className="font-mono">{fmtMoney(wallet.data ?? 0, "USD")}</span>
                <Link to="/wallet" className="text-primary hover:underline">Deposit</Link>
              </div>
            )}
            {isWallet && !nonCrypto && (
              <div className="space-y-1.5">
                <Label className="text-xs">Paper prices from</Label>
                <Select value={paperEx} onValueChange={setPaperEx}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{EXCHANGES.filter((e) => e.available && e.kind === "crypto").map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">{chosen?.exchange === "oanda" ? "Units" : isWallet ? "Amount (USD)" : "Amount (quote, e.g. USDT)"}</Label>
              <Input type="number" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label className="text-xs">Stop loss</Label><Input type="number" min={0} step="any" value={sl} onChange={(e) => setSl(e.target.value)} className="font-mono" placeholder="optional" /></div>
              <div className="space-y-1.5"><Label className="text-xs">Take profit</Label><Input type="number" min={0} step="any" value={tp} onChange={(e) => setTp(e.target.value)} className="font-mono" placeholder="optional" /></div>
            </div>
            <Button className="w-full" disabled={!canTrade || sellBlocked || !(Number(amount) > 0)} variant={side === "buy" ? "default" : "destructive"} onClick={() => submit()}>
              {busy ? "Placing…" : `${side === "buy" ? "Buy" : "Sell"} ${symbol}${isWallet ? " (demo)" : ""}`}
            </Button>
            {!isWallet && <p className="text-xs text-muted-foreground">Real order on {chosen ? exchangeName(chosen.exchange) : "your exchange"}{chosen?.is_testnet ? " (testnet)" : ""}. SL/TP are checked every minute (crypto) or held by OANDA (forex/commodities).</p>}
          </div>

          <div className="space-y-2 rounded-lg border bg-card p-4 text-sm">
            <div className="flex items-center gap-2 font-medium"><Bot className="h-4 w-4 text-primary" />AI strategy for {symbol}</div>
            <p className="text-xs text-muted-foreground">Ask the assistant to design an automated strategy for this market, then attach it to a bot.</p>
            {pro ? (
              <Button size="sm" variant="outline" asChild>
                <Link to="/assistant" search={{ prompt: `Design a trading strategy for ${symbol} on the ${tf} timeframe with clear entry and exit rules and a stop loss.` }}>Ask the AI</Link>
              </Button>
            ) : (
              <Button size="sm" variant="outline" asChild><Link to="/plans"><Lock className="mr-1 h-3.5 w-3.5" />Upgrade to Pro</Link></Button>
            )}
          </div>
        </div>
      </div>
      <AlertDialog open={confirmAi} onOpenChange={setConfirmAi}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{idea?.bias === "long" ? "Buy" : "Sell"} {symbol} with the AI's levels?</AlertDialogTitle>
            <AlertDialogDescription>
              {isWallet ? `${fmtMoney(Number(amount), "USD")} from your demo wallet` : `${amount} on ${chosen ? exchangeName(chosen.exchange) : "your account"} — a real order`}
              {idea?.stop_loss != null ? ` · stop loss ${idea.stop_loss}` : ""}{idea?.take_profit != null ? ` · take profit ${idea.take_profit}` : ""}. Executed at the current market price.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => idea && submit({ side: idea.bias === "long" ? "buy" : "sell", sl: idea.stop_loss, tp: idea.take_profit })}>Place trade</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
