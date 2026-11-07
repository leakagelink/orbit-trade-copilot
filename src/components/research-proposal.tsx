import { ShieldCheck } from "lucide-react";
import { researchProposal } from "@/lib/research-proposal";

export function ResearchProposalView({ proposal }: { proposal: unknown }) {
  const parsed = researchProposal.safeParse(proposal);
  if (!parsed.success) return null;
  const p = parsed.data;
  const number = (n: number | null) => n === null ? "Unavailable" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(n);
  return <section className="space-y-4 border-y py-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-5 w-5 text-primary" />Trade proposal</h3><span className="text-xs font-medium text-muted-foreground">{p.status === "withheld" ? "Withheld" : `${p.direction.toUpperCase()} · Historical scenario`}</span></div>
    {p.status === "scenario" && <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">{[["Reference entry",p.hypotheticalEntry],["Stop level",p.stopLoss],["Target level",p.takeProfit],["Reward / risk",p.rewardRisk]].map(([label,value]) => <div key={String(label)}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words font-mono text-sm font-semibold">{number(typeof value === "number" ? value : null)}</dd></div>)}</dl>}
    <p className="text-xs text-muted-foreground">Historical close: {number(p.referenceClose)} · {p.asOf ? new Date(p.asOf).toLocaleDateString() : "Date unavailable"} · Native instrument quote currency</p>
    {p.reasons.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm">{p.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground"><span>Position size: unavailable</span><span>Calibrated confidence: unavailable</span><span>Execution: disabled</span></div>
    <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">{p.limitations.map(l => <li key={l}>{l}</li>)}</ul>
  </section>;
}