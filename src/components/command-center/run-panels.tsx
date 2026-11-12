// Per-run views. All content is rendered as plain text (React escapes it); AI output is never injected as HTML.
import { AlertTriangle, Bot, Database, Lock, Scale, ShieldAlert, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AGENT_LABELS, RESEARCH_AGENTS } from "@/lib/research-pipeline";
import { agentDisagreement, allAgents, bullBearArguments, leakageWarnings, researchLimitations, unavailableSources, type AgentRecord } from "@/lib/research-transparency";
import { AGENT_INPUTS, AGENT_ROLES, DECISION_LABELS, managerConclusion, portfolioDecision } from "@/lib/research-decisions";
import { dataQuality } from "@/lib/research-data-quality";
import { RISK_EVALUATION_NOTICE, type RiskEvaluation } from "@/lib/research-risk-evaluation";
import { AI_MODEL } from "@/lib/ai-provider";
import { researchProposal } from "@/lib/research-proposal";
import { z } from "zod";
import { ADVISORY, Empty, List, num, outputsOf, Section, seconds, StatusPill, tokens, when, type Metric, type ResearchRun } from "./shared";

export const agentsOf = (run: ResearchRun) => allAgents(outputsOf(run));
const latestMetric = (metrics: Metric[], agent: string) => metrics.filter((m) => m.agent === agent).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
const proposalOf = (run: ResearchRun) => { const p = researchProposal.safeParse(run.ai_trade_proposals[0]?.proposal); return p.success ? p.data : null; };

export function AgentActivity({ run }: { run: ResearchRun }) {
  const agents = agentsOf(run);
  const running = run.status === "running" || run.status === "queued";
  const done = agents.filter((a) => a.status !== "not_run").length;
  return <Section title={`Agent activity · ${done} of 12 recorded`} icon={Bot}>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{agents.map((a) => {
      const m = latestMetric(run.ai_research_stage_metrics, a.agent);
      const status = a.status === "not_run" && running ? (m ? "running" : "waiting") : a.status;
      const reason = a.status === "failed" || a.status === "unavailable" ? a.report.limitations[0] ?? a.report.summary : null;
      return <article key={a.agent} className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3">
        <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="truncate text-sm font-semibold">{AGENT_LABELS[a.agent]}</h3><p className="text-[11px] leading-4 text-muted-foreground">{AGENT_ROLES[a.agent]}</p></div><StatusPill status={status} label={status === "not_run" ? "Not run" : undefined} /></div>
        {a.status === "completed" && <p className="line-clamp-3 text-xs leading-5">{a.report.summary}</p>}
        {reason && <p className="text-xs leading-5 text-loss">{reason}</p>}
        <dl className="mt-auto grid grid-cols-3 gap-2 border-t pt-2 text-[11px]">
          <div><dt className="text-muted-foreground">Tokens</dt><dd className="font-mono">{m ? `${tokens(m.input_tokens)} / ${tokens(m.output_tokens)}` : "—"}</dd></div>
          <div><dt className="text-muted-foreground">Cost</dt><dd className="font-mono">{m ? (m.provider_cost_usd === null ? "Unknown" : `$${num(Number(m.provider_cost_usd), 4)}`) : "—"}</dd></div>
          <div><dt className="text-muted-foreground">Time</dt><dd className="font-mono">{m ? seconds(m.duration_ms) : "—"}</dd></div>
        </dl>
        <p className="text-[11px] leading-4 text-muted-foreground">Sources: {AGENT_INPUTS[a.agent].length ? AGENT_INPUTS[a.agent].join(", ") : "none connected"}</p>
      </article>;
    })}</div>
    <p className="text-[11px] text-muted-foreground">Tokens are input / output as reported by the AI provider. Cost is shown only when the provider reports it; no price is assumed.</p>
  </Section>;
}

function Side({ title, tone, side, icon: Icon }: { title: string; tone: "gain" | "loss"; side: ReturnType<typeof bullBearArguments>["bull"]; icon: typeof TrendingUp }) {
  return <div className={`min-w-0 space-y-3 rounded-lg border p-4 ${tone === "gain" ? "border-gain/30 bg-gain/5" : "border-loss/30 bg-loss/5"}`}>
    <h3 className={`flex items-center gap-2 text-sm font-semibold ${tone === "gain" ? "text-gain" : "text-loss"}`}><Icon className="h-4 w-4" />{title}</h3>
    {!side.available ? <p className="text-sm text-muted-foreground">Unavailable ({side.status.replaceAll("_", " ")}): {side.reason}</p> : <>
      <p className="text-xs text-muted-foreground">Researcher outlook: {side.outlook.replaceAll("_", " ")}</p>
      <p className="text-sm leading-6">{side.summary}</p>
      <div><p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{tone === "gain" ? "Supporting evidence and upside" : "Contradicting evidence and downside risks"}</p><List items={side.arguments} /></div>
      <div><p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Acknowledged counterpoints and invalidation risks</p><List items={side.counterpoints} className="text-xs text-muted-foreground" /></div>
    </>}
  </div>;
}

export function DebatePanel({ run }: { run: ResearchRun }) {
  const agents = agentsOf(run);
  const { bull, bear } = bullBearArguments(agents);
  const dis = agentDisagreement(agents);
  const manager = agents.find((a) => a.agent === "manager");
  const conclusion = managerConclusion(manager);
  return <div className="space-y-5">
    <div className="grid gap-4 md:grid-cols-2"><Side title="Bull case" tone="gain" side={bull} icon={TrendingUp} /><Side title="Bear case" tone="loss" side={bear} icon={TrendingDown} /></div>
    <p className="text-[11px] text-muted-foreground">Both cases are shown exactly as each researcher wrote them; the Research Manager cannot change them. The current report format has no separate invalidation field, so invalidation risks appear with the counterpoints.</p>
    <Section title="Research Manager conclusion" icon={Scale} action={<StatusPill status={conclusion === "INSUFFICIENT_EVIDENCE" ? "INSUFFICIENT_DATA" : "PREVIEW_ONLY"} label={DECISION_LABELS[conclusion]} />}>
      {manager && manager.status === "completed" ? <><p className="text-sm leading-6">{manager.report.summary}</p><div className="grid gap-4 md:grid-cols-2"><div><p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Which evidence is stronger</p><List items={manager.report.observations} /></div><div><p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Missing information</p><List items={manager.report.limitations} /></div></div></> : <p className="text-sm text-muted-foreground">{manager?.report.summary ?? "No conclusion."}</p>}
    </Section>
    <Section title={`Disagreement · ${dis.level}`} icon={AlertTriangle}>
      {dis.conflicts.length ? <List items={dis.conflicts} /> : <p className="text-sm text-muted-foreground">{dis.level === "unavailable" ? "Too few completed assessments to compare." : "No directional conflicts among completed assessments."}</p>}
      <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">{RESEARCH_AGENTS.map((a) => <p key={a} className="text-xs"><span className="text-muted-foreground">{AGENT_LABELS[a]}:</span> {dis.outlooks[a]?.replaceAll("_", " ") ?? "no assessment"}</p>)}</div>
    </Section>
  </div>;
}

export function DecisionPanel({ run }: { run: ResearchRun }) {
  const agents = agentsOf(run);
  const portfolio = agents.find((a) => a.agent === "portfolio"), market = agents.find((a) => a.agent === "market");
  const d = portfolioDecision(portfolio, proposalOf(run));
  const dis = agentDisagreement(agents);
  const missing = unavailableSources(agents);
  const snap = snapshotOf(run);
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4"><div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">Final research direction</p><p className="text-2xl font-semibold">{DECISION_LABELS[d]}</p></div><StatusPill status="NOT_EXECUTABLE" label="Advisory research" /></div>
    <p className="text-xs text-muted-foreground">{ADVISORY} “Buy proposal” or “Sell proposal” appears only when the portfolio view, trader and conservative review agree and market data supports a scenario; otherwise the result is No trade, Hold or Insufficient evidence.</p>
    <Section title="Decision explanation"><p className="text-sm leading-6">{portfolio?.status === "completed" ? portfolio.report.summary : portfolio?.report.summary ?? "No portfolio decision."}</p></Section>
    <Section title="Market conditions"><p className="text-sm leading-6">{market?.status === "completed" ? market.report.summary : "Market analysis unavailable."}</p>{snap && <p className="text-xs text-muted-foreground">Last completed daily close {num(snap.close, 6)} on {new Date(snap.asOf).toLocaleDateString()} (Yahoo Finance). Not a live quote.</p>}</Section>
    <div className="grid gap-5 md:grid-cols-2">
      <Section title="Unresolved disagreements"><List items={dis.conflicts} /></Section>
      <Section title="Missing data"><List items={missing.map((m) => `${m.source} — ${m.status.replaceAll("_", " ")}: ${m.reason}`)} /></Section>
    </div>
    <Section title="Research limitations"><List items={[...leakageWarnings(snap?.asOf ?? null, AI_MODEL, Date.parse(run.completed_at ?? run.created_at)), ...researchLimitations(agents)]} className="text-xs text-muted-foreground" /></Section>
  </div>;
}

const snapshotShape = z.object({ close: z.number(), asOf: z.string(), fetchedAt: z.string().optional(), candles: z.array(z.unknown()) });
const evidenceShape = z.object({ news: z.object({ fetchedAt: z.string().optional(), limitation: z.string().optional(), articles: z.array(z.object({ providerPublishTime: z.number() })) }).nullable().optional(), sentiment: z.object({ limitation: z.string().optional() }).nullable().optional() });
export function snapshotOf(run: ResearchRun) { const s = snapshotShape.safeParse(run.snapshot); return s.success ? s.data : null; }

export function DataQualityPanel({ run }: { run: ResearchRun }) {
  const agents: AgentRecord[] = agentsOf(run);
  const snap = snapshotOf(run);
  const ev = evidenceShape.safeParse(run.research_evidence);
  const news = ev.success ? ev.data.news : null;
  const q = dataQuality({
    symbol: run.symbol, now: Date.parse(run.completed_at ?? run.created_at), agents,
    market: snap ? { asOf: snap.asOf, fetchedAt: snap.fetchedAt ?? null, candles: snap.candles.length } : null,
    fundamentals: null,
    news: news ? { headlines: news.articles.length, newestPublished: news.articles.length ? new Date(Math.max(...news.articles.map((a) => a.providerPublishTime)) * 1000).toISOString() : null, fetchedAt: news.fetchedAt ?? null, limitation: news.limitation ?? null } : null,
    sentiment: ev.success && ev.data.sentiment ? { limitation: ev.data.sentiment.limitation ?? null } : null,
    sourceError: snap ? null : run.error,
  });
  const c = q.dimensions.completeness;
  return <div className="space-y-5">
    <Section title="Sources" icon={Database}>
      <div className="divide-y rounded-lg border">{q.sources.map((s) => <div key={s.key} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-start sm:gap-3"><div className="flex min-w-0 items-center gap-2 sm:w-72 sm:shrink-0"><StatusPill status={s.status} label={s.status.replaceAll("_", " ")} /><span className="min-w-0 break-words text-sm font-medium">{s.label}</span></div><p className="min-w-0 text-xs leading-5 text-muted-foreground">{s.detail}{s.asOf ? ` · as of ${when(s.asOf)}` : ""}</p></div>)}</div>
    </Section>
    <Section title="Uncertainty, kept separate">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Dim title="Source completeness" value={`${c.available} available · ${c.partial} partial · ${c.stale} stale · ${c.unavailable} unavailable`} note={`Out of ${c.applicable} applicable sources${c.notApplicable ? `; ${c.notApplicable} not applicable` : ""}.`} />
        <Dim title="Data freshness" value={q.dimensions.freshness.ageHours === null ? "Unknown" : `${q.dimensions.freshness.ageHours} hours old at decision`} note={`Market data status: ${q.dimensions.freshness.status.replaceAll("_", " ")}.`} />
        <Dim title="Agent disagreement" value={q.dimensions.disagreement.level} note={`${q.dimensions.disagreement.conflicts.length} conflict(s) among completed agents.`} />
        <Dim title="Model uncertainty" value="Not assessed" note={q.dimensions.modelUncertainty.note} />
        <Dim title="Historical performance" value="No evidence" note={q.dimensions.historicalPerformance.note} />
      </div>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">How these statuses are decided</summary><ul className="mt-2 list-disc space-y-1 pl-5">{q.method.map((m) => <li key={m}>{m}</li>)}</ul></details>
    </Section>
  </div>;
}
const Dim = ({ title, value, note }: { title: string; value: string; note: string }) => <div className="min-w-0 rounded-lg border bg-card p-3"><p className="text-xs text-muted-foreground">{title}</p><p className="mt-1 text-sm font-semibold first-letter:uppercase">{value}</p><p className="mt-1 text-[11px] leading-4 text-muted-foreground">{note}</p></div>;

export function RiskEvaluationCard({ title, ev, note }: { title: string; ev: RiskEvaluation | null; note: string }) {
  return <div className="min-w-0 space-y-3 rounded-lg border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{title}</h3>{ev && <div className="flex gap-1.5"><StatusPill status={ev.decision} label={ev.decision.replaceAll("_", " ")} /><StatusPill status="NOT_EXECUTABLE" label="Not executable" /></div>}</div>
    <p className="text-[11px] text-muted-foreground">{note}</p>
    {!ev ? <p className="text-sm text-muted-foreground">Not available for this run.</p> : <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {([["Proposed direction", ev.proposedDirection], ["Reference entry", num(ev.reference.entry, 6)], ["Reference stop-loss", num(ev.reference.stopLoss, 6)], ["Reference take-profit", num(ev.reference.takeProfit, 6)], ["Estimated position size", num(ev.estimatedPositionSize, 6)], ["Estimated position value", num(ev.estimatedPositionValue)], ["Estimated risk at stop", num(ev.estimatedRiskAmount)], ["Remaining exposure budget", num(ev.availableRiskBudget.exposure)], ["Remaining daily-loss budget", num(ev.availableRiskBudget.dailyLoss)], ["Open positions left", num(ev.availableRiskBudget.positions, 0)], ["Current account exposure", num(ev.accountExposure)], ["Strategy exposure", "Not applicable"]] as const).map(([l, v]) => <div key={l} className="min-w-0"><dt className="text-[11px] text-muted-foreground">{l}</dt><dd className="mt-0.5 truncate font-mono text-sm">{v}</dd></div>)}
      </dl>
      <p className="text-[11px] text-muted-foreground">{ev.reference.label}</p>
      {ev.rejectionReasons.length > 0 && <div><p className="text-xs font-semibold text-loss">Rejection reasons</p><List items={ev.rejectionReasons} /></div>}
      {ev.missingInputs.length > 0 && <div><p className="text-xs font-semibold text-warning">Missing inputs</p><List items={ev.missingInputs} /></div>}
      <List items={[...ev.notes, ev.strategyNote]} className="text-xs text-muted-foreground" />
    </>}
  </div>;
}

export function RiskPanel({ stored, storedNote, live }: { stored: RiskEvaluation | null; storedNote: string; live: RiskEvaluation | null | undefined }) {
  return <div className="space-y-4">
    <div role="note" className="flex items-start gap-3 rounded-lg border border-loss/40 bg-loss/10 p-4 text-sm font-semibold text-loss"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />{RISK_EVALUATION_NOTICE}</div>
    <p className="text-xs text-muted-foreground">Sizing comes only from the Risk Engine: your saved risk limits, open positions, today's results and market volatility. AI text never sets the size, leverage, stop or any limit, and nothing here can be sent to an exchange.</p>
    <div className="grid gap-4 lg:grid-cols-2">
      <RiskEvaluationCard title="At decision time" ev={stored} note={storedNote} />
      <RiskEvaluationCard title="With your current limits" ev={live ?? null} note={live === undefined ? "Calculating…" : "Recalculated now for reference. Not saved."} />
    </div>
  </div>;
}

export function RecordBar({ runId, record, loading }: { runId: string; record: { storage: string; recordJson: string | null; sha256: string | null; createdAt: string | null } | undefined; loading: boolean }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 text-xs">
    <span className="flex min-w-0 items-center gap-2"><Lock className="h-4 w-4 shrink-0 text-primary" />{loading ? "Checking decision record…" : record?.storage === "immutable" ? `Permanent record · stored ${when(record.createdAt)} · SHA-256 ${record.sha256?.slice(0, 12)}…` : record?.storage === "provisional" ? "Provisional record: permanent storage starts once the database change is approved" : record?.storage === "unverified" ? "Record could not be verified" : "No decision record (this run predates decision records)"}</span>
    {record?.recordJson && <Button variant="outline" size="sm" onClick={() => { const url = URL.createObjectURL(new Blob([record.recordJson ?? ""], { type: "application/json" })); const l = document.createElement("a"); l.href = url; l.download = `algovirt-decision-${runId}.json`; l.click(); URL.revokeObjectURL(url); }}>Download record</Button>}
  </div>;
}

/** Reads the stored evaluation from a decision record (schema 2). Older records have none. */
export function storedEvaluation(recordJson: string | null | undefined): RiskEvaluation | null {
  if (!recordJson) return null;
  try {
    const r = JSON.parse(recordJson) as { riskEvaluation?: { evaluation?: RiskEvaluation } };
    const e = r.riskEvaluation?.evaluation;
    return e && e.status === "NOT_EXECUTABLE" && e.executionAuthorized === false ? e : null;
  } catch { return null; }
}
