import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle2, AlertTriangle, Plus, Trash2, History, FlaskConical, Rocket } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  INDICATORS, INDICATOR_DEFAULTS, INDICATOR_LABELS, OPERATORS, TIMEFRAMES, validateStrategy,
  type Condition, type IndicatorType, type StrategyConfig,
} from "@/lib/strategy";
import { saveStrategyVersion } from "@/lib/strategies.api";
import { SignalPreview } from "@/components/signal-preview";
import { BacktestDialog } from "@/components/backtest-dialog";

export const Route = createFileRoute("/_authenticated/strategies/$id")({
  head: () => ({ meta: [{ title: "Strategy builder — Quantra" }, { name: "description", content: "Edit indicators, entry/exit rules and risk for your strategy." }, { property: "og:title", content: "Strategy builder — Quantra" }, { property: "og:description", content: "Edit indicators, entry/exit rules and risk for your strategy." }] }),
  component: Builder,
});

function Builder() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["strategy", id],
    queryFn: async () => {
      const [s, v] = await Promise.all([
        supabase.from("strategies").select("*").eq("id", id).single(),
        supabase.from("strategy_versions").select("id,version,notes,created_at,config").eq("strategy_id", id).order("version", { ascending: false }),
      ]);
      if (s.error) throw new Error(s.error.message);
      return { s: s.data, versions: v.data ?? [] };
    },
  });
  const [cfg, setCfg] = useState<StrategyConfig | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [pairsText, setPairsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [btOpen, setBtOpen] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    const c = q.data.s.config as unknown as StrategyConfig;
    setCfg(c);
    setName(q.data.s.name);
    setDesc(q.data.s.description ?? "");
    setPairsText(c.pairs.join(", "));
  }, [q.data]);

  const issues = useMemo(() => (cfg ? validateStrategy(cfg) : []), [cfg]);
  if (q.isError) return <div className="p-6 text-sm text-destructive">{q.error.message}</div>;
  if (!cfg || !q.data) return <div className="p-6"><Skeleton className="h-96" /></div>;

  const set = (patch: Partial<StrategyConfig>) => setCfg({ ...cfg, ...patch });
  const setRisk = (k: keyof StrategyConfig["risk"], v: string) => set({ risk: { ...cfg.risk, [k]: v === "" ? null : Number(v) } });
  const operands = ["price", ...cfg.indicators.map((i) => i.id)];

  function addIndicator(type: IndicatorType) {
    const n = cfg!.indicators.filter((i) => i.type === type).length + 1;
    set({ indicators: [...cfg!.indicators, { id: `${type.toLowerCase()}_${n}`, type, params: { ...INDICATOR_DEFAULTS[type] } }] });
  }
  function updateCond(side: "entry" | "exit", i: number, patch: Partial<Condition>) {
    const list = cfg![side].conditions.map((c, j) => (j === i ? { ...c, ...patch } : c));
    set({ [side]: { ...cfg![side], conditions: list } } as Partial<StrategyConfig>);
  }

  async function save() {
    setBusy(true);
    try {
      const { version, issues } = await saveStrategyVersion(id, name.trim() || "Untitled strategy", desc, cfg!, q.data!.s.current_version);
      toast.success(`Saved v${version}${issues.length ? ` — ${issues.length} issue(s) to fix before deploy` : " — validated"}`);
      qc.invalidateQueries({ queryKey: ["strategy", id] });
      qc.invalidateQueries({ queryKey: ["strategies"] });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader
        title={name || "Strategy"}
        description={`Version ${q.data.s.current_version} · ${q.data.s.status}`}
        actions={
          <>
            <Button variant="ghost" asChild><Link to="/strategies"><ArrowLeft className="mr-1 h-4 w-4" />All strategies</Link></Button>
            <Tooltip><TooltipTrigger asChild><span><Button variant="outline" disabled={issues.length > 0} onClick={() => setBtOpen(true)}><FlaskConical className="mr-1 h-4 w-4" />Backtest</Button></span></TooltipTrigger><TooltipContent>{issues.length ? "Fix validation issues first" : "Test the saved version on historical prices"}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><span><Button variant="outline" disabled={issues.length > 0} asChild={issues.length === 0}>{issues.length === 0 ? <Link to="/bots" search={{ strategy: id }}><Rocket className="mr-1 h-4 w-4" />Deploy to bot</Link> : <><Rocket className="mr-1 h-4 w-4" />Deploy to bot</>}</Button></span></TooltipTrigger><TooltipContent>{issues.length ? "Fix validation issues first" : "Attach this strategy to a bot"}</TooltipContent></Tooltip>
            <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save new version"}</Button>
          </>
        }
      />
      <BacktestDialog strategyId={id} capital={cfg.risk.capital_allocation} open={btOpen} onOpenChange={setBtOpen} />
      <div className="grid gap-6 p-6 xl:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Section title="Live signal preview"><SignalPreview cfg={cfg} /></Section>
          <Section title="General">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></div>
              <div className="space-y-1.5"><Label>Timeframe</Label>
                <Select value={cfg.timeframe} onValueChange={(v) => set({ timeframe: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TIMEFRAMES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2"><Label>Trading pairs (comma separated)</Label>
                <Input className="font-mono" value={pairsText} onChange={(e) => { setPairsText(e.target.value); set({ pairs: e.target.value.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean) }); }} placeholder="BTC/USDT, ETH/USDT" />
              </div>
              <div className="space-y-1.5 sm:col-span-2"><Label>Description</Label><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} maxLength={500} /></div>
            </div>
          </Section>

          <Section title="Indicators" action={
            <Select value="" onValueChange={(v) => addIndicator(v as IndicatorType)}>
              <SelectTrigger className="h-8 w-40 text-xs"><Plus className="h-3.5 w-3.5" /><SelectValue placeholder="Add indicator" /></SelectTrigger>
              <SelectContent>{INDICATORS.map((t) => <SelectItem key={t} value={t}>{INDICATOR_LABELS[t]}</SelectItem>)}</SelectContent>
            </Select>
          }>
            {cfg.indicators.length === 0 ? <p className="text-sm text-muted-foreground">No indicators yet. Add RSI, EMA, MACD and more.</p> : (
              <div className="space-y-2">
                {cfg.indicators.map((ind, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-3 rounded-md border bg-background p-3">
                    <div className="w-32"><div className="font-mono text-xs text-primary">{ind.id}</div><div className="text-sm">{INDICATOR_LABELS[ind.type]}</div></div>
                    {Object.entries(ind.params).map(([k, v]) => (
                      <div key={k} className="w-24 space-y-1"><Label className="text-xs">{k}</Label>
                        <Input type="number" className="h-8 font-mono" value={v} onChange={(e) => set({ indicators: cfg.indicators.map((x, j) => j === i ? { ...x, params: { ...x.params, [k]: Number(e.target.value) } } : x) })} />
                      </div>
                    ))}
                    <Button size="icon" variant="ghost" className="ml-auto" aria-label="Remove indicator" onClick={() => set({ indicators: cfg.indicators.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {(["entry", "exit"] as const).map((side) => (
            <Section key={side} title={side === "entry" ? "Entry conditions" : "Exit conditions"} action={
              <div className="flex items-center gap-2">
                <Select value={cfg[side].logic} onValueChange={(v) => set({ [side]: { ...cfg[side], logic: v } } as Partial<StrategyConfig>)}>
                  <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Match all</SelectItem><SelectItem value="any">Match any</SelectItem></SelectContent>
                </Select>
                <Button size="sm" variant="outline" onClick={() => set({ [side]: { ...cfg[side], conditions: [...cfg[side].conditions, { left: operands[1] ?? "price", operator: "<", right: "30" }] } } as Partial<StrategyConfig>)}><Plus className="mr-1 h-3.5 w-3.5" />Condition</Button>
              </div>
            }>
              {cfg[side].conditions.length === 0 ? <p className="text-sm text-muted-foreground">No conditions.</p> : (
                <div className="space-y-2">
                  {cfg[side].conditions.map((c, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Select value={c.left} onValueChange={(v) => updateCond(side, i, { left: v })}><SelectTrigger className="h-8 w-36 font-mono text-xs"><SelectValue /></SelectTrigger><SelectContent>{operands.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent></Select>
                      <Select value={c.operator} onValueChange={(v) => updateCond(side, i, { operator: v as Condition["operator"] })}><SelectTrigger className="h-8 w-36 font-mono text-xs"><SelectValue /></SelectTrigger><SelectContent>{OPERATORS.map((o) => <SelectItem key={o} value={o}>{o.replace("_", " ")}</SelectItem>)}</SelectContent></Select>
                      <Input className="h-8 w-36 font-mono text-xs" value={c.right} onChange={(e) => updateCond(side, i, { right: e.target.value })} placeholder="value or indicator id" list={`ops-${side}`} />
                      <Button size="icon" variant="ghost" aria-label="Remove condition" onClick={() => set({ [side]: { ...cfg[side], conditions: cfg[side].conditions.filter((_, j) => j !== i) } } as Partial<StrategyConfig>)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  ))}
                  <datalist id={`ops-${side}`}>{operands.map((o) => <option key={o} value={o} />)}</datalist>
                </div>
              )}
            </Section>
          ))}

          <Section title="Risk & position sizing">
            <div className="grid gap-4 sm:grid-cols-3">
              {([
                ["stop_loss_pct", "Stop loss %"], ["take_profit_pct", "Take profit %"], ["trailing_stop_pct", "Trailing stop %"],
                ["position_size_pct", "Position size % of capital"], ["capital_allocation", "Capital allocation"], ["max_open_positions", "Max open positions"],
                ["daily_loss_limit_pct", "Daily loss limit %"],
              ] as const).map(([k, l]) => (
                <div key={k} className="space-y-1.5"><Label className="text-xs">{l}</Label><Input type="number" step="any" className="font-mono" value={cfg.risk[k] ?? ""} onChange={(e) => setRisk(k, e.target.value)} placeholder="off" /></div>
              ))}
            </div>
          </Section>
        </div>

        <aside className="space-y-6">
          <div className="rounded-lg border bg-card p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              {issues.length === 0 ? <><CheckCircle2 className="h-4 w-4 text-gain" />Valid — eligible to deploy</> : <><AlertTriangle className="h-4 w-4 text-warning" />{issues.length} validation issue(s)</>}
            </div>
            <ul className="space-y-1.5 text-xs text-muted-foreground">{issues.map((x, i) => <li key={i}><span className="font-mono text-foreground">{x.path}</span> — {x.message}</li>)}</ul>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium"><History className="h-4 w-4" />Versions</div>
            <div className="space-y-2">
              {q.data.versions.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-2 text-xs">
                  <div><Badge variant={v.version === q.data.s.current_version ? "default" : "outline"}>v{v.version}</Badge> <span className="text-muted-foreground">{new Date(v.created_at).toLocaleString()}</span></div>
                  {v.version !== q.data.s.current_version && <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => { const c = v.config as unknown as StrategyConfig; setCfg(c); setPairsText(c.pairs.join(", ")); toast.info(`Loaded v${v.version} — save to make it current`); }}>Load</Button>}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-sm font-medium">{title}</h2>{action}</div>
      {children}
    </section>
  );
}
