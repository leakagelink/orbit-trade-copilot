// Forward-only outcomes of stored Research AI proposals. No AI calls; always labelled possibly contaminated.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { listResearchOutcomes } from "@/lib/historical-evaluation.functions";

const LABEL: Record<string, string> = { closed: "Closed", open: "Open", waiting: "Waiting for next bar", no_scenario: "No trade / insufficient evidence", excluded: "Excluded (evidence after decision)", invalid: "Invalid record", price_unavailable: "Prices unavailable" };

export function ResearchOutcomesPanel() {
  const fetchOutcomes = useServerFn(listResearchOutcomes);
  const q = useQuery({ queryKey: ["research-outcomes"], queryFn: () => fetchOutcomes() });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.error) return <p className="rounded-lg border bg-card p-4 text-sm text-loss">{q.error instanceof Error ? q.error.message : "Research outcomes unavailable"}</p>;
  const d = q.data!;
  return (
    <section className="space-y-3" aria-label="Stored research decisions">
      <div className="flex gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /><p>{d.notice}</p></div>
      <p className="text-xs text-muted-foreground">{d.summary.stored} stored decisions · {d.summary.directional} with a direction · {d.summary.closed} closed · {d.summary.open} open. {d.summary.note} Only daily bars opening after each decision are used ({d.source}; fee {d.costs.feePct}% and slippage {d.costs.slippagePct}% per side). No AI calls are made.</p>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground">{["Decided", "Symbol", "Direction", "Outcome", "Entry", "Exit", "Net %", "Note"].map((h) => <th key={h} className="px-3 py-2 font-normal">{h}</th>)}</tr></thead>
          <tbody>{d.outcomes.map((o) => {
            const r = o as typeof o & { entry?: number | null; exit?: number | null; netPct?: number | null; reason?: string };
            return (
              <tr key={o.proposalId} className="border-t text-xs">
                <td className="px-3 py-2 font-mono">{new Date(o.decidedAt).toLocaleString()}</td><td className="px-3 py-2 font-mono">{o.symbol}</td><td className="px-3 py-2">{o.direction ?? "—"}</td>
                <td className="px-3 py-2">{LABEL[o.status] ?? o.status}{r.reason && o.status !== "waiting" ? ` · ${r.reason.replaceAll("_", " ")}` : ""}</td>
                <td className="px-3 py-2 font-mono">{r.entry?.toFixed(4) ?? "—"}</td><td className="px-3 py-2 font-mono">{r.exit?.toFixed(4) ?? "—"}</td>
                <td className={`px-3 py-2 font-mono ${(r.netPct ?? 0) > 0 ? "text-gain" : (r.netPct ?? 0) < 0 ? "text-loss" : ""}`}>{r.netPct == null ? "—" : `${r.netPct.toFixed(2)}%`}</td>
                <td className="px-3 py-2 text-muted-foreground">{o.note ?? ""}</td>
              </tr>);
          })}</tbody>
        </table>
        {!d.outcomes.length && <p className="p-4 text-sm text-muted-foreground">No stored research decisions yet.</p>}
      </div>
    </section>
  );
}
