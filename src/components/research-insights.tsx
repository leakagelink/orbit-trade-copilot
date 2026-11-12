import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Gauge, Lock, Scale } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AGENT_LABELS, RESEARCH_AGENTS } from "@/lib/research-pipeline";
import { agentDisagreement, allAgents, bullBearArguments, leakageWarnings, researchLimitations, unavailableSources } from "@/lib/research-transparency";
import { AI_MODEL, AI_PROVIDER_NAME } from "@/lib/ai-provider";
import { DEFAULT_RESEARCH_BUDGET, type ResearchBudget } from "@/lib/research-budget";
import { getResearchInsights, saveResearchBudget } from "@/lib/research-insights.functions";
import type { RiskPreview } from "@/lib/research-risk-preview";

type Row = { agent: string; status: string; report: unknown };
type Metric = { id: string; agent: string; status: string; duration_ms: number; input_tokens: number | null; output_tokens: number | null; provider_cost_usd: number | null };
const fmt = (n: number | null | undefined, d = 6) => n === null || n === undefined ? "Unavailable" : new Intl.NumberFormat(undefined, { maximumFractionDigits: d }).format(n);
const H = ({ icon: Icon, children }: { icon: typeof Scale; children: React.ReactNode }) => <h3 className="flex items-center gap-2 text-sm font-semibold"><Icon className="h-4 w-4 text-primary" />{children}</h3>;

export function ResearchInsights({ runId, outputs, metrics, asOf }: { runId: string; outputs: Row[]; metrics: Metric[]; asOf: string | null }) {
  const load = useServerFn(getResearchInsights);
  const q = useQuery({ queryKey: ["research-insights", runId], queryFn: () => load({ data: { runId } }), retry: false });
  const agents = allAgents(outputs);
  const { bull, bear } = bullBearArguments(agents);
  const dis = agentDisagreement(agents);
  const missing = unavailableSources(agents);
  const limits = researchLimitations(agents);
  const leakage = leakageWarnings(asOf, AI_MODEL);
  const tokens = metrics.reduce((a, m) => a + (m.input_tokens ?? 0) + (m.output_tokens ?? 0), 0);
  const record = q.data?.record;
  return <section className="space-y-6 border-y py-5" aria-label="Research transparency">
    <div className="flex flex-wrap items-center justify-between gap-2"><H icon={Lock}>Decision record</H>
      <span className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">{record?.recordJson && <Button variant="outline" size="sm" onClick={() => { const url = URL.createObjectURL(new Blob([record.recordJson ?? ""], { type: "application/json" })); const l = document.createElement("a"); l.href = url; l.download = `algovirt-decision-${runId}.json`; l.click(); URL.revokeObjectURL(url); }}>Download record</Button>}{q.isLoading ? "Checking…" : record?.storage === "immutable" ? `Immutable · stored ${new Date(record.createdAt ?? "").toLocaleString()} · SHA-256 ${record.sha256?.slice(0, 12)}…` : record?.storage === "provisional" ? "Provisional — immutable storage awaits approval of migration 0043" : record?.storage === "unverified" ? "Record could not be verified" : "No decision record (run predates decision records)"}</span></div>
    <div className="grid gap-4 md:grid-cols-2">{([["Bull arguments", bull], ["Bear arguments", bear]] as const).map(([title, side]) => <div key={title} className="rounded-lg border bg-card p-4"><h4 className="text-sm font-semibold">{title}</h4>{side.available ? <><p className="mt-1 text-xs text-muted-foreground">Outlook: {side.outlook.replaceAll("_", " ")}</p><ul className="mt-3 list-disc space-y-1 pl-5 text-sm">{side.arguments.map(a => <li key={a}>{a}</li>)}</ul>{side.counterpoints.length > 0 && <><p className="mt-3 text-xs font-semibold uppercase text-muted-foreground">Acknowledged counterpoints</p><ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{side.counterpoints.map(a => <li key={a}>{a}</li>)}</ul></>}</> : <p className="mt-2 text-sm text-muted-foreground">Unavailable ({side.status.replaceAll("_", " ")}): {side.reason}</p>}</div>)}</div>
    <div className="space-y-2"><H icon={Scale}>Agent disagreement · {dis.level}</H>
      {dis.conflicts.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{dis.conflicts.map(c => <li key={c}>{c}</li>)}</ul> : <p className="text-sm text-muted-foreground">{dis.level === "unavailable" ? "Too few completed assessments to compare." : "No directional conflicts among completed assessments."}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{RESEARCH_AGENTS.map(a => <p key={a} className="text-xs"><span className="text-muted-foreground">{AGENT_LABELS[a]}:</span> {dis.outlooks[a]?.replaceAll("_", " ") ?? "no assessment"}</p>)}</div></div>
    <div className="space-y-2"><H icon={AlertTriangle}>Missing or unavailable</H>{missing.length ? <ul className="space-y-1 text-sm">{missing.map(m => <li key={m.source}><span className="font-medium">{m.source}</span> · {m.status.replaceAll("_", " ")} — <span className="text-muted-foreground">{m.reason}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">Every source and agent completed.</p>}<p className="text-xs text-muted-foreground">Missing data is never estimated or filled in.</p></div>
    <div className="space-y-2"><h3 className="text-sm font-semibold">Limitations and hindsight warnings</h3><ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">{[...leakage, ...limits].map(l => <li key={l}>{l}</li>)}</ul></div>
    <PreviewBlock preview={q.data?.livePreview?.preview ?? null} block={q.data?.livePreview?.riskEngineBlock ?? null} loading={q.isLoading} />
    <div className="space-y-2"><H icon={Gauge}>Usage and spending limits</H>
      <p className="text-sm">{metrics.length} AI calls · {tokens.toLocaleString()} provider-reported tokens · {metrics.reduce((a, m) => a + m.duration_ms, 0) / 1000}s total</p>
      <p className="text-xs text-muted-foreground">Cost: {metrics.some(m => m.provider_cost_usd !== null) ? `$${fmt(metrics.reduce((a, m) => a + (m.provider_cost_usd ?? 0), 0), 4)} reported` : `not reported by ${AI_PROVIDER_NAME}; no price is assumed`}.</p>
      {q.data?.budget && <p className="text-xs text-muted-foreground">Limits ({q.data.budget.source === "configured" ? "set by admin" : q.data.budget.source === "default" ? "defaults" : "defaults; saving needs migration 0043"}): {q.data.budget.limits.perRunTokens.toLocaleString()} tokens per run · {q.data.budget.limits.perUserMonthTokens.toLocaleString()} per user per month{q.data.userMonthTokens !== null ? ` (you used ${q.data.userMonthTokens.toLocaleString()})` : ""} · platform {q.data.budget.limits.platformMonthTokens.toLocaleString()} per month · USD caps {q.data.budget.limits.perRunUsd === null ? "off" : `$${q.data.budget.limits.perRunUsd} per run`} (apply only to provider-reported cost)</p>}
      {q.data?.isAdmin && q.data.budget && <BudgetForm initial={q.data.budget.limits} />}
    </div>
  </section>;
}

function PreviewBlock({ preview, block, loading }: { preview: RiskPreview | null; block: string | null; loading: boolean }) {
  return <div className="space-y-2 rounded-lg border bg-card p-4"><h3 className="text-sm font-semibold">Risk Engine position-size preview · read-only</h3>
    {loading ? <p className="text-sm text-muted-foreground">Calculating…</p> : !preview ? <p className="text-sm text-muted-foreground">Preview unavailable.</p> : <>
      <p className="text-xs text-muted-foreground">Status: {preview.status}{preview.blockReason ? ` — ${preview.blockReason}` : ""}{block ? ` · Risk Engine: ${block}` : ""}</p>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">{([["Reference price (estimate)", preview.referencePrice], ["Stop distance (1 ATR)", preview.stopDistance], ["Quantity (estimate)", preview.quantity], ["Position value (estimate)", preview.positionValue], ["Loss at stop (estimate)", preview.maxLossAtStop], ["Remaining exposure", preview.remaining.exposure], ["Remaining daily loss", preview.remaining.dailyLoss]] as const).map(([l, v]) => <div key={l}><dt className="text-xs text-muted-foreground">{l}</dt><dd className="mt-1 font-mono text-sm">{fmt(v)}</dd></div>)}<div><dt className="text-xs text-muted-foreground">Leverage</dt><dd className="mt-1 font-mono text-sm">{preview.leverage}</dd></div></dl>
      {preview.unavailable.length > 0 && <ul className="list-disc pl-5 text-xs text-muted-foreground">{preview.unavailable.map(u => <li key={u}>{u}</li>)}</ul>}
      <ul className="list-disc pl-5 text-xs text-muted-foreground">{preview.labels.map(l => <li key={l}>{l}</li>)}<li>Uses your current limits; AI assessments do not change any of these values.</li></ul></>}
  </div>;
}

function BudgetForm({ initial }: { initial: ResearchBudget }) {
  const save = useServerFn(saveResearchBudget); const qc = useQueryClient();
  const [v, setV] = useState({ perRunTokens: String(initial.perRunTokens), perUserMonthTokens: String(initial.perUserMonthTokens), platformMonthTokens: String(initial.platformMonthTokens), perRunUsd: initial.perRunUsd === null ? "" : String(initial.perRunUsd), platformMonthUsd: initial.platformMonthUsd === null ? "" : String(initial.platformMonthUsd) });
  const fields: [keyof typeof v, string][] = [["perRunTokens", "Tokens per run"], ["perUserMonthTokens", "Tokens per user / month"], ["platformMonthTokens", "Platform tokens / month"], ["perRunUsd", "USD per run (blank = off)"], ["platformMonthUsd", "Platform USD / month (blank = off)"]];
  async function submit() {
    try { await save({ data: { perRunTokens: Number(v.perRunTokens), perUserMonthTokens: Number(v.perUserMonthTokens), platformMonthTokens: Number(v.platformMonthTokens), perRunUsd: v.perRunUsd ? Number(v.perRunUsd) : null, platformMonthUsd: v.platformMonthUsd ? Number(v.platformMonthUsd) : null } }); toast.success("Research spending limits saved"); await qc.invalidateQueries({ queryKey: ["research-insights"] }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Limits could not be saved"); }
  }
  return <div className="space-y-3 border-t pt-3"><p className="text-xs font-semibold">Admin · research spending limits (defaults: {DEFAULT_RESEARCH_BUDGET.perRunTokens.toLocaleString()} / {DEFAULT_RESEARCH_BUDGET.perUserMonthTokens.toLocaleString()} / {DEFAULT_RESEARCH_BUDGET.platformMonthTokens.toLocaleString()} tokens)</p>
    <div className="grid gap-3 sm:grid-cols-3">{fields.map(([k, l]) => <div key={k} className="space-y-1"><Label htmlFor={`budget-${k}`} className="text-xs">{l}</Label><Input id={`budget-${k}`} inputMode="decimal" value={v[k]} onChange={e => setV({ ...v, [k]: e.target.value })} /></div>)}</div>
    <Button size="sm" variant="outline" onClick={submit}>Save limits</Button></div>;
}
