// Autopilot automatic-run + real-money controls. All switches are server-validated; this panel only displays state.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, CircleAlert, Clock, Loader2, Play, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { disableLiveAutopilot, enableLiveAutopilot, runAutopilotNow, saveAutopilotSchedule } from "@/lib/autopilot.functions";
import { liveEnableProblems } from "@/lib/autopilot-guard";
import { cn } from "@/lib/utils";

const NONE = "none";
const INTERVALS = [15, 30, 60, 240] as const;
type Interval = (typeof INTERVALS)[number];

export function useAutopilotSettings() {
  return useQuery({
    queryKey: ["autopilot_settings"],
    queryFn: async () => {
      const [s, conns, risk] = await Promise.all([
        supabase.from("autopilot_settings").select("*").maybeSingle(),
        supabase.from("exchange_connections").select("id,label,exchange,is_testnet,status").in("exchange", ["binance", "deriv"]).eq("status", "connected"),
        supabase.from("risk_settings").select("max_daily_loss,max_open_exposure,trading_halted").maybeSingle(),
      ]);
      if (s.error) throw new Error(s.error.message);
      return { settings: s.data, accounts: conns.data ?? [], risk: risk.data };
    },
  });
}

export function AutopilotSettings({ claudeReady }: { claudeReady: boolean }) {
  const qc = useQueryClient();
  const q = useAutopilotSettings();
  const save = useServerFn(saveAutopilotSchedule);
  const enable = useServerFn(enableLiveAutopilot);
  const disable = useServerFn(disableLiveAutopilot);
  const runNow = useServerFn(runAutopilotNow);
  const s = q.data?.settings;
  const [interval, setIntervalMin] = useState<Interval | null>(null);
  const [goal, setGoal] = useState<string | null>(null);
  const [binance, setBinance] = useState<string>(NONE);
  const [deriv, setDeriv] = useState<string>(NONE);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const iv = interval ?? ((s?.interval_minutes as Interval | undefined) ?? 60);
  const gl = goal ?? s?.goal ?? "";
  const refresh = () => qc.invalidateQueries({ queryKey: ["autopilot_settings"] });

  async function act(name: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(name);
    try { await fn(); toast.success(ok); await refresh(); await qc.invalidateQueries({ queryKey: ["autopilot_runs"] }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(null); }
  }

  if (!q.data) return <div className="p-4 text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading…</div>;
  const accounts = q.data.accounts;
  const bins = accounts.filter((a) => a.exchange === "binance"), ders = accounts.filter((a) => a.exchange === "deriv");
  const risk = q.data.risk ? { ...q.data.risk, max_daily_loss: q.data.risk.max_daily_loss == null ? null : Number(q.data.risk.max_daily_loss), max_open_exposure: q.data.risk.max_open_exposure == null ? null : Number(q.data.risk.max_open_exposure) } : null;
  const problems = liveEnableProblems({ confirm, risk, binanceId: binance === NONE ? null : binance, derivId: deriv === NONE ? null : deriv }).filter((p) => !p.startsWith("Type LIVE"));
  const labelOf = (id: string | null) => accounts.find((a) => a.id === id);

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div><p className="font-medium">Automatic runs</p><p className="text-sm text-muted-foreground">The AI checks the market and your positions on a schedule and acts on its own.</p></div>
          <Switch aria-label="Automatic runs" checked={!!s?.enabled} disabled={!!busy || (!claudeReady && !s?.enabled)} onCheckedChange={(v) => act("schedule", () => save({ data: { enabled: v, interval: iv, goal: gl } }), v ? "Automatic runs switched on" : "Automatic runs switched off")} />
        </div>
        {!claudeReady && <p className="text-xs text-warning">Connect AI Prime Tech first.</p>}
        <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <div className="space-y-1.5"><Label>Run every</Label>
            <Select value={String(iv)} onValueChange={(v) => setIntervalMin(Number(v) as Interval)}>
              <SelectTrigger aria-label="Run every"><SelectValue /></SelectTrigger>
              <SelectContent>{INTERVALS.map((m) => <SelectItem key={m} value={String(m)}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label htmlFor="ap-goal">Goal for the AI (optional)</Label>
            <Textarea id="ap-goal" rows={2} maxLength={1000} value={gl} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Trade BTC and gold carefully, protect capital first" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("save", () => save({ data: { enabled: !!s?.enabled, interval: iv, goal: gl } }), "Saved")}>Save</Button>
          <Button size="sm" variant="outline" disabled={!!busy || !s?.enabled} onClick={() => act("now", () => runNow(), "A run starts within about a minute")}><Play className="mr-1 h-3.5 w-3.5" />Run now</Button>
          {s?.enabled && s.next_run_at && <span className="self-center text-xs text-muted-foreground"><Clock className="mr-1 inline h-3 w-3" />Next run {new Date(s.next_run_at).toLocaleString()}</span>}
        </div>
      </section>

      <section className={cn("space-y-3 rounded-md border p-3", s?.live_enabled ? "border-destructive/50 bg-destructive/5" : "")}>
        <div className="flex items-start gap-2"><Zap className={cn("mt-0.5 h-4 w-4", s?.live_enabled ? "text-destructive" : "text-muted-foreground")} />
          <div><p className="font-medium">Real money</p><p className="text-sm text-muted-foreground">When on, the AI places real orders on the chosen accounts without asking each time. Your risk settings are the hard limit.</p></div>
        </div>
        {s?.live_enabled ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium text-destructive">ON — {[labelOf(s.binance_connection_id) && `Binance: ${labelOf(s.binance_connection_id)!.label}`, labelOf(s.deriv_connection_id) && `Deriv: ${labelOf(s.deriv_connection_id)!.label}`].filter(Boolean).join(" · ") || "account no longer connected"}</p>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("off", () => disable(), "Real money switched off — AI is back to demo only")}>Turn off real money</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Binance account</Label>
                <Select value={binance} onValueChange={setBinance}><SelectTrigger aria-label="Binance account"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value={NONE}>Don't use</SelectItem>{bins.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}{a.is_testnet ? " (testnet)" : " · real money"}</SelectItem>)}</SelectContent></Select>
              </div>
              <div className="space-y-1.5"><Label>Deriv account (Multipliers)</Label>
                <Select value={deriv} onValueChange={setDeriv}><SelectTrigger aria-label="Deriv account"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value={NONE}>Don't use</SelectItem>{ders.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}{a.is_testnet ? " (demo)" : " · real money"}</SelectItem>)}</SelectContent></Select>
              </div>
            </div>
            {!bins.length && !ders.length && <p className="text-xs text-muted-foreground">Connect and verify Binance or Deriv on the <Link to="/exchanges" className="text-primary underline">Exchanges</Link> page.</p>}
            {problems.length > 0 && <ul className="space-y-1 text-xs text-warning">{problems.map((p) => <li key={p}><CircleAlert className="mr-1 inline h-3 w-3" />{p}{p.includes("Risk page") && <> — <Link to="/risk" className="underline">open Risk</Link></>}</li>)}</ul>}
            <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />Real trades can lose money, and AI decisions can be wrong. Profit is never guaranteed. The emergency stop on the Risk page switches the AI off and closes positions.</div>
            <div className="space-y-1.5"><Label htmlFor="ap-live">Type LIVE to confirm</Label><Input id="ap-live" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" className="font-mono" /></div>
            <Button variant="destructive" size="sm" disabled={!!busy || confirm !== "LIVE" || problems.length > 0} onClick={() => act("live", () => enable({ data: { binanceId: binance === NONE ? null : binance, derivId: deriv === NONE ? null : deriv, confirm } }), "Real-money Autopilot is ON")}>Turn on real money</Button>
          </div>
        )}
      </section>
      <RecentRuns />
    </div>
  );
}

type Action = { at: string; tool: string; result: string; error?: boolean };
function RecentRuns() {
  const runs = useQuery({
    queryKey: ["autopilot_runs"],
    queryFn: async () => {
      const { data, error } = await supabase.from("autopilot_runs").select("id,status,live,step,summary,error,actions,created_at,finished_at").order("created_at", { ascending: false }).limit(10);
      if (error) throw new Error(error.message);
      return data;
    },
    refetchInterval: 30_000,
  });
  return (
    <section className="space-y-2">
      <p className="font-medium">Automatic runs history</p>
      {!runs.data?.length ? <p className="text-sm text-muted-foreground">No automatic runs yet.</p> : runs.data.map((r) => {
        const actions = (r.actions as unknown as Action[]) ?? [];
        const active = r.status === "waiting_model" || r.status === "executing";
        return (
          <details key={r.id} className="rounded-md border p-2 text-sm">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              {active ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : r.status === "done" ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : <CircleAlert className="h-3.5 w-3.5 text-destructive" />}
              <span>{new Date(r.created_at).toLocaleString()}</span>
              {r.live && <span className="rounded bg-destructive/15 px-1.5 text-[10px] font-medium text-destructive">REAL MONEY</span>}
              <span className="text-xs text-muted-foreground">{active ? "running" : r.status} · {actions.length} actions</span>
            </summary>
            <div className="mt-2 space-y-2">
              {(r.summary || r.error) && <p className={cn("whitespace-pre-wrap break-words", r.error && "text-destructive")}>{r.summary ?? r.error}</p>}
              {actions.map((a, i) => <p key={i} className={cn("break-words text-xs text-muted-foreground", a.error && "text-destructive")}><span className="font-mono">{a.tool}</span> — {a.result.slice(0, 220)}</p>)}
            </div>
          </details>
        );
      })}
    </section>
  );
}
