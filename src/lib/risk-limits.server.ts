// Authoritative account-wide Risk Engine check (risk_settings, open exposure, daily loss, emergency stop).
// SELECT-only and free of order, exchange or credential imports, so read-only callers (AI research) can use the exact
// same rules as trading without being able to reach execution code. Trading entries import it via engine.server.ts.
import { tradeNet, type ExecutionEnvironment } from "./trade-accounting";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

/** Account-wide limits from risk_settings. Returns a reason when a new entry must be blocked. */
export async function accountRiskBlock(db: Admin, userId: string, newCost: number, environment?: ExecutionEnvironment): Promise<string | null> {
  if (!Number.isFinite(newCost) || newCost <= 0) return "invalid entry cost";
  const { data: r, error: riskError } = await db.from("risk_settings").select("*").eq("user_id", userId).maybeSingle();
  if (riskError || !r) return "account risk settings unavailable; save risk settings first";
  if (r.trading_halted) return "trading halted (emergency stop)";
  let positionsQuery = db.from("positions").select("entry_price,quantity,unrealized_pnl").eq("user_id", userId).eq("is_open", true);
  if(environment) positionsQuery=positionsQuery.eq("execution_environment",environment);
  const { data: pos, error: positionError } = await positionsQuery;
  if (positionError || !pos) return "account exposure unavailable";
  if (r.max_total_positions != null && (pos?.length ?? 0) >= r.max_total_positions) return "account max open positions reached";
  const exposure = (pos ?? []).reduce((a, p) => a + Number(p.entry_price) * Number(p.quantity), 0);
  if (r.max_open_exposure != null && exposure + newCost > Number(r.max_open_exposure)) return "account max exposure reached";
  if (r.max_daily_loss != null) {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    let tradesQuery = db.from("trades").select("realized_pnl,fees,funding_pnl,costs_verified").eq("user_id", userId).gte("closed_at", start.toISOString());
    if(environment) tradesQuery=tradesQuery.eq("execution_environment",environment);
    const { data: t, error: tradeError } = await tradesQuery;
    if (tradeError || !t) return "account loss evidence unavailable";
    const pnl = t.reduce((a, x) => a + tradeNet(x), 0) + pos.reduce((a,p) => a + Math.min(0,Number(p.unrealized_pnl)),0);
    if (!Number.isFinite(pnl)) return "account loss evidence unavailable";
    if (pnl <= -Number(r.max_daily_loss)) return "account daily loss limit reached";
  }
  return null;
}
