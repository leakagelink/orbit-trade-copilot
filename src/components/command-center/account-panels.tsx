import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Coins, Gauge } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AGENT_LABELS, RESEARCH_AGENTS } from "@/lib/research-pipeline";
import { AI_PROVIDER_NAME } from "@/lib/ai-provider";
import { DEFAULT_RESEARCH_BUDGET, type ResearchBudget } from "@/lib/research-budget";
import { saveResearchBudget } from "@/lib/research-insights.functions";
import type { getResearchOverview } from "@/lib/research.functions";
import { Empty, num, Section, seconds, Stat, StatusPill, tokens, when } from "./shared";

export type Overview = Awaited<ReturnType<typeof getResearchOverview>>;
const costText = (c: { status: string; amountUsd: number | null }) => c.status === "ACTUAL_PROVIDER_COST" && c.amountUsd !== null ? `$${num(c.amountUsd, 4)}` : "Unknown";

export function OverviewPanel({ o, onOpen }: { o: Overview; onOpen: (id: string) => void }) {
  const s = o.runs.byStatus;
  const failed = (s["failed"] ?? 0) + (s["cancelled"] ?? 0) + (s["budget_exceeded"] ?? 0);
  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Research runs" value={o.runs.total} />
      <Stat label="Completed" value={s["completed"] ?? 0} />
      <Stat label="Partial" value={s["partial"] ?? 0} />
      <Stat label="Failed or stopped" value={failed} hint={`${s["failed"] ?? 0} failed · ${s["cancelled"] ?? 0} cancelled · ${s["budget_exceeded"] ?? 0} limit`} />
      <Stat label="Research spend" value={costText(o.totals.cost)} hint={o.totals.cost.status === "UNKNOWN_COST" ? `${AI_PROVIDER_NAME} reports no price` : "Provider-reported"} />
      <Stat label="Average duration" value={seconds(o.runs.avgDurationMs)} hint="Finished runs" />
      <Stat label="Latest activity" value={o.runs.latest ? o.runs.latest.symbol : "—"} hint={o.runs.latest ? `${o.runs.latest.status} · ${when(o.runs.latest.createdAt)}` : "No runs yet"} />
      <Stat label="Active runs" value={o.runs.active.length} hint={o.runs.active[0] ? `${o.runs.active[0].symbol} since ${when(o.runs.active[0].createdAt)}` : "None running"} />
    </div>
    <Section title="Recent runs" icon={Activity}>
      {o.byRun.length === 0 ? <Empty>No research runs yet. Start one from the Research tab.</Empty> :
        <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>Symbol</TableHead><TableHead>Status</TableHead><TableHead>Started</TableHead><TableHead className="text-right">AI calls</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>{o.byRun.slice(0, 8).map((r) => <TableRow key={r.runId}><TableCell className="font-medium">{r.symbol}</TableCell><TableCell><StatusPill status={r.status} /></TableCell><TableCell className="whitespace-nowrap text-xs">{when(r.createdAt)}</TableCell><TableCell className="text-right font-mono">{r.calls}</TableCell><TableCell className="text-right font-mono">{tokens(r.inputTokens + r.outputTokens)}</TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => onOpen(r.runId)}>Open</Button></TableCell></TableRow>)}</TableBody></Table></div>}
    </Section>
    <p className="text-[11px] text-muted-foreground">All figures come from your stored research records. Nothing is estimated or simulated.</p>
  </div>;
}

export function CostPanel({ o, isAdmin }: { o: Overview; isAdmin: boolean }) {
  const b = o.budget;
  const remaining = (limit: number, used: number | null) => used === null ? "Unknown" : tokens(Math.max(0, limit - used));
  const agents = RESEARCH_AGENTS.map((a) => o.byAgent.find((x) => x.agent === a)).filter((x): x is NonNullable<typeof x> => !!x);
  return <div className="space-y-6">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Provider calls" value={o.totals.calls} hint={`${o.totals.failed} failed · automatic retries: none`} />
      <Stat label="Input tokens" value={tokens(o.totals.inputTokens)} />
      <Stat label="Output tokens" value={tokens(o.totals.outputTokens)} />
      <Stat label="Avg cost per completed run" value={costText(o.avgCostPerCompletedRun)} />
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <Stat label="Reported actual cost" value={o.totals.cost.reportedPartUsd === null ? "None reported" : `$${num(o.totals.cost.reportedPartUsd, 4)}`} hint="Only amounts the provider reports" />
      <Stat label="Estimated cost" value="Not estimated" hint="No verified rates are configured" />
      <Stat label="Unknown cost" value={`${o.totals.calls} calls`} hint={o.totals.cost.status === "UNKNOWN_COST" ? o.totals.cost.note : "All calls reported a cost"} />
    </div>
    <Section title="Spending limits" icon={Gauge}>
      {!b ? <Empty>Spending limits could not be read. New research is refused until they can be verified.</Empty> : <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Per run" value={tokens(b.limits.perRunTokens)} hint={`At most ${b.limits.maxCallsPerRun} AI calls, ${b.limits.maxRepairsPerRun} format corrections and ${Math.round(b.limits.maxRunSeconds / 60)} minutes`} />
          <Stat label="Your daily limit" value={tokens(b.limits.perUserDayTokens)} hint={`Remaining today: ${remaining(b.limits.perUserDayTokens, b.userDayTokens)}`} />
          <Stat label="Your monthly limit" value={tokens(b.limits.perUserMonthTokens)} hint={`Remaining this month: ${remaining(b.limits.perUserMonthTokens, b.userMonthTokens)}`} />
          <Stat label="Dollar caps" value={b.limits.perRunUsd === null ? "Off" : `$${b.limits.perRunUsd}/run`} hint="Apply only to provider-reported cost" />
        </div>
        <p className="text-[11px] text-muted-foreground">Limits are in tokens because {AI_PROVIDER_NAME} reports tokens but no price. They are checked before every AI call. {b.source === "configured" ? "Set by an admin." : b.source === "default" ? "Default limits." : "Default limits; saving custom limits starts once the database change is approved."}</p>
        {isAdmin && <BudgetForm initial={b.limits} />}
      </>}
    </Section>
    <Section title="By agent" icon={Coins}>
      {agents.length === 0 ? <Empty>No AI calls recorded yet.</Empty> :
        <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>Agent</TableHead><TableHead className="text-right">Calls</TableHead><TableHead className="text-right">Failed</TableHead><TableHead className="text-right">Input</TableHead><TableHead className="text-right">Output</TableHead><TableHead className="text-right">Avg time</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
          <TableBody>{agents.map((a) => <TableRow key={a.agent}><TableCell className="whitespace-nowrap">{AGENT_LABELS[a.agent as keyof typeof AGENT_LABELS] ?? a.agent}</TableCell><TableCell className="text-right font-mono">{a.calls}</TableCell><TableCell className="text-right font-mono">{a.failed}</TableCell><TableCell className="text-right font-mono">{tokens(a.inputTokens)}</TableCell><TableCell className="text-right font-mono">{tokens(a.outputTokens)}</TableCell><TableCell className="text-right font-mono">{seconds(a.avgDurationMs)}</TableCell><TableCell className="text-right font-mono">{costText(a.cost)}</TableCell></TableRow>)}</TableBody></Table></div>}
    </Section>
    <Section title="By research run">
      {o.byRun.length === 0 ? <Empty>No research runs yet.</Empty> :
        <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>Run</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Calls</TableHead><TableHead className="text-right">Input</TableHead><TableHead className="text-right">Output</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
          <TableBody>{o.byRun.map((r) => <TableRow key={r.runId}><TableCell className="whitespace-nowrap"><span className="font-medium">{r.symbol}</span> <span className="text-xs text-muted-foreground">{when(r.createdAt)}</span></TableCell><TableCell><StatusPill status={r.status} /></TableCell><TableCell className="text-right font-mono">{r.calls}</TableCell><TableCell className="text-right font-mono">{tokens(r.inputTokens)}</TableCell><TableCell className="text-right font-mono">{tokens(r.outputTokens)}</TableCell><TableCell className="text-right font-mono">{costText(r.cost)}</TableCell></TableRow>)}</TableBody></Table></div>}
    </Section>
  </div>;
}

function BudgetForm({ initial }: { initial: ResearchBudget }) {
  const save = useServerFn(saveResearchBudget); const qc = useQueryClient();
  const str = (n: number | null) => (n === null ? "" : String(n));
  const [v, setV] = useState<Record<keyof ResearchBudget, string>>({ perRunTokens: str(initial.perRunTokens), perUserDayTokens: str(initial.perUserDayTokens), perUserMonthTokens: str(initial.perUserMonthTokens), platformMonthTokens: str(initial.platformMonthTokens), maxCallsPerRun: str(initial.maxCallsPerRun), maxRepairsPerRun: str(initial.maxRepairsPerRun), maxRunSeconds: str(initial.maxRunSeconds), perRunUsd: str(initial.perRunUsd), platformMonthUsd: str(initial.platformMonthUsd) });
  const fields: [keyof ResearchBudget, string][] = [["perRunTokens", "Tokens per run"], ["perUserDayTokens", "Tokens per user / day"], ["perUserMonthTokens", "Tokens per user / month"], ["platformMonthTokens", "Platform tokens / month"], ["maxCallsPerRun", "AI calls per run"], ["maxRepairsPerRun", "Format corrections per run"], ["maxRunSeconds", "Max run time (seconds)"], ["perRunUsd", "USD per run (blank = off)"], ["platformMonthUsd", "Platform USD / month (blank = off)"]];
  async function submit() {
    const n = (k: keyof ResearchBudget) => Number(v[k]);
    try { await save({ data: { perRunTokens: n("perRunTokens"), perUserDayTokens: n("perUserDayTokens"), perUserMonthTokens: n("perUserMonthTokens"), platformMonthTokens: n("platformMonthTokens"), maxCallsPerRun: n("maxCallsPerRun"), maxRepairsPerRun: n("maxRepairsPerRun"), maxRunSeconds: n("maxRunSeconds"), perRunUsd: v.perRunUsd ? n("perRunUsd") : null, platformMonthUsd: v.platformMonthUsd ? n("platformMonthUsd") : null } }); toast.success("Research spending limits saved"); await qc.invalidateQueries({ queryKey: ["ai-research-overview"] }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Limits could not be saved"); }
  }
  return <div className="space-y-3 rounded-lg border p-4"><p className="text-xs font-semibold">Admin · research spending limits (defaults: {DEFAULT_RESEARCH_BUDGET.perRunTokens.toLocaleString()} per run, {DEFAULT_RESEARCH_BUDGET.perUserDayTokens.toLocaleString()} per user per day)</p>
    <div className="grid gap-3 sm:grid-cols-3">{fields.map(([k, l]) => <div key={k} className="space-y-1"><Label htmlFor={`budget-${k}`} className="text-xs">{l}</Label><Input id={`budget-${k}`} inputMode="decimal" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></div>)}</div>
    <Button size="sm" variant="outline" onClick={submit}>Save limits</Button></div>;
}
