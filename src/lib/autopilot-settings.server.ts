// Real-money Autopilot accounts: re-verified on every use (owner, exchange, still connected) — a stale setting never trades.
import type { LiveAccounts } from "./autopilot-guard";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

export async function loadLiveAccounts(db: Admin, userId: string): Promise<LiveAccounts | null> {
  const { data: s } = await db.from("autopilot_settings").select("live_enabled,binance_connection_id,deriv_connection_id").eq("user_id", userId).maybeSingle();
  if (!s?.live_enabled) return null;
  const ids = [s.binance_connection_id, s.deriv_connection_id].filter((x): x is string => !!x);
  if (!ids.length) return null;
  const { data: conns } = await db.from("exchange_connections").select("id,user_id,exchange,label,status,is_testnet").in("id", ids);
  const pick = (id: string | null, exchange: string) => {
    const c = (conns ?? []).find((x) => x.id === id && x.user_id === userId && x.exchange === exchange && x.status === "connected");
    return c ? { id: c.id, label: c.label, testnet: c.is_testnet } : null;
  };
  const acc = { binance: pick(s.binance_connection_id, "binance"), deriv: pick(s.deriv_connection_id, "deriv") };
  return acc.binance || acc.deriv ? acc : null;
}
