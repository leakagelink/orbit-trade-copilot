import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { startPaperStrategy } from "@/lib/paper.functions";

interface OwnStrategy { id: string; name: string; pairs: string[]; timeframe: string }
const NUM: [string, string, number, string][] = [
  ["startingCapital", "Starting paper capital (USDT)", 1000, "Simulated money for this strategy only"],
  ["strategyBudget", "Strategy budget (max open notional)", 500, "Never more than the starting capital"],
  ["riskPerTradePct", "Risk per trade (% of equity)", 1, "Loss if the stop is hit, costs included"],
  ["positionSizePct", "Position size (% of equity)", 20, ""],
  ["maxPositionNotional", "Max position size (USDT)", 200, ""],
  ["stopLossPct", "Stop-loss (%)", 2, "Required"],
  ["takeProfitPct", "Take-profit (%) — 0 for none", 4, ""],
  ["dailyLossLimit", "Strategy daily loss stop (USDT)", 30, "No new entries for the rest of the UTC day"],
  ["feePct", "Fee per side (%)", 0.1, "Assumption, not checked against an exchange"],
  ["spreadPct", "Full bid/ask spread (%)", 0.02, ""],
  ["slippagePct", "Slippage per side (%)", 0.05, ""],
  ["maxParticipationPct", "Max share of candle volume (%)", 10, "Larger orders fill over several candles"],
  ["limitOffsetPct", "Limit offset below close (%)", 0.1, "Only for limit entries"],
  ["orderTtlBars", "Entry order lifetime (candles)", 3, ""],
];

export function PaperStartDialog({ strategies, disabled }: { strategies: OwnStrategy[]; disabled?: string | null }) {
  const start = useServerFn(startPaperStrategy);
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [pair, setPair] = useState("");
  const [entry, setEntry] = useState<"market" | "limit">("market");
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(NUM.map(([k, , d]) => [k, String(d)])));
  const [busy, setBusy] = useState(false);
  const sel = strategies.find((s) => s.id === id);
  const n = (k: string) => Number(v[k]);
  async function submit() {
    if (!sel || !pair) return void toast.error("Choose a strategy and pair");
    setBusy(true);
    try {
      await start({ data: {
        strategyId: sel.id, pair, startingCapital: n("startingCapital"),
        costs: { feePct: n("feePct"), spreadPct: n("spreadPct"), slippagePct: n("slippagePct"), maxParticipationPct: n("maxParticipationPct") || null },
        policy: { riskPerTradePct: n("riskPerTradePct"), positionSizePct: n("positionSizePct"), maxPositionNotional: n("maxPositionNotional"), stopLossPct: n("stopLossPct"), takeProfitPct: n("takeProfitPct") || null, dailyLossLimit: n("dailyLossLimit"), strategyBudget: n("strategyBudget"), entryOrder: entry, limitOffsetPct: n("limitOffsetPct"), orderTtlBars: Math.round(n("orderTtlBars")) },
      } });
      toast.success("Paper strategy started. It acts only on candles that open from now on.");
      setOpen(false);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not start"); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button disabled={!!disabled} title={disabled ?? undefined}>Start paper strategy</Button></DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Start forward paper trading</DialogTitle><DialogDescription>Simulated fills from public Binance Spot candles. No order is sent to any exchange. Terms are frozen once started.</DialogDescription></DialogHeader>
        <div className="grid max-h-[60vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
          <div className="space-y-1"><Label>Strategy</Label>
            <Select value={id} onValueChange={(x) => { setId(x); setPair(strategies.find((s) => s.id === x)?.pairs[0] ?? ""); }}><SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger><SelectContent>{strategies.map((s) => <SelectItem key={s.id} value={s.id}>{s.name} · {s.timeframe}</SelectItem>)}</SelectContent></Select>
          </div>
          <div className="space-y-1"><Label>Pair (Spot, long only)</Label>
            <Select value={pair} onValueChange={setPair} disabled={!sel}><SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger><SelectContent>{(sel?.pairs ?? []).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent></Select>
          </div>
          <div className="space-y-1"><Label>Entry order</Label>
            <Select value={entry} onValueChange={(x) => setEntry(x as "market" | "limit")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="market">Market at next open</SelectItem><SelectItem value="limit">Limit below the signal close</SelectItem></SelectContent></Select>
          </div>
          {NUM.map(([k, label, , hint]) => (
            <div key={k} className="space-y-1"><Label htmlFor={`paper-${k}`}>{label}</Label><Input id={`paper-${k}`} type="number" inputMode="decimal" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>
          ))}
        </div>
        <DialogFooter><Button onClick={submit} disabled={busy || !sel || !pair}>{busy ? "Starting…" : "Start"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
