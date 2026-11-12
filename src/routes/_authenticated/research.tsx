import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { FlaskConical, History, LoaderCircle, Orbit, RefreshCw, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RESEARCH_SYMBOLS } from "@/lib/research";
import { RESEARCH_STRATEGY } from "@/lib/research-record";
import { ResearchReports } from "@/components/research-reports";
import { ResearchProposalView } from "@/components/research-proposal";
import { ResearchPaperPanel } from "@/components/research-paper-panel";
import { cancelResearchRun, getResearchOverview, listResearch, startResearchRun, type ResearchFilters } from "@/lib/research.functions";
import { getResearchInsights } from "@/lib/research-insights.functions";
import { AgentActivity, agentsOf, DataQualityPanel, DebatePanel, DecisionPanel, RecordBar, RiskPanel, storedEvaluation } from "@/components/command-center/run-panels";
import { CostPanel, OverviewPanel } from "@/components/command-center/account-panels";
import { ADVISORY, Empty, outputsOf, StatusPill, when, type ResearchRun } from "@/components/command-center/shared";

type Sym = (typeof RESEARCH_SYMBOLS)[number];
const MARKETS = { crypto: { label: "Crypto", symbols: RESEARCH_SYMBOLS.filter((s) => s.endsWith("-USD")) }, equity: { label: "Stocks", symbols: RESEARCH_SYMBOLS.filter((s) => !s.endsWith("-USD")) } } as const;
type Market = keyof typeof MARKETS;
const STATUSES = ["running", "completed", "partial", "failed", "cancelled", "budget_exceeded"] as const;
const active = (r: { status: string }) => r.status === "running" || r.status === "queued";

const researchQuery = (f: ResearchFilters) => queryOptions({ queryKey: ["ai-research", f], queryFn: () => listResearch({ data: f }), retry: false });
const overviewQuery = queryOptions({ queryKey: ["ai-research-overview"], queryFn: () => getResearchOverview(), retry: false });
const title = "Orbit AI Command Center — AlgoVirt";
const description = "Private 12-agent market research with a permanent decision record, bull and bear debate, source quality, read-only risk previews and AI usage. Research never places orders.";

export const Route = createFileRoute("/_authenticated/research")({
  loader: ({ context }) => Promise.all([context.queryClient.ensureQueryData(researchQuery({})), context.queryClient.ensureQueryData(overviewQuery)]),
  head: () => ({ meta: [{ title }, { name: "description", content: description }, { property: "og:title", content: title }, { property: "og:description", content: description }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }] }),
  component: CommandCenter,
});

function CommandCenter() {
  const qc = useQueryClient();
  const { data: runs } = useSuspenseQuery({ ...researchQuery({}), refetchInterval: (q) => (q.state.data?.some(active) ? 4000 : false) });
  const { data: overview } = useSuspenseQuery({ ...overviewQuery, refetchInterval: runs.some(active) ? 8000 : false });
  const [tab, setTab] = useState("overview");
  const [selected, setSelected] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [extra, setExtra] = useState<ResearchRun | undefined>();
  const run = runs.find((r) => r.id === (selected ?? pending)) ?? (extra && extra.id === selected ? extra : undefined) ?? runs[0];
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["ai-research"] }), qc.invalidateQueries({ queryKey: ["ai-research-overview"] }), qc.invalidateQueries({ queryKey: ["research-insights"] })]);
  const open = (id: string, from?: ResearchRun) => { setSelected(id); setExtra(from); setTab("research"); };
  return <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><div className="mb-1 flex items-center gap-2 text-primary"><Orbit className="h-5 w-5" /><span className="text-xs font-semibold uppercase tracking-wide">Engine A · Research AI</span></div><h1 className="text-2xl font-semibold">Orbit AI Command Center</h1><p className="mt-1 text-sm text-muted-foreground">{ADVISORY}</p></div>
      <Button variant="outline" size="icon" aria-label="Refresh" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
    </header>
    <Tabs value={tab} onValueChange={setTab} className="space-y-5">
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"><TabsList><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="research">Research</TabsTrigger><TabsTrigger value="history">History</TabsTrigger><TabsTrigger value="costs">AI costs</TabsTrigger></TabsList></div>
      <TabsContent value="overview"><OverviewPanel o={overview} onOpen={(id) => open(id)} /></TabsContent>
      <TabsContent value="research" className="space-y-5">
        <Workspace busy={!!pending} onStart={(id) => { setPending(id); setSelected(id); }} onDone={async () => { setPending(undefined); await refresh(); }} runningRun={runs.find(active)} />
        {run ? <RunView key={run.id} run={run} onRefresh={refresh} /> : <Empty>No research runs yet. Choose a symbol above and start one.</Empty>}
      </TabsContent>
      <TabsContent value="history"><HistoryPanel initial={runs} onOpen={open} /></TabsContent>
      <TabsContent value="costs"><CostPanel o={overview} isAdmin={overview.isAdmin} /></TabsContent>
    </Tabs>
  </div>;
}

function Workspace({ busy, onStart, onDone, runningRun }: { busy: boolean; onStart: (id: string) => void; onDone: () => Promise<void>; runningRun: ResearchRun | undefined }) {
  const start = useServerFn(startResearchRun);
  const [market, setMarket] = useState<Market>("crypto");
  const [symbol, setSymbol] = useState<Sym>("BTC-USD");
  const blocked = busy || !!runningRun;
  async function analyze() {
    if (!(MARKETS[market].symbols as readonly string[]).includes(symbol)) { toast.error("Choose a symbol for the selected market"); return; }
    const requestId = crypto.randomUUID();
    onStart(requestId);
    try {
      const r = await start({ data: { symbol, requestId } });
      if ("status" in r) { if (r.status) toast[r.status === "completed" ? "success" : "message"](`Research ${r.status.replaceAll("_", " ")}${r.stopReason ? `: ${r.stopReason}` : ""}`); else toast.message(r.stopReason ?? "This research run is already being handled."); }
    } catch (e) { toast.error(e instanceof Error ? e.message : "Research unavailable"); }
    finally { await onDone(); }
  }
  return <section className="space-y-3 rounded-xl border bg-card p-4" aria-label="Research workspace">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end">
      <Field label="Market"><Select value={market} onValueChange={(v) => { if (v === "crypto" || v === "equity") { setMarket(v); setSymbol(MARKETS[v].symbols[0]!); } }}><SelectTrigger aria-label="Market"><SelectValue /></SelectTrigger><SelectContent>{(Object.keys(MARKETS) as Market[]).map((m) => <SelectItem key={m} value={m}>{MARKETS[m].label}</SelectItem>)}</SelectContent></Select></Field>
      <Field label="Symbol"><Select value={symbol} onValueChange={(v) => { const s = MARKETS[market].symbols.find((x) => x === v); if (s) setSymbol(s); }}><SelectTrigger aria-label="Symbol"><SelectValue /></SelectTrigger><SelectContent>{MARKETS[market].symbols.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select></Field>
      <Field label="Timeframe"><Select value="1d" disabled><SelectTrigger aria-label="Timeframe"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="1d">Daily (completed candles)</SelectItem></SelectContent></Select></Field>
      <Field label="Research strategy"><Select value={RESEARCH_STRATEGY.key} disabled><SelectTrigger aria-label="Research strategy"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={RESEARCH_STRATEGY.key}>{RESEARCH_STRATEGY.label}</SelectItem></SelectContent></Select></Field>
      <Button disabled={blocked} onClick={analyze} className="w-full lg:w-auto">{busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-2 h-4 w-4" />}{busy ? "Researching…" : "Run research"}</Button>
    </div>
    <p className="text-[11px] text-muted-foreground">{runningRun && !busy ? `A ${runningRun.symbol} run is still in progress; one run at a time. ` : ""}Only daily timeframe and one research strategy are supported. Each run uses one of your monthly research runs and is checked against your AI spending limits before every call.</p>
  </section>;
}
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <div className="min-w-0 space-y-1"><Label className="text-xs text-muted-foreground">{label}</Label>{children}</div>;

function RunView({ run, onRefresh }: { run: ResearchRun; onRefresh: () => Promise<unknown> }) {
  const load = useServerFn(getResearchInsights);
  const cancel = useServerFn(cancelResearchRun);
  const insights = useQuery({ queryKey: ["research-insights", run.id, run.status], queryFn: () => load({ data: { runId: run.id } }), retry: false, enabled: !active(run) });
  const [stopping, setStopping] = useState(false);
  const done = agentsOf(run).filter((a) => a.status !== "not_run").length;
  const rec = insights.data?.record;
  const histRows = useMemo(() => { try { return insights.data?.evaluations.rowsJson ? (JSON.parse(insights.data.evaluations.rowsJson) as { evaluation: unknown }[]) : []; } catch { return []; } }, [insights.data]);
  const stored = storedEvaluation(rec?.recordJson) ?? (histRows[0] ? storedEvaluation(JSON.stringify({ riskEvaluation: { evaluation: histRows[0].evaluation } })) : null);
  const storedNote = !stored ? "This run finished before risk evaluations were recorded." : insights.data?.evaluations.storage === "immutable" && histRows.length ? "Saved permanently when the run finished." : rec?.storage === "provisional" ? "Saved with the provisional record when the run finished." : "Saved with the run's decision record.";
  async function stop() {
    setStopping(true);
    try { const r = await cancel({ data: { runId: run.id } }); toast.success(r.closed ? "Run closed as cancelled" : "Cancellation requested. The run stops before its next AI call."); await onRefresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not cancel"); } finally { setStopping(false); }
  }
  return <section className="space-y-4" aria-label="Research run">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-semibold">{run.symbol}</h2><StatusPill status={run.status} /></div><p className="mt-1 text-xs text-muted-foreground">Started {when(run.created_at)}{run.completed_at ? ` · finished ${when(run.completed_at)}` : ""} · Daily · {RESEARCH_STRATEGY.label} · Yahoo Finance</p>{run.error && <p className="mt-2 text-sm text-loss">{run.error}</p>}</div>
      {active(run) && <Button variant="outline" size="sm" disabled={stopping} onClick={stop}><Square className="mr-2 h-3.5 w-3.5" />Cancel run</Button>}
    </div>
    {active(run) && <div className="space-y-1"><Progress value={(done / 12) * 100} aria-label="Research progress" /><p className="text-xs text-muted-foreground">{done} of 12 agents recorded. Updates every few seconds; do not resubmit.</p></div>}
    {!active(run) && <RecordBar runId={run.id} record={rec} loading={insights.isLoading} />}
    <Tabs defaultValue="agents" className="space-y-4">
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"><TabsList><TabsTrigger value="agents">Agents</TabsTrigger><TabsTrigger value="debate">Bull vs Bear</TabsTrigger><TabsTrigger value="decision">Decision</TabsTrigger><TabsTrigger value="risk">Risk preview</TabsTrigger><TabsTrigger value="data">Data quality</TabsTrigger><TabsTrigger value="reports">Full reports</TabsTrigger></TabsList></div>
      <TabsContent value="agents"><AgentActivity run={run} /></TabsContent>
      <TabsContent value="debate"><DebatePanel run={run} /></TabsContent>
      <TabsContent value="decision" className="space-y-5"><DecisionPanel run={run} />{run.ai_trade_proposals.map((p) => <ResearchProposalView key={p.id} proposal={p.proposal} />)}<ResearchPaperPanel proposalId={run.ai_trade_proposals[0]?.id} proposal={run.ai_trade_proposals[0]?.proposal} /></TabsContent>
      <TabsContent value="risk">{active(run) ? <Empty>The risk evaluation is calculated when the run finishes.</Empty> : insights.isError ? <Empty>Risk evaluation is unavailable right now. Nothing was executed.</Empty> : <RiskPanel stored={stored} storedNote={storedNote} live={insights.isLoading ? undefined : insights.data?.liveEvaluation ?? null} />}</TabsContent>
      <TabsContent value="data"><DataQualityPanel run={run} /></TabsContent>
      <TabsContent value="reports" className="space-y-4"><ResearchReports outputs={outputsOf(run)} evidence={run.research_evidence} exportData={run} /></TabsContent>
    </Tabs>
  </section>;
}

function HistoryPanel({ initial, onOpen }: { initial: ResearchRun[]; onOpen: (id: string, run?: ResearchRun) => void }) {
  const [f, setF] = useState<ResearchFilters>({});
  const filtered = Object.keys(f).length > 0;
  const q = useQuery({ ...researchQuery(f), enabled: filtered });
  const rows = filtered ? q.data : initial;
  const set = (k: keyof ResearchFilters, v: string | undefined) => setF((p) => { const n = { ...p } as Record<string, string>; if (v) n[k] = v; else delete n[k]; return n as ResearchFilters; });
  return <div className="space-y-4">
    <div className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-3 lg:grid-cols-6">
      <Field label="From"><Input type="date" value={f.from ?? ""} onChange={(e) => set("from", e.target.value || undefined)} /></Field>
      <Field label="To"><Input type="date" value={f.to ?? ""} onChange={(e) => set("to", e.target.value || undefined)} /></Field>
      <Field label="Market"><Select value={f.market ?? "all"} onValueChange={(v) => set("market", v === "all" ? undefined : v)}><SelectTrigger aria-label="Filter market"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All markets</SelectItem><SelectItem value="crypto">Crypto</SelectItem><SelectItem value="equity">Stocks</SelectItem></SelectContent></Select></Field>
      <Field label="Symbol"><Select value={f.symbol ?? "all"} onValueChange={(v) => set("symbol", v === "all" ? undefined : v)}><SelectTrigger aria-label="Filter symbol"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All symbols</SelectItem>{RESEARCH_SYMBOLS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select></Field>
      <Field label="Strategy"><Select value={RESEARCH_STRATEGY.key} disabled><SelectTrigger aria-label="Filter strategy"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={RESEARCH_STRATEGY.key}>{RESEARCH_STRATEGY.label}</SelectItem></SelectContent></Select></Field>
      <Field label="Status"><Select value={f.status ?? "all"} onValueChange={(v) => set("status", v === "all" ? undefined : v)}><SelectTrigger aria-label="Filter status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem>{STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></Field>
    </div>
    {filtered && q.isLoading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />Loading history…</p>
      : filtered && q.isError ? <Empty>History is unavailable right now.</Empty>
      : !rows?.length ? <Empty>{filtered ? "No runs match these filters." : "No research runs yet."}</Empty>
      : <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Symbol</TableHead><TableHead>Market</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Agents</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>{rows.map((r) => <TableRow key={r.id}><TableCell className="whitespace-nowrap text-xs">{when(r.created_at)}</TableCell><TableCell className="font-medium">{r.symbol}</TableCell><TableCell className="text-xs">{r.symbol.endsWith("-USD") ? "Crypto" : "Stocks"}</TableCell><TableCell><StatusPill status={r.status} /></TableCell><TableCell className="text-right font-mono text-xs">{agentsOf(r).filter((a) => a.status === "completed").length}/12</TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => onOpen(r.id, r)}><History className="mr-1 h-3.5 w-3.5" />Open</Button></TableCell></TableRow>)}</TableBody></Table></div>}
    <p className="text-[11px] text-muted-foreground">Up to 50 most recent matching runs. History is read-only; failed and stopped runs are kept.</p>
  </div>;
}
