import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { startPaperBot, enableLiveTrading, switchToPaper } from "@/lib/bots.functions";
import { toast } from "sonner";
import { Bot, Pause, Play, Plus, Square, Trash2, ScrollText, Zap, Undo2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TIMEFRAMES } from "@/lib/strategy";
import { EXCHANGES, exchangeName } from "@/lib/exchanges";

const D = "Configure automated trading bots with capital, sizing and risk limits.";
export const Route = createFileRoute("/_authenticated/bots")({
  head: () => ({ meta: [{ title: "Trading Bots — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Trading Bots — Quantra" }, { property: "og:description", content: D }] }),
  validateSearch: (s: Record<string, unknown>): { strategy?: string } => (typeof s["strategy"] === "string" ? { strategy: s["strategy"] } : {}),
  component: Bots,
});

const STATUS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary", backtesting: "outline", paper_trading: "default", running: "default", paused: "outline", stopped: "outline", error: "destructive",
};
const ENGINE_NOTE = "Bots run on our servers and are checked once a minute. Paper bots simulate orders; LIVE bots place real market orders on your exchange. Stop losses are checked every minute, not instantly — test on a testnet account first.";

async function load() {
  const [b, s, c] = await Promise.all([
    supabase.from("trading_bots").select("*, bot_configurations(*), strategies(name,status)").order("created_at", { ascending: false }),
    supabase.from("strategies").select("id,name,status,config"),
    supabase.from("exchange_connections").select("id,label,exchange,status").neq("status", "disconnected"),
  ]);
  if (b.error) throw new Error(b.error.message);
  return { bots: b.data, strategies: s.data ?? [], conns: c.data ?? [] };
}

function Bots() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["bots"], queryFn: load });
  const { strategy: preset } = Route.useSearch();
  const [open, setOpen] = useState(!!preset);
  const [logsFor, setLogsFor] = useState<{ id: string; name: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["bots"] });
  const start = useServerFn(startPaperBot);
  const toPaper = useServerFn(switchToPaper);
  const [liveFor, setLiveFor] = useState<{ id: string; name: string } | null>(null);
  async function backToPaper(id: string) {
    try { await toPaper({ data: { id } }); toast.success("Bot switched back to paper (stopped)"); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    refresh();
  }
  async function startBot(id: string) {
    try { await start({ data: { id } }); toast.success("Paper trading started"); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not start"); }
    refresh();
  }

  async function setStatus(id: string, status: "paused" | "stopped", msg: string) {
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("trading_bots").update({ status }).eq("id", id);
    if (error) return void toast.error(error.message);
    await supabase.from("bot_logs").insert({ bot_id: id, user_id: u.user!.id, message: msg });
    refresh();
  }
  async function remove(id: string) {
    if (!confirm("Delete this bot?")) return;
    const { error } = await supabase.from("trading_bots").delete().eq("id", id);
    if (error) return void toast.error(error.message);
    refresh();
  }

  return (
    <div>
      <PageHeader title="Trading bots" description={D} actions={<Button onClick={() => setOpen(true)} disabled={!q.data}><Plus className="mr-1 h-4 w-4" />New bot</Button>} />
      <div className="space-y-4 p-6">
        <p className="rounded-md border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">{ENGINE_NOTE}</p>
        {q.isLoading ? <Skeleton className="h-40" /> : q.isError ? <p className="text-sm text-destructive">{q.error.message}</p> : !q.data?.bots.length ? (
          <EmptyState icon={Bot} title="No bots yet" body="Create a bot from a validated strategy. Start in paper mode." action={<Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" />New bot</Button>} />
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground">{["Bot", "Market", "Strategy", "Mode", "Capital", "Risk", "Status", ""].map((h) => <th key={h} className="px-4 py-2 font-normal">{h}</th>)}</tr></thead>
              <tbody>
                {q.data.bots.map((b) => {
                  const cfg = Array.isArray(b.bot_configurations) ? b.bot_configurations[0] : b.bot_configurations;
                  return (
                    <tr key={b.id} className="border-t">
                      <td className="px-4 py-3 font-medium">{b.name}</td>
                      <td className="px-4 py-3 font-mono text-xs">{b.trading_pair} · {b.timeframe}<div className="text-muted-foreground">{exchangeName(b.exchange)}</div></td>
                      <td className="px-4 py-3 text-xs">{b.strategies?.name ?? "—"}</td>
                      <td className="px-4 py-3"><Badge variant={b.mode === "live" ? "destructive" : "outline"}>{b.mode}</Badge></td>
                      <td className="px-4 py-3 font-mono text-xs">{Number(b.allocated_capital).toLocaleString()}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{cfg ? `size ${Number(cfg.position_size_pct)}% · SL ${cfg.stop_loss_pct ?? "—"}% · TP ${cfg.take_profit_pct ?? "—"}% · max ${Number(cfg.max_exposure_pct)}%` : "—"}</td>
                      <td className="px-4 py-3"><Badge variant={STATUS[b.status]}>{b.status.replace("_", " ")}</Badge>{b.status_reason && <div className="mt-1 max-w-48 text-xs text-muted-foreground">{b.status_reason}</div>}{b.last_heartbeat_at && <div className="mt-1 text-xs text-muted-foreground">checked {new Date(b.last_heartbeat_at).toLocaleTimeString()}</div>}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Tooltip><TooltipTrigger asChild><span><Button size="icon" variant="ghost" aria-label="Start paper trading" disabled={b.status === "paper_trading" || b.status === "running"} onClick={() => (b.mode === "live" ? setLiveFor({ id: b.id, name: b.name }) : startBot(b.id))}><Play className="h-4 w-4" /></Button></span></TooltipTrigger><TooltipContent>{b.mode === "live" ? "Resume live trading" : "Start paper trading"}</TooltipContent></Tooltip>
                          {b.mode === "paper" ? (
                            <Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" aria-label="Go live" disabled={!b.exchange_connection_id} onClick={() => setLiveFor({ id: b.id, name: b.name })}><Zap className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>{b.exchange_connection_id ? "Switch to LIVE trading" : "Attach a trading account to go live"}</TooltipContent></Tooltip>
                          ) : (
                            <Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" aria-label="Back to paper" onClick={() => backToPaper(b.id)}><Undo2 className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Back to paper mode</TooltipContent></Tooltip>
                          )}
                          <Button size="icon" variant="ghost" aria-label="Pause" disabled={!["running", "paper_trading"].includes(b.status)} onClick={() => setStatus(b.id, "paused", "Bot paused by user")}><Pause className="h-4 w-4" /></Button>
                          <Button size="icon" variant="ghost" aria-label="Stop" disabled={["stopped", "draft"].includes(b.status)} onClick={() => setStatus(b.id, "stopped", "Bot stopped by user")}><Square className="h-4 w-4" /></Button>
                          <Button size="icon" variant="ghost" aria-label="Logs" onClick={() => setLogsFor({ id: b.id, name: b.name })}><ScrollText className="h-4 w-4" /></Button>
                          <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => remove(b.id)}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {q.data && <NewBotDialog open={open} onOpenChange={setOpen} data={q.data} preset={preset} onDone={refresh} />}
      <LogsSheet bot={logsFor} onClose={() => setLogsFor(null)} />
      <GoLiveDialog bot={liveFor} onClose={() => setLiveFor(null)} onDone={refresh} />
    </div>
  );
}

function NewBotDialog({ open, onOpenChange, data, onDone, preset }: { preset?: string | undefined; open: boolean; onOpenChange: (o: boolean) => void; data: Awaited<ReturnType<typeof load>>; onDone: () => void }) {
  const valid = data.strategies.filter((s) => s.status === "validated" || s.status === "deployed");
  const [strategyId, setStrategyId] = useState(preset && valid.some((s) => s.id === preset) ? preset : "");
  const [connId, setConnId] = useState("none");
  const [exchange, setExchange] = useState("binance");
  const [timeframe, setTimeframe] = useState("1h");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!strategyId) return void toast.error("Select a validated strategy");
    const f = new FormData(e.currentTarget);
    const num = (k: string) => { const v = String(f.get(k) ?? ""); return v === "" ? null : Number(v); };
    const conn = data.conns.find((c) => c.id === connId);
    setBusy(true);
    const { data: u } = await supabase.auth.getUser();
    const { data: bot, error } = await supabase.from("trading_bots").insert({
      user_id: u.user!.id, name: String(f.get("name")).slice(0, 60), strategy_id: strategyId,
      exchange_connection_id: conn?.id ?? null, exchange: conn?.exchange ?? exchange,
      trading_pair: String(f.get("pair")).toUpperCase(), timeframe, mode: "paper", status: "draft",
      allocated_capital: num("capital") ?? 0,
    }).select("id").single();
    if (error) { setBusy(false); return void toast.error(error.message); }
    const { error: cErr } = await supabase.from("bot_configurations").insert({
      bot_id: bot.id, user_id: u.user!.id,
      position_size_pct: num("size") ?? 10, max_exposure_pct: num("exposure") ?? 50,
      stop_loss_pct: num("sl"), take_profit_pct: num("tp"), max_open_positions: num("maxpos") ?? 1, daily_loss_limit_pct: num("dll"),
    });
    await supabase.from("bot_logs").insert({ bot_id: bot.id, user_id: u.user!.id, message: "Bot created in draft (paper mode)" });
    setBusy(false);
    if (cErr) return void toast.error(cErr.message);
    toast.success("Bot created");
    onDone();
    onOpenChange(false);
  }

  const strat = valid.find((s) => s.id === strategyId);
  const risk = (strat?.config as { risk?: Record<string, number | null>; pairs?: string[] } | undefined);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>New trading bot</DialogTitle><DialogDescription>Bots start in paper mode. Live trading requires separate confirmation in a later phase.</DialogDescription></DialogHeader>
        {valid.length === 0 ? (
          <p className="text-sm text-muted-foreground">You need a validated strategy first. <Link to="/strategies" className="text-primary hover:underline">Open strategies</Link></p>
        ) : (
          <form key={strategyId} onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2"><Label>Name</Label><Input name="name" required maxLength={60} defaultValue={strat ? `${strat.name} bot` : ""} /></div>
            <div className="space-y-1.5"><Label>Strategy</Label>
              <Select value={strategyId} onValueChange={setStrategyId}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{valid.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent></Select>
            </div>
            <div className="space-y-1.5"><Label>Trading account</Label>
              <Select value={connId} onValueChange={setConnId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">None (paper only)</SelectItem>{data.conns.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent></Select>
            </div>
            {connId === "none" && <div className="space-y-1.5"><Label>Exchange (market data)</Label>
              <Select value={exchange} onValueChange={setExchange}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{EXCHANGES.filter((e) => e.available).map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}</SelectContent></Select>
            </div>}
            <div className="space-y-1.5"><Label>Pair</Label><Input name="pair" required pattern="[A-Za-z0-9]{2,12}/[A-Za-z0-9]{2,12}" className="font-mono" defaultValue={risk?.pairs?.[0] ?? "BTC/USDT"} /></div>
            <div className="space-y-1.5"><Label>Timeframe</Label>
              <Select value={timeframe} onValueChange={setTimeframe}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TIMEFRAMES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select>
            </div>
            <N name="capital" label="Allocated capital" def={risk?.risk?.["capital_allocation"] ?? 1000} min={1} />
            <N name="size" label="Position size %" def={risk?.risk?.["position_size_pct"] ?? 10} min={0.01} max={100} />
            <N name="exposure" label="Max exposure %" def={50} min={0.01} max={100} />
            <N name="sl" label="Stop loss %" def={risk?.risk?.["stop_loss_pct"] ?? 2} min={0.01} max={99} required />
            <N name="tp" label="Take profit %" def={risk?.risk?.["take_profit_pct"] ?? null} min={0.01} />
            <N name="maxpos" label="Max open positions" def={risk?.risk?.["max_open_positions"] ?? 1} min={1} step="1" />
            <N name="dll" label="Daily loss limit %" def={risk?.risk?.["daily_loss_limit_pct"] ?? 5} min={0.01} max={100} />
            <DialogFooter className="sm:col-span-3"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy}>{busy ? "Creating…" : "Create bot"}</Button></DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function N({ name, label, def, min, max, step = "any", required }: { name: string; label: string; def: number | null; min?: number; max?: number; step?: string; required?: boolean }) {
  return <div className="space-y-1.5"><Label className="text-xs">{label}</Label><Input name={name} type="number" step={step} min={min} max={max} required={required} defaultValue={def ?? ""} className="font-mono" /></div>;
}

function LogsSheet({ bot, onClose }: { bot: { id: string; name: string } | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["bot_logs", bot?.id],
    enabled: !!bot,
    queryFn: async () => (await supabase.from("bot_logs").select("*").eq("bot_id", bot!.id).order("created_at", { ascending: false }).limit(200)).data ?? [],
  });
  return (
    <Sheet open={!!bot} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader><SheetTitle>{bot?.name} — logs</SheetTitle></SheetHeader>
        <div className="mt-4 space-y-1 overflow-y-auto px-4 font-mono text-xs">
          {q.data?.length === 0 && <p className="text-muted-foreground">No log entries.</p>}
          {q.data?.map((l) => <div key={l.id} className="flex gap-3"><span className="shrink-0 text-muted-foreground">{new Date(l.created_at).toLocaleString()}</span><span className={l.level === "error" ? "text-loss" : ""}>{l.message}</span></div>)}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function GoLiveDialog({ bot, onClose, onDone }: { bot: { id: string; name: string } | null; onClose: () => void; onDone: () => void }) {
  const enable = useServerFn(enableLiveTrading);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const r = await enable({ data: { id: bot!.id, confirm: "LIVE" } });
      toast.success(r.testnet ? "Live trading enabled on testnet" : "LIVE trading enabled — real money");
      onDone(); onClose(); setText("");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not enable live trading"); }
    setBusy(false);
  }
  return (
    <Dialog open={!!bot} onOpenChange={(o) => { if (!o) { onClose(); setText(""); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Go live with {bot?.name}?</DialogTitle><DialogDescription>This bot will place real market orders on your exchange using its trading account.</DialogDescription></DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Use a <span className="text-foreground">testnet</span> account first.</li>
          <li>Stop loss and take profit are checked once a minute, so fills can be worse than the set level.</li>
          <li>The bot spends its position size in the quote coin (e.g. USDT) — make sure the balance is there.</li>
          <li>Account limits and the emergency stop on the Risk page apply.</li>
        </ul>
        <div className="space-y-1.5"><Label>Type LIVE to confirm</Label><Input value={text} onChange={(e) => setText(e.target.value)} className="font-mono" autoComplete="off" /></div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="destructive" disabled={text !== "LIVE" || busy} onClick={go}>{busy ? "Enabling…" : "Enable live trading"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
