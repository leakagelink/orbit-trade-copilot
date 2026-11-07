import { z } from "zod";
import { Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { analystReport } from "@/lib/research";
import { AGENT_LABELS, RESEARCH_AGENTS } from "@/lib/research-pipeline";
import { newsItem } from "@/lib/research-news";

type Output = { id: string; agent: string; status: string; report: unknown };
const newsEvidence = z.object({ version: z.union([z.literal(2),z.literal(3)]), news: z.object({ provider: z.string(), fetchedAt: z.string(), limitation: z.string(), articles: z.array(newsItem) }), sentiment: z.object({ limitation: z.string() }) });
export function ResearchReports({ outputs, evidence, exportData }: { outputs: Output[]; evidence: unknown; exportData: unknown }) {
  const parsedEvidence = newsEvidence.safeParse(evidence);
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 3, advisoryOnly: true, executionAllowed: false, research: exportData },null,2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "algovirt-research.json"; link.click(); URL.revokeObjectURL(url);
  }
  return <>
    <div className="flex justify-end"><Button variant="outline" size="sm" onClick={download}><Download className="mr-2 h-4 w-4" />Download report</Button></div>
    {RESEARCH_AGENTS.flatMap(agent => outputs.filter(o => o.agent === agent)).map(output => {
      const parsed = analystReport.safeParse(output.report);
      const agent = RESEARCH_AGENTS.find(a => a === output.agent);
      if (!parsed.success || !agent) return null;
      const report = parsed.data;
      return <article key={output.id} className="rounded-lg border bg-card p-5"><div className="mb-4 flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{AGENT_LABELS[agent]}</h3><span className="text-xs text-muted-foreground">{output.status} · {report.outlook.replaceAll("_"," ")}</span></div><p className="text-sm leading-6">{report.summary}</p>{(["observations","risks","limitations"] as const).map(key => report[key].length > 0 && <div key={key} className="mt-4"><h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{key}</h4><ul className="list-disc space-y-1 pl-5 text-sm">{report[key].map((item,i) => <li key={i}>{item}</li>)}</ul></div>)}</article>;
    })}
    {parsedEvidence.success && <section className="space-y-3 border-t pt-5"><h3 className="text-sm font-semibold">News sources</h3><p className="text-xs text-muted-foreground">{parsedEvidence.data.news.provider} · Retrieved {new Date(parsedEvidence.data.news.fetchedAt).toLocaleString()}</p>{parsedEvidence.data.news.articles.map(article => <a key={article.uuid} href={article.link} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 border-b py-3 text-sm text-primary"><ExternalLink className="mt-1 h-4 w-4 shrink-0" /><span>{article.title}<span className="mt-1 block text-xs text-muted-foreground">{article.publisher} · {new Date(article.providerPublishTime*1000).toLocaleString()}</span></span></a>)}<p className="text-xs text-muted-foreground">{parsedEvidence.data.news.limitation}</p><p className="text-xs text-muted-foreground">{parsedEvidence.data.sentiment.limitation}</p></section>}
  </>;
}