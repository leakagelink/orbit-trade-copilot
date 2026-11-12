// Data availability and uncertainty, per research run. Pure and browser-safe.
// Each dimension is reported separately; they are never combined into one confidence number.
import type { AgentRecord } from "./research-transparency";
import { agentDisagreement } from "./research-transparency";

export type SourceStatus = "AVAILABLE" | "UNAVAILABLE" | "STALE" | "PARTIAL" | "CONFLICTING" | "NOT_APPLICABLE";
export interface SourceQuality { key: string; label: string; status: SourceStatus; asOf: string | null; detail: string }
export interface DataQualityInput {
  symbol: string;
  now: number;
  market: { asOf: string | null; fetchedAt: string | null; candles: number } | null;
  /** null = not recorded for this run; the matching agent status is used instead. */
  fundamentals: { statements: number | null; latestStatement: string | null; limitation: string | null } | null;
  news: { headlines: number | null; newestPublished: string | null; fetchedAt: string | null; limitation: string | null } | null;
  sentiment: { limitation: string | null } | null;
  agents: AgentRecord[];
  sourceError?: string | null;
}
const DAY = 86_400_000;
export const DATA_QUALITY_METHOD = [
  "AVAILABLE: the source returned the data this research needs and it is recent.",
  "PARTIAL: some data arrived but coverage is limited (for example headlines without article text).",
  "STALE: data arrived but is older than the freshness window (market: 2 days for crypto, 4 days for stocks; statements: 18 months; headlines: 7 days).",
  "UNAVAILABLE: the source returned nothing or is not connected. Nothing is estimated in its place.",
  "NOT_APPLICABLE: the source does not exist for this market (company statements for crypto).",
  "CONFLICTING: completed agents reached opposite directions.",
  "Completeness, freshness, disagreement, model uncertainty and track record are shown separately and are never merged into one confidence percentage.",
];

const age = (iso: string | null, now: number) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? now - t : null; };

export function dataQuality(i: DataQualityInput) {
  const crypto = i.symbol.endsWith("-USD");
  const agent = (k: string) => i.agents.find((a) => a.agent === k);
  const sources: SourceQuality[] = [];

  // Market data
  if (!i.market || i.market.candles === 0) sources.push({ key: "market", label: "Market data (daily candles)", status: "UNAVAILABLE", asOf: null, detail: i.sourceError ?? "Market data could not be loaded." });
  else {
    const a = age(i.market.asOf, i.now); const window = (crypto ? 2 : 4) * DAY;
    const status: SourceStatus = a === null || a > window ? "STALE" : i.market.candles < 50 ? "PARTIAL" : "AVAILABLE";
    sources.push({ key: "market", label: "Market data (daily candles)", status, asOf: i.market.asOf, detail: `${i.market.candles} completed daily candles from Yahoo Finance${a !== null ? `; latest is ${Math.max(0, Math.round(a / 3_600_000))} hours old` : ""}. Not a live quote.` });
  }

  // Fundamentals
  if (crypto) sources.push({ key: "fundamentals", label: "Company financial statements", status: "NOT_APPLICABLE", asOf: null, detail: "Company statements do not apply to cryptocurrencies. Tokenomics and on-chain data are not connected." });
  else {
    const f = i.fundamentals; const fa = agent("fundamentals");
    const n = f?.statements ?? null;
    if (n === null) sources.push({ key: "fundamentals", label: "Company financial statements", status: fa?.status === "completed" ? "PARTIAL" : "UNAVAILABLE", asOf: null, detail: fa?.status === "completed" ? "Annual revenue and net income only; valuation data is not connected." : (fa?.report.limitations[0] ?? "No statements were recorded for this run.") });
    else if (n === 0) sources.push({ key: "fundamentals", label: "Company financial statements", status: "UNAVAILABLE", asOf: null, detail: f?.limitation ?? "No financial statements were returned." });
    else { const a = age(f?.latestStatement ?? null, i.now); sources.push({ key: "fundamentals", label: "Company financial statements", status: a !== null && a > 548 * DAY ? "STALE" : "PARTIAL", asOf: f?.latestStatement ?? null, detail: `${n} annual data points (revenue, net income). Valuation data is not connected.` }); }
  }

  // News headlines (current) and historical news archive
  {
    const nw = i.news; const na = agent("news"); const n = nw?.headlines ?? null;
    if (n === null) sources.push({ key: "news", label: "News headlines", status: na?.status === "completed" ? "PARTIAL" : "UNAVAILABLE", asOf: null, detail: na?.status === "completed" ? "Headline metadata only; full articles are not read." : (na?.report.limitations[0] ?? "No headlines were recorded for this run.") });
    else if (n === 0) sources.push({ key: "news", label: "News headlines", status: "UNAVAILABLE", asOf: nw?.fetchedAt ?? null, detail: nw?.limitation ?? "No headlines were returned." });
    else { const a = age(nw?.newestPublished ?? null, i.now); sources.push({ key: "news", label: "News headlines", status: a !== null && a > 7 * DAY ? "STALE" : "PARTIAL", asOf: nw?.newestPublished ?? null, detail: `${n} headlines with publisher and time only; full articles are not read.` }); }
    sources.push({ key: "news_history", label: "Historical news archive", status: "UNAVAILABLE", asOf: null, detail: "No point-in-time news archive is connected, so past runs cannot be checked against the news known on that date." });
  }

  // Social sentiment
  sources.push({ key: "sentiment", label: "Social sentiment", status: "UNAVAILABLE", asOf: null, detail: i.sentiment?.limitation ?? "Authorized social-data access is not connected; no sentiment was estimated." });

  // Agent views
  const dis = agentDisagreement(i.agents);
  sources.push({ key: "agents", label: "Agent assessments", status: dis.level === "unavailable" ? "UNAVAILABLE" : dis.level === "high" ? "CONFLICTING" : "AVAILABLE", asOf: null, detail: dis.level === "unavailable" ? "Too few completed assessments to compare." : dis.conflicts.length ? dis.conflicts.join(" ") : "No directional conflicts among completed assessments." });

  const applicable = sources.filter((s) => s.key !== "agents" && s.status !== "NOT_APPLICABLE");
  const count = (st: SourceStatus) => applicable.filter((s) => s.status === st).length;
  const market = sources[0]!;
  return {
    sources,
    dimensions: {
      completeness: { available: count("AVAILABLE"), partial: count("PARTIAL"), stale: count("STALE"), unavailable: count("UNAVAILABLE"), applicable: applicable.length, notApplicable: sources.filter((s) => s.status === "NOT_APPLICABLE").length },
      freshness: { status: market.status, marketAsOf: market.asOf, ageHours: (() => { const a = age(market.asOf, i.now); return a === null ? null : Math.max(0, Math.round(a / 3_600_000)); })() },
      disagreement: { level: dis.level, conflicts: dis.conflicts },
      modelUncertainty: { status: "NOT_ASSESSED" as const, note: "The model gives no calibrated uncertainty. Outlook labels (bullish, bearish, neutral) are not probabilities." },
      historicalPerformance: { status: "NO_EVIDENCE" as const, note: "There is no out-of-sample track record for this research setup. Paper observations, if you confirm one, are listed separately and are not proof of skill." },
    },
    method: DATA_QUALITY_METHOD,
  };
}
export type DataQuality = ReturnType<typeof dataQuality>;
