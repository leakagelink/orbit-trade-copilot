import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowRight, ArrowLeftRight, RefreshCw, Sparkles, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { usePlan } from "@/hooks/use-plan";
import { ARBITRAGE_EXCHANGES, ARBITRAGE_PAIRS, executionAllowed, type ArbitrageExchange, type Opportunity } from "@/lib/arbitrage";
import { scanArbitrageFn, executeArbitrageFn, arbitrageReviewFn, reconcileArbitrageFn } from "@/lib/arbitrage.functions";
import { exchangeName } from "@/lib/exchanges";

const D = "Compare crypto exchange prices, review net spreads and execute prefunded spot arbitrage with Elite.";
export const Route = createFileRoute("/_authenticated/arbitrage")({
  head: () => ({ meta: [{ title: "Arbitrage — AlgoVirt" }, { name: "description", content: D }, { property: "og:title", content: "Arbitrage — AlgoVirt" }, { property: "og:description", content: D }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }] }),
  component: ArbitragePage,
});
const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });

function ArbitragePage() {
  const plan = usePlan(), qc = useQueryClient();
  const scanFn = useServerFn(scanArbitrageFn), executeFn = useServerFn(executeArbitrageFn), reviewFn = useServerFn(arbitrageReviewFn);
  const reconcileFn = useServerFn(reconcileArbitrageFn);
  const [checking, setChecking] = useState<string | null>(null);
  async function checkOrders(runId: string) {
    setChecking(runId);
    try { const result = await reconcileFn({ data: { runId } }); result.status === "completed" ? toast.success(result.message) : toast.warning(result.message); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Orders could not be verified; executions remain locked"); }
    finally { setChecking(null); await qc.invalidateQueries({ queryKey: ["arbitrage_runs"] }); }
  }
  const [pair, setPair] = useState<typeof ARBITRAGE_PAIRS[number]>("BTC/USDT");
  const [budget, setBudget] = useState("1000"), [feeBps, setFeeBps] = useState("10"), [slippageBps, setSlippageBps] = useState("5"), [minimum, setMinimum] = useState("0.1");
  const [venues, setVenues] = useState<ArbitrageExchange[]>([...ARBITRAGE_EXCHANGES]);
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [busy, setBusy] = useState(false), [reviewing, setReviewing] = useState(false), [executing, setExecuting] = useState(false);
  const [scan, setScan] = useState<Awaited<ReturnType<typeof scanArbitrageFn>> | null>(null), [review, setReview] = useState("");
  const [picked, setPicked] = useState<Opportunity | null>(null), [confirmation, setConfirmation] = useState("");
  const [buyConnection, setBuyConnection] = useState(""), [sellConnection, setSellConnection] = useState(""), [requestKey, setRequestKey] = useState("");
  const connections = useQuery({ queryKey: ["exchange_connections"], enabled: plan.data?.elite === true,
    queryFn: async () => { const { data, error } = await supabase.from("exchange_connections").select("*").order("created_at"); if (error) throw new Error(error.message); return data; },
  });
  const history = useQuery({ queryKey: ["arbitrage_runs"], enabled: plan.data?.elite === true,
    queryFn: async () => { const { data, error } = await supabase.from("arbitrage_runs").select("*").order("created_at", { ascending: false }).limit(30); if (error) throw new Error(error.message); return data; },
    refetchInterval: 15000,
  });
  const input = () => ({ pair, budget: Number(budget), feeBps: Number(feeBps), slippageBps: Number(slippageBps), exchanges: venues });
  const clear = () => { setScan(null); setReview(""); };
  async function runScan() {
    setBusy(true); setReview("");
    try { setScan(await scanFn({ data: input() })); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Scan failed"); }
    finally { setBusy(false); }
  }
  async function runReview() {
    setReviewing(true);
    try { const r = await reviewFn({ data: input() }); setReview(r.text); }
    catch (e) { toast.error(e instanceof Error ? e.message : "AI review failed"); }
    finally { setReviewing(false); }
  }
  const blocked = history.data?.some((r) => ["claimed", "buy_filled", "needs_review"].includes(r.status));
  function choose(o: Opportunity) {
    setPicked(o); setConfirmation(""); setBuyConnection(""); setSellConnection(""); setRequestKey(crypto.randomUUID());
  }
  async function execute() {
    if (!picked) return;
    setExecuting(true);
    try {
      const r = await executeFn({ data: { ...input(), requestKey, mode, buyExchange: picked.buyExchange as ArbitrageExchange, sellExchange: picked.sellExchange as ArbitrageExchange,
        buyConnectionId: buyConnection || null, sellConnectionId: sellConnection || null, confirmation, minimumNetPct: Number(minimum),
      } });
      if (r.status === "completed") toast.success(mode === "paper" ? "Paper arbitrage recorded" : "Both exchange legs filled");
      else toast.warning(r.message ?? "Execution needs review");
      setPicked(null); await qc.invalidateQueries({ queryKey: ["arbitrage_runs"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Execution failed; inspect exchange accounts before retrying"); await qc.invalidateQueries({ queryKey: ["arbitrage_runs"] }); }
    finally { setExecuting(false); }
  }
  const eligibleAccounts = (exchange: string) => connections.data?.filter((c) => c.exchange === exchange && c.status === "connected" && c.account_type === "spot") ?? [];
  return <div>
    <PageHeader title="Arbitrage" actions={<><Badge variant="outline">Elite</Badge><Button variant="outline" asChild><Link to="/exchanges"><ArrowLeftRight className="mr-2 h-4 w-4" />Exchange accounts</Link></Button></>} />
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-5">
        <div><h2 className="text-sm font-medium">Cross-exchange spot</h2><p className="mt-1 text-xs text-muted-foreground">USDT markets · executable depth · fees on both legs</p></div>
        <Select value={mode} onValueChange={(v) => { setMode(v as "paper" | "live"); clear(); }}><SelectTrigger className="w-48" aria-label="Execution mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="paper">Paper simulation</SelectItem><SelectItem value="live">Exchange orders</SelectItem></SelectContent></Select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <div className="space-y-2"><Label>Market</Label><Select value={pair} onValueChange={(v) => { setPair(v as typeof pair); clear(); }}><SelectTrigger aria-label="Arbitrage market"><SelectValue /></SelectTrigger><SelectContent>{ARBITRAGE_PAIRS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent></Select></div>
        {[{ label: "Buy budget (USDT)", value: budget, set: setBudget, min: 10 }, { label: "Fee / leg (bps)", value: feeBps, set: setFeeBps, min: 10 }, { label: "Slippage / leg (bps)", value: slippageBps, set: setSlippageBps, min: 5 }, { label: "Minimum net (%)", value: minimum, set: setMinimum, min: 0 }].map((f) => <div key={f.label} className="space-y-2"><Label htmlFor={f.label}>{f.label}</Label><Input id={f.label} type="number" min={f.min} step="any" value={f.value} onChange={(e) => { f.set(e.target.value); clear(); }} /></div>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-4">{ARBITRAGE_EXCHANGES.map((e) => <div key={e} className="flex items-center gap-2"><Checkbox id={`venue-${e}`} checked={venues.includes(e)} onCheckedChange={(v) => { setVenues((vs) => v ? [...vs, e] : vs.filter((x) => x !== e)); clear(); }} /><Label htmlFor={`venue-${e}`}>{exchangeName(e)}</Label></div>)}</div>
        <div className="flex gap-2"><Button variant="outline" disabled={reviewing || busy || venues.length < 2} onClick={runReview}><Sparkles className="mr-2 h-4 w-4" />{reviewing ? "Reviewing…" : "AI review"}</Button><Button disabled={busy || venues.length < 2} onClick={runScan}><RefreshCw className={`mr-2 h-4 w-4 ${busy ? "animate-spin" : ""}`} />{busy ? "Scanning…" : "Scan spreads"}</Button></div>
      </div>
      <div className="flex gap-3 border-y py-4 text-sm text-muted-foreground"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><p>{mode === "paper" ? "Paper results are simulations; no wallet money or exchange funds move." : "Prefund USDT on the buy exchange and crypto on the sell exchange. Live execution: Binance ↔ OKX spot only. No transfers or withdrawals."} Fees are estimates; prices can change and either leg can fail. Profit is not guaranteed.</p></div>
      {connections.isError && <p className="text-sm text-destructive">Exchange accounts unavailable.</p>}
      {blocked && <div role="alert" className="space-y-2 text-sm text-destructive"><p>A previous execution is pending or needs review. New executions are locked; check both exchange accounts.</p>{history.data?.filter((r) => r.mode !== "paper" && ["claimed", "buy_filled", "needs_review"].includes(r.status)).map((r) => <Button key={r.id} variant="outline" disabled={checking !== null} onClick={() => checkOrders(r.id)}><RefreshCw className={`mr-2 h-4 w-4 ${checking === r.id ? "animate-spin" : ""}`} />{checking === r.id ? "Checking…" : `Check exchange orders · ${r.trading_pair}`}</Button>)}</div>}
      {review && <section className="border-l-2 border-primary pl-4"><h2 className="mb-2 flex items-center gap-2 text-sm font-medium"><Sparkles className="h-4 w-4 text-primary" />AI assessment</h2><p className="max-w-4xl whitespace-pre-wrap text-sm text-muted-foreground">{review}</p></section>}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">Exchange spreads</h2>{scan && <span className="font-mono text-xs text-muted-foreground">Snapshot {new Date(scan.scannedAt).toLocaleTimeString()}</span>}</div>
        {scan?.errors.map((e) => <p key={e} className="mb-2 text-xs text-destructive">{e}</p>)}
        {!scan ? <div className="border-y py-14 text-center text-sm text-muted-foreground">No price snapshot yet</div> : scan.opportunities.length === 0 ? <p className="border-y py-10 text-center text-sm text-muted-foreground">Insufficient exchange depth for this budget</p> : <div className="overflow-x-auto border-y"><table className="w-full min-w-[800px] text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr>{["Buy → Sell", "Buy ask", "Sell bid", "Fees + buffer", "Est. net", "Net %", ""].map((h, i) => <th key={i} className="px-3 py-3 font-medium">{h}</th>)}</tr></thead><tbody className="divide-y">{scan.opportunities.map((o) => <tr key={`${o.buyExchange}-${o.sellExchange}`}>
          <td className="px-3 py-4"><div className="flex items-center gap-2 whitespace-nowrap">{exchangeName(o.buyExchange)}<ArrowRight className="h-3 w-3 text-muted-foreground" />{exchangeName(o.sellExchange)}</div></td>
          <td className="px-3 py-4 font-mono">{money(o.buyPrice)}</td><td className="px-3 py-4 font-mono">{money(o.sellPrice)}</td><td className="px-3 py-4 font-mono">{money(o.fees + o.slippage)}</td><td className={`px-3 py-4 font-mono ${o.net > 0 ? "text-gain" : "text-loss"}`}>{money(o.net)} USDT</td><td className={`px-3 py-4 font-mono ${o.net > 0 ? "text-gain" : "text-loss"}`}>{o.netPct.toFixed(3)}%</td>
          <td className="px-3 py-4"><Button size="sm" variant="outline" disabled={blocked || !executionAllowed(o, Number(minimum)) || (mode === "live" && ![o.buyExchange, o.sellExchange].every((e) => e === "binance" || e === "okx"))} onClick={() => choose(o)}>{mode === "paper" ? "Simulate" : "Review orders"}</Button></td>
        </tr>)}</tbody></table></div>}
      </section>
      <section><h2 className="mb-3 font-medium">Execution history</h2>{history.isError ? <p className="text-sm text-destructive">History unavailable.</p> : !history.data?.length ? <p className="border-y py-8 text-center text-sm text-muted-foreground">No arbitrage executions</p> : <div className="divide-y border-y">{history.data.map((r) => <div key={r.id} className="flex flex-col justify-between gap-2 py-4 sm:flex-row"><div><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{r.trading_pair} · {exchangeName(r.buy_exchange)} → {exchangeName(r.sell_exchange)}</span><Badge variant={r.status === "needs_review" ? "destructive" : "outline"}>{r.status.replaceAll("_", " ")}</Badge><Badge variant="secondary">{r.mode}</Badge></div><p className="mt-1 max-w-3xl text-xs text-muted-foreground">{r.message}</p><span className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span></div><div className="shrink-0 font-mono text-sm">{r.realized_net == null ? "—" : `${money(Number(r.realized_net))} USDT`}</div></div>)}</div>}</section>
    </div>
    <Dialog open={!!picked} onOpenChange={(o) => { if (!o && !executing) setPicked(null); }}><DialogContent><DialogHeader><DialogTitle>{mode === "paper" ? "Simulate arbitrage" : "Confirm exchange orders"}</DialogTitle><DialogDescription>{pair} · Buy {exchangeName(picked?.buyExchange ?? "")} → Sell {exchangeName(picked?.sellExchange ?? "")}. Prices and eligibility are checked again before execution.</DialogDescription></DialogHeader>
      <div className="space-y-4"><div className="flex justify-between border-y py-3 text-sm"><span>Buy budget</span><span className="font-mono">{budget} USDT</span></div>
        {mode === "live" && picked && <>{[{ label: "Buy account", exchange: picked.buyExchange, value: buyConnection, set: setBuyConnection }, { label: "Sell account", exchange: picked.sellExchange, value: sellConnection, set: setSellConnection }].map((f) => <div key={f.label} className="space-y-2"><Label>{f.label}</Label><Select value={f.value} onValueChange={f.set}><SelectTrigger aria-label={f.label}><SelectValue placeholder="Select verified spot account" /></SelectTrigger><SelectContent>{eligibleAccounts(f.exchange).map((c) => <SelectItem key={c.id} value={c.id}>{c.label} {c.is_testnet ? "· testnet" : "· real money"}</SelectItem>)}</SelectContent></Select></div>)}<p className="text-sm text-muted-foreground">Two separate market orders, not an atomic transaction. A failed sell can leave unmatched inventory. Check the exchanges if execution needs review.</p><div className="space-y-2"><Label htmlFor="arb-live">Type LIVE to confirm</Label><Input id="arb-live" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" /></div></>}
      </div><DialogFooter><Button variant="outline" disabled={executing} onClick={() => setPicked(null)}>Cancel</Button><Button disabled={executing || (mode === "live" && (confirmation !== "LIVE" || !buyConnection || !sellConnection))} onClick={execute}>{executing ? "Executing…" : mode === "paper" ? "Run simulation" : "Execute both legs"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}