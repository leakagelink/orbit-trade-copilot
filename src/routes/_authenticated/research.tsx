import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { FlaskConical, LoaderCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RESEARCH_SYMBOLS } from "@/lib/research";
import { ResearchReports } from "@/components/research-reports";
import { ResearchProposalView } from "@/components/research-proposal";
import { listResearch, startResearchRun } from "@/lib/research.functions";

const researchQuery = queryOptions({ queryKey: ["ai-research"], queryFn: () => listResearch(), retry: false });
const title = "AI Research — AlgoVirt";
const description = "Private multi-agent market research, bull–bear debate, risk reviews and historical advisory trade scenarios. Research never submits orders.";
export const Route = createFileRoute("/_authenticated/research")({
  loader: ({ context }) => context.queryClient.ensureQueryData(researchQuery),
  head: () => ({ meta: [{ title }, { name: "description", content: description }, { property: "og:title", content: title }, { property: "og:description", content: description }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }] }),
  component: Research,
});
function Research() {
  const { data: runs } = useSuspenseQuery(researchQuery);
  const qc = useQueryClient();
  const start = useServerFn(startResearchRun);
  const [symbol,setSymbol] = useState<(typeof RESEARCH_SYMBOLS)[number]>("BTC-USD");
  const [selected,setSelected] = useState<string>();
  const [busy,setBusy] = useState(false);
  const run = runs.find(r => r.id === selected) ?? runs[0];
  async function analyze() {
    setBusy(true);
    try { const result = await start({ data: { symbol, requestId: crypto.randomUUID() } }); setSelected(result.runId); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Research unavailable"); }
    finally { await qc.invalidateQueries({ queryKey: ["ai-research"] }); setBusy(false); }
  }
  return <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><div className="mb-2 flex items-center gap-2 text-primary"><FlaskConical className="h-5 w-5" /><span className="text-xs font-semibold uppercase">Research desk</span></div><h1 className="text-2xl font-semibold">AI Research</h1></div><Button variant="outline" size="icon" aria-label="Refresh research history" onClick={() => qc.invalidateQueries({ queryKey: ["ai-research"] })}><RefreshCw className="h-4 w-4" /></Button></header>
    <div className="flex flex-wrap gap-3 border-y py-4"><Select value={symbol} onValueChange={value => { const match = RESEARCH_SYMBOLS.find(s => s === value); if (match) setSymbol(match); }}><SelectTrigger className="w-48" aria-label="Research symbol"><SelectValue /></SelectTrigger><SelectContent>{RESEARCH_SYMBOLS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select><Button disabled={busy} onClick={analyze}>{busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-2 h-4 w-4" />}{busy ? "Analyzing…" : "Run research"}</Button></div>
    <p className="text-xs text-muted-foreground">Historical daily data · Advisory scenarios only · No orders placed</p>
    <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]"><aside className="space-y-2"><h2 className="mb-3 text-sm font-semibold">Research history</h2>{runs.length === 0 && <p className="text-sm text-muted-foreground">No research runs yet.</p>}{runs.map(r => <Button key={r.id} variant={run?.id === r.id ? "secondary" : "ghost"} className="h-auto w-full justify-start py-3 text-left" onClick={() => setSelected(r.id)}><span className="min-w-0"><span className="block">{r.symbol} · {r.status}</span><span className="block text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span></span></Button>)}</aside>
      <section className="space-y-5">{run ? <><div className="border-b pb-4"><h2 className="text-xl font-semibold">{run.symbol}</h2><p className="text-sm text-muted-foreground">{run.status} · Yahoo Finance · Daily candles</p>{run.error && <p className="mt-2 text-sm text-destructive">{run.error}</p>}{run.status === "running" && <p className="mt-2 text-sm text-muted-foreground">Report pending. Refresh history to check its status; do not resubmit the same run.</p>}</div>{run.ai_trade_proposals.map(p => <ResearchProposalView key={p.id} proposal={p.proposal} />)}<ResearchReports outputs={[...run.ai_agent_outputs,...run.ai_research_reports,...run.ai_research_decisions]} evidence={run.research_evidence} exportData={run} /></> : <div className="py-16 text-center text-muted-foreground"><FlaskConical className="mx-auto mb-3 h-8 w-8" /><p>No analyst reports yet</p></div>}</section>
    </div>
  </div>;
}