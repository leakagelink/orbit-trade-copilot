import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { FlaskConical, LoaderCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { analystReport, RESEARCH_SYMBOLS } from "@/lib/research";
import { listResearch, startResearchRun } from "@/lib/research.functions";

const researchQuery = queryOptions({ queryKey: ["ai-research"], queryFn: () => listResearch(), retry: false });
const title = "AI Research — AlgoVirt";
const description = "Private market and fundamentals research grounded in historical market data. Advisory reports only.";
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
    <header className="flex flex-wrap items-center justify-between gap-4"><div><div className="mb-2 flex items-center gap-2 text-primary"><FlaskConical className="h-5 w-5" /><span className="text-xs font-semibold uppercase">Research desk · Phase 1</span></div><h1 className="text-2xl font-semibold">AI Research</h1></div><Button variant="outline" size="icon" aria-label="Refresh research history" onClick={() => qc.invalidateQueries({ queryKey: ["ai-research"] })}><RefreshCw className="h-4 w-4" /></Button></header>
    <div className="flex flex-wrap gap-3 border-y py-4"><Select value={symbol} onValueChange={value => { const match = RESEARCH_SYMBOLS.find(s => s === value); if (match) setSymbol(match); }}><SelectTrigger className="w-48" aria-label="Research symbol"><SelectValue /></SelectTrigger><SelectContent>{RESEARCH_SYMBOLS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select><Button disabled={busy} onClick={analyze}>{busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-2 h-4 w-4" />}{busy ? "Analyzing…" : "Run research"}</Button></div>
    <p className="text-xs text-muted-foreground">Historical daily data · Advisory only · No orders or trade proposals</p>
    <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]"><aside className="space-y-2"><h2 className="mb-3 text-sm font-semibold">Research history</h2>{runs.length === 0 && <p className="text-sm text-muted-foreground">No research runs yet.</p>}{runs.map(r => <Button key={r.id} variant={run?.id === r.id ? "secondary" : "ghost"} className="h-auto w-full justify-start py-3 text-left" onClick={() => setSelected(r.id)}><span className="min-w-0"><span className="block">{r.symbol} · {r.status}</span><span className="block text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span></span></Button>)}</aside>
      <section className="space-y-5">{run ? <><div className="border-b pb-4"><h2 className="text-xl font-semibold">{run.symbol}</h2><p className="text-sm text-muted-foreground">{run.status} · Yahoo Finance · Daily candles</p>{run.error && <p className="mt-2 text-sm text-destructive">{run.error}</p>}{run.status === "running" && <p className="mt-2 text-sm text-muted-foreground">Report pending. Refresh history to check its status; do not resubmit the same run.</p>}</div>{run.ai_agent_outputs.map(output => { const parsed = analystReport.safeParse(output.report); if (!parsed.success) return null; const report = parsed.data; return <article key={output.id} className="rounded-lg border bg-card p-5"><div className="mb-4 flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{output.agent === "market" ? "Market Analyst" : "Fundamentals Analyst"}</h3><span className="text-xs text-muted-foreground">{output.status} · {report.outlook.replaceAll("_"," ")}</span></div><p className="text-sm leading-6">{report.summary}</p>{(["observations","risks","limitations"] as const).map(key => report[key].length > 0 && <div key={key} className="mt-4"><h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{key}</h4><ul className="list-disc space-y-1 pl-5 text-sm">{report[key].map((item,i) => <li key={i}>{item}</li>)}</ul></div>)}</article>; })}</> : <div className="py-16 text-center text-muted-foreground"><FlaskConical className="mx-auto mb-3 h-8 w-8" /><p>No analyst reports yet</p></div>}</section>
    </div>
  </div>;
}