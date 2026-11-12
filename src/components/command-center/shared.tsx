import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { listResearch } from "@/lib/research.functions";

export type ResearchRun = Awaited<ReturnType<typeof listResearch>>[number];
export type Metric = ResearchRun["ai_research_stage_metrics"][number];
export const outputsOf = (r: ResearchRun) => [...r.ai_agent_outputs, ...r.ai_research_reports, ...r.ai_research_decisions];

export const num = (n: number | null | undefined, d = 2) => n === null || n === undefined || !Number.isFinite(n) ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: d }).format(n);
export const tokens = (n: number | null | undefined) => n === null || n === undefined ? "Unknown" : new Intl.NumberFormat().format(n);
export const seconds = (ms: number | null | undefined) => ms === null || ms === undefined ? "—" : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
export const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : "—";

const TONE: Record<string, string> = {
  good: "border-gain/40 bg-gain/10 text-gain",
  bad: "border-loss/40 bg-loss/10 text-loss",
  warn: "border-warning/40 bg-warning/10 text-warning",
  info: "border-primary/40 bg-primary/10 text-primary",
  muted: "border-border bg-muted text-muted-foreground",
};
const STATUS_TONE: Record<string, keyof typeof TONE> = {
  completed: "good", complete: "good", AVAILABLE: "good", PREVIEW_ONLY: "info",
  partial: "warn", PARTIAL: "warn", STALE: "warn", CONFLICTING: "warn", budget_exceeded: "warn", unavailable: "warn", INSUFFICIENT_DATA: "warn",
  failed: "bad", UNAVAILABLE: "bad", REJECTED: "bad", cancelled: "muted", NOT_APPLICABLE: "muted", not_run: "muted", waiting: "muted",
  running: "info", queued: "info", NOT_EXECUTABLE: "bad",
};
export const statusLabel = (s: string) => s.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export function StatusPill({ status, label, className }: { status: string; label?: string; className?: string }) {
  return <span className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4", TONE[STATUS_TONE[status] ?? "muted"], className)}>{label ?? statusLabel(status)}</span>;
}
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return <div className="min-w-0 rounded-lg border bg-card p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate font-mono text-lg font-semibold">{value}</p>{hint && <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{hint}</p>}</div>;
}
export function Section({ title, icon: Icon, action, children }: { title: string; icon?: React.ComponentType<{ className?: string }>; action?: ReactNode; children: ReactNode }) {
  return <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-semibold">{Icon && <Icon className="h-4 w-4 text-primary" />}{title}</h2>{action}</div>{children}</section>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{children}</p>;
}
export function List({ items, className }: { items: string[]; className?: string }) {
  if (!items.length) return <p className={cn("text-xs text-muted-foreground", className)}>None reported.</p>;
  return <ul className={cn("list-disc space-y-1 pl-5 text-sm", className)}>{items.map((x, i) => <li key={i} className="break-words">{x}</li>)}</ul>;
}
export const ADVISORY = "Advisory research only. No trade has been authorized or executed.";
