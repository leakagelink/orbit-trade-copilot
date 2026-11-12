// Server reads for production Futures authorization. Any read failure (including a missing certification table) fails closed.
import { productionFuturesProblem, latestCertification, FUTURES_CERTIFICATION_REVISION, type FuturesCertification } from "./futures-authorization";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];
// futures_certifications is added by the pending Futures migration; generated types do not know it yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loose = (db: Admin) => db as unknown as { from: (t: string) => any };

export async function productionFuturesAuthorization(db: Admin, userId: string, connectionId: string, opts: { forOptIn?: boolean } = {}) {
  const [conn, settings, risk, certs] = await Promise.all([
    db.from("exchange_connections").select("id,user_id,exchange,status,is_testnet").eq("id", connectionId).eq("user_id", userId).maybeSingle(),
    db.from("futures_settings").select("live_enabled,connection_id").eq("user_id", userId).maybeSingle(),
    db.from("risk_settings").select("trading_halted").eq("user_id", userId).maybeSingle(),
    loose(db).from("futures_certifications").select("id,user_id,connection_id,environment,result,revision,created_at").eq("user_id", userId).eq("connection_id", connectionId).order("created_at", { ascending: false }).limit(20),
  ]);
  if (conn.error || settings.error || risk.error || certs.error) return { problem: "Futures authorization unavailable; production entries stay locked", certification: null as FuturesCertification | null };
  const rows = (certs.data ?? []) as FuturesCertification[];
  const problem = productionFuturesProblem({ userId, connection: conn.data, settings: settings.data, halted: risk.data ? risk.data.trading_halted : null, certifications: rows, forOptIn: opts.forOptIn });
  return { problem, certification: latestCertification(rows, userId, connectionId), requiredRevision: FUTURES_CERTIFICATION_REVISION };
}

export async function assertProductionFutures(db: Admin, userId: string, connectionId: string) {
  const { problem } = await productionFuturesAuthorization(db, userId, connectionId);
  if (problem) throw new Error(`Production Futures locked: ${problem}`);
}

/**
 * Turns production Live Futures OFF. Needs no certification, plan or exchange credentials, touches only `live_enabled`
 * (limits, bound account, legacy timestamp and Testnet connections stay as they are) and confirms the stored value.
 */
export async function disableLiveFutures(db: Admin, userId: string) {
  const before = await db.from("futures_settings").select("live_enabled,connection_id").eq("user_id", userId).maybeSingle();
  if (before.error) throw new Error("Futures settings unavailable");
  if (!before.data) return { liveEnabled: false, changed: false, audited: true };
  const upd = await db.from("futures_settings").update({ live_enabled: false, updated_at: new Date().toISOString() }).eq("user_id", userId);
  if (upd.error) throw new Error("Live Futures could not be disabled");
  const after = await db.from("futures_settings").select("live_enabled").eq("user_id", userId).maybeSingle();
  if (after.error || !after.data || after.data.live_enabled !== false) throw new Error("Live Futures OFF could not be confirmed; try again");
  const ev = await db.from("trading_safety_events").insert({ user_id: userId, action: "futures.live_disabled", details: { previous: before.data.live_enabled, connection_id: before.data.connection_id } });
  return { liveEnabled: false, changed: before.data.live_enabled, audited: !ev.error };
}
