import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { emergencyStop } from "@/lib/bots.functions";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { OctagonX, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtMoney } from "@/lib/metrics";

const D = "Account-wide limits that every bot must respect before opening a trade.";
export const Route = createFileRoute("/_authenticated/risk")({
  head: () => ({ meta: [{ title: "Risk Management — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Risk Management — Quantra" }, { property: "og:description", content: D }] }),
  component: Risk,
});

function Risk() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const stopAll = useServerFn(emergencyStop);
  async function closeEverything() {
    setBusy(true);
    try {
      const r = await stopAll();
      if (r.failed.length) toast.error(`Closed ${r.closed}; could not close: ${r.failed.join("; ")}`); else toast.success(`All bots stopped; ${r.closed} position(s) closed`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Emergency stop failed"); }
    setBusy(false);
    qc.invalidateQueries();
  }
  const q = useQuery({
    queryKey: ["risk"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      const start = new Date(); start.setUTCHours(0, 0, 0, 0);
      const [r, p, t] = await Promise.all([
        supabase.from("risk_settings").select("*").eq("user_id", u.user!.id).maybeSingle(),
        supabase.from("positions").select("entry_price,quantity").eq("is_open", true),
        supabase.from("trades").select("realized_pnl,fees").gte("closed_at", start.toISOString()),
      ]);
      return {
        uid: u.user!.id, r: r.data,
        exposure: (p.data ?? []).reduce((a, x) => a + Number(x.entry_price) * Number(x.quantity), 0),
        open: p.data?.length ?? 0,
        today: (t.data ?? []).reduce((a, x) => a + Number(x.realized_pnl) - Number(x.fees), 0),
      };
    },
  });

  async function save(patch: Record<string, number | boolean | null>) {
    setBusy(true);
    const { error } = await supabase.from("risk_settings").upsert({ user_id: q.data!.uid, ...patch, updated_at: new Date().toISOString() });
    setBusy(false);
    if (error) return void toast.error(error.message);
    toast.success("Risk settings saved");
    qc.invalidateQueries({ queryKey: ["risk"] });
  }
  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => { const v = String(f.get(k) ?? "").trim(); return v === "" ? null : Number(v); };
    save({ max_open_exposure: num("exp"), max_daily_loss: num("loss"), max_total_positions: num("pos") });
  }

  if (q.isLoading || !q.data) return <div className="p-6"><Skeleton className="h-64" /></div>;
  const r = q.data.r;
  const halted = !!r?.trading_halted;
  return (
    <div>
      <PageHeader title="Risk management" description={D} />
      <div className="max-w-3xl space-y-6 p-6">
        <div className={`flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${halted ? "border-destructive bg-destructive/10" : "bg-card"}`}>
          <div className="flex items-start gap-3">
            <OctagonX className={`mt-0.5 h-5 w-5 ${halted ? "text-destructive" : "text-muted-foreground"}`} />
            <div><div className="font-medium">{halted ? "Trading halted" : "Emergency stop"}</div><p className="text-sm text-muted-foreground">{halted ? "No bot can open new trades. Open trades still close on their stop loss, take profit or exit rules." : "Instantly block every bot from opening new trades."}</p></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant={halted ? "outline" : "secondary"} disabled={busy} onClick={() => save({ trading_halted: !halted })}>{halted ? "Resume trading" : "Halt new trades"}</Button>
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="destructive" disabled={busy}>Close everything</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader><AlertDialogTitle>Emergency stop?</AlertDialogTitle><AlertDialogDescription>Stops every bot, halts new trades and sells every open position now at market price — including live positions on your exchange.</AlertDialogDescription></AlertDialogHeader>
                <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={closeEverything}>Stop and close all</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Open exposure" value={fmtMoney(q.data.exposure)} limit={r?.max_open_exposure != null ? fmtMoney(Number(r.max_open_exposure)) : null} />
          <Stat label="Today's net PnL" value={fmtMoney(q.data.today)} limit={r?.max_daily_loss != null ? `-${fmtMoney(Number(r.max_daily_loss))}` : null} />
          <Stat label="Open positions" value={String(q.data.open)} limit={r?.max_total_positions != null ? String(r.max_total_positions) : null} />
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4 text-primary" />Account limits</div>
          <p className="text-sm text-muted-foreground">Leave a field empty for no limit. These apply on top of each bot's own limits, across paper and live.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5"><Label className="text-xs">Max open exposure (USDT)</Label><Input name="exp" type="number" min={0.01} step="any" defaultValue={r?.max_open_exposure ?? ""} className="font-mono" /></div>
            <div className="space-y-1.5"><Label className="text-xs">Max daily loss (USDT)</Label><Input name="loss" type="number" min={0.01} step="any" defaultValue={r?.max_daily_loss ?? ""} className="font-mono" /></div>
            <div className="space-y-1.5"><Label className="text-xs">Max open positions</Label><Input name="pos" type="number" min={1} max={500} step="1" defaultValue={r?.max_total_positions ?? ""} className="font-mono" /></div>
          </div>
          <Button disabled={busy}>Save limits</Button>
        </form>
      </div>
    </div>
  );
}

function Stat({ label, value, limit }: { label: string; value: string; limit: string | null }) {
  return <div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-mono text-lg">{value}</div><div className="text-xs text-muted-foreground">limit {limit ?? "none"}</div></div>;
}
