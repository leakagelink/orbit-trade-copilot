import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { runBacktestFn } from "@/lib/backtests.functions";
import { EXCHANGES } from "@/lib/exchanges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Ex = "binance" | "bybit" | "okx" | "kucoin" | "coinbase";

export function BacktestDialog({ strategyId, capital, open, onOpenChange }: { strategyId: string; capital: number; open: boolean; onOpenChange: (o: boolean) => void }) {
  const run = useServerFn(runBacktestFn);
  const navigate = useNavigate();
  const [exchange, setExchange] = useState<Ex>("binance");
  const [days, setDays] = useState("90");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const r = await run({ data: { strategyId, exchange, days: Number(days), capital: Number(f.get("capital")), feePct: Number(f.get("fee")), slippagePct: Number(f.get("slip")) } });
      if ("error" in r && r.error) toast.error(r.error); else toast.success("Backtest finished");
      onOpenChange(false);
      navigate({ to: "/backtests", search: { id: r.id } });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Backtest failed"); }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Run backtest</DialogTitle><DialogDescription>Tests the saved version on real historical prices. Save your changes first.</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Price data</Label>
            <Select value={exchange} onValueChange={(v) => setExchange(v as Ex)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{EXCHANGES.filter((x) => x.available).map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}</SelectContent></Select>
          </div>
          <div className="space-y-1.5"><Label>Period</Label>
            <Select value={days} onValueChange={setDays}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{[["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["180", "180 days"], ["365", "1 year"]].map(([v, l]) => <SelectItem key={v} value={v!}>{l}</SelectItem>)}</SelectContent></Select>
          </div>
          <div className="space-y-1.5"><Label>Starting capital</Label><Input name="capital" type="number" min={1} step="any" defaultValue={capital} className="font-mono" /></div>
          <div className="space-y-1.5"><Label>Fee % per side</Label><Input name="fee" type="number" min={0} max={2} step="any" defaultValue={0.1} className="font-mono" /></div>
          <div className="space-y-1.5"><Label>Slippage %</Label><Input name="slip" type="number" min={0} max={2} step="any" defaultValue={0.05} className="font-mono" /></div>
          <p className="text-xs text-muted-foreground sm:col-span-2">Binance supplies up to 5,000 candles. Other exchanges supply only their most recent page (300–1,000 candles).</p>
          <DialogFooter className="sm:col-span-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy}>{busy ? "Running…" : "Run backtest"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
