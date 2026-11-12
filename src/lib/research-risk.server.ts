// Read-only research risk inputs. Reads the owner's risk settings, open positions and today's trades (SELECT only) and
// runs the authoritative account Risk Engine check from risk-limits.server.ts. It imports no order, exchange,
// credential, bot, Autopilot or Futures module (a test walks the import graph), so research can never reach execution.
import { riskPreview, type RiskPreview } from "./research-risk-preview";
import { accountRiskBlock } from "./risk-limits.server";
import { tradeNet } from "./trade-accounting";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

/** Read-only account inputs for the preview, then the existing Risk Engine check on the resulting cost. */
export async function computeRiskPreview(db: Admin, userId: string, snapshot: { close: number; asOf: string; candles: { t: number; o: number; h: number; l: number; c: number }[] } | null): Promise<{ preview: RiskPreview; riskEngineBlock: string | null; accountExposure: number | null }> {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const [risk, pos, trades] = await Promise.all([
    db.from("risk_settings").select("max_open_exposure,max_daily_loss,max_total_positions,trading_halted").eq("user_id", userId).maybeSingle(),
    db.from("positions").select("entry_price,quantity,unrealized_pnl").eq("user_id", userId).eq("is_open", true),
    db.from("trades").select("realized_pnl,fees,funding_pnl,costs_verified").eq("user_id", userId).gte("closed_at", start.toISOString()),
  ]);
  const limits = risk.error || !risk.data ? null : { maxOpenExposure: risk.data.max_open_exposure === null ? null : Number(risk.data.max_open_exposure), maxDailyLoss: risk.data.max_daily_loss === null ? null : Number(risk.data.max_daily_loss), maxTotalPositions: risk.data.max_total_positions, halted: risk.data.trading_halted };
  const account = pos.error || trades.error || !pos.data || !trades.data ? null : {
    openExposure: pos.data.reduce((a, p) => a + Number(p.entry_price) * Number(p.quantity), 0),
    openPositions: pos.data.length,
    dailyNet: trades.data.reduce((a, t) => a + tradeNet(t), 0) + pos.data.reduce((a, p) => a + Math.min(0, Number(p.unrealized_pnl)), 0),
  };
  const preview = riskPreview({ referencePrice: snapshot?.close ?? null, asOf: snapshot?.asOf ?? null, candles: snapshot?.candles ?? [], limits, account });
  let riskEngineBlock: string | null = null;
  if (preview.status === "estimate" && preview.positionValue !== null && preview.positionValue > 0) {
    riskEngineBlock = await accountRiskBlock(db, userId, preview.positionValue);
  }
  return { preview, riskEngineBlock, accountExposure: account?.openExposure ?? null };
}
