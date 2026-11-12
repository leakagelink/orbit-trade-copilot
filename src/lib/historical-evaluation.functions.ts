import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { researchOutcome, summarizeOutcomes, CONTAMINATION_NOTICE, OUTCOME_COSTS } from "./research-outcomes";

/** Forward outcomes of the owner's stored research proposals. Reads public daily prices only; zero AI calls, no orders. */
export const listResearchOutcomes = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { requirePro } = await import("./plan.server");
  await requirePro(context.supabase, context.userId);
  const rows = await context.supabase.from("ai_trade_proposals").select("id,run_id,created_at,proposal,ai_research_runs(symbol)").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(50);
  if (rows.error) throw new Error("Stored research proposals are unavailable");
  const decisions = rows.data.flatMap((r) => r.ai_research_runs ? [{ proposalId: r.id, runId: r.run_id, symbol: r.ai_research_runs.symbol, decidedAt: Date.parse(r.created_at), proposal: r.proposal }] : []);
  const directional = new Set(decisions.filter((d) => (d.proposal as { status?: string } | null)?.status === "scenario").map((d) => d.symbol));
  const { yahooChart } = await import("./yahoo-chart.server");
  const candles = new Map<string, Awaited<ReturnType<typeof yahooChart>>>();
  const priceErrors: string[] = [];
  for (const symbol of directional) {
    try { candles.set(symbol, await yahooChart(symbol, "1d", 2000)); } catch { priceErrors.push(symbol); }
  }
  const now = Date.now();
  const outcomes = decisions.map((d) => {
    if (directional.has(d.symbol) && !candles.has(d.symbol)) return { proposalId: d.proposalId, runId: d.runId, symbol: d.symbol, decidedAt: d.decidedAt, status: "price_unavailable" as const, direction: null, note: "Daily prices could not be loaded; no outcome was estimated" };
    return researchOutcome(d, candles.get(d.symbol) ?? [], now);
  });
  return { outcomes, summary: summarizeOutcomes(outcomes as never), notice: CONTAMINATION_NOTICE, costs: OUTCOME_COSTS, priceErrors, source: "Yahoo Finance daily candles" };
});
