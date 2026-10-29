import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { EXCHANGES } from "./exchanges";

const credsSchema = z.object({
  apiKey: z.string().trim().min(8).max(256),
  apiSecret: z.string().trim().min(8).max(512),
  passphrase: z.string().trim().max(256).optional(),
});

const connectSchema = credsSchema.extend({
  exchange: z.string(),
  label: z.string().trim().min(1).max(60),
  accountType: z.enum(["spot", "futures"]),
  isTestnet: z.boolean(),
});

const PENDING_NOTE =
  "Credentials stored encrypted. Click Verify to test the keys and load balances.";

export const connectExchange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => connectSchema.parse(input))
  .handler(async ({ data, context }) => {
    const meta = EXCHANGES.find((e) => e.id === data.exchange);
    if (!meta || !meta.available || meta.kind !== "crypto") throw new Error("This exchange is not supported yet");
    if (meta.needsPassphrase && !data.passphrase) throw new Error(`${meta.name} requires an API passphrase`);
    const { encryptJson } = await import("./crypto.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: conn, error } = await supabaseAdmin
      .from("exchange_connections")
      .insert({
        user_id: context.userId,
        exchange: meta.id,
        label: data.label,
        account_type: data.accountType,
        is_testnet: data.isTestnet,
        status: "pending",
        api_key_hint: `••••${data.apiKey.slice(-4)}`,
        last_error: PENDING_NOTE,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const sealed = await encryptJson({ apiKey: data.apiKey, apiSecret: data.apiSecret, passphrase: data.passphrase });
    const { error: credErr } = await supabaseAdmin
      .from("connection_credentials")
      .insert({ connection_id: conn.id, user_id: context.userId, ...sealed });
    if (credErr) {
      await supabaseAdmin.from("exchange_connections").delete().eq("id", conn.id);
      throw new Error("Could not store credentials securely");
    }
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "exchange.connect", entity_type: "exchange_connection", entity_id: conn.id,
      details: { exchange: meta.id, testnet: data.isTestnet },
    });
    return { id: conn.id };
  });

export const updateExchangeCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => credsSchema.extend({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    // RLS-scoped read proves ownership before privileged write.
    const { data: own } = await context.supabase.from("exchange_connections").select("id").eq("id", data.id).maybeSingle();
    if (!own) throw new Error("Connection not found");
    const { encryptJson } = await import("./crypto.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const sealed = await encryptJson({ apiKey: data.apiKey, apiSecret: data.apiSecret, passphrase: data.passphrase });
    await supabaseAdmin.from("connection_credentials").upsert({ connection_id: data.id, user_id: context.userId, ...sealed });
    await supabaseAdmin.from("exchange_connections").update({
      status: "pending", api_key_hint: `••••${data.apiKey.slice(-4)}`, last_error: PENDING_NOTE,
    }).eq("id", data.id);
    await context.supabase.from("audit_logs").insert({ user_id: context.userId, action: "exchange.reconnect", entity_type: "exchange_connection", entity_id: data.id });
    return { ok: true };
  });

export const disconnectExchange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: own } = await context.supabase.from("exchange_connections").select("id").eq("id", data.id).maybeSingle();
    if (!own) throw new Error("Connection not found");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("connection_credentials").delete().eq("connection_id", data.id);
    await context.supabase.from("exchange_connections").update({ status: "disconnected", last_error: null }).eq("id", data.id);
    await context.supabase.from("audit_logs").insert({ user_id: context.userId, action: "exchange.disconnect", entity_type: "exchange_connection", entity_id: data.id });
    return { ok: true };
  });

// Signed read-only call to the exchange: proves the keys work and caches balances.
export const verifyExchange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: own } = await context.supabase.from("exchange_connections").select("id,exchange,is_testnet").eq("id", data.id).maybeSingle();
    if (!own) throw new Error("Connection not found");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { decryptJson } = await import("./crypto.server");
    const { fetchBalances } = await import("./exchange-adapters.server");
    const { data: sealed } = await supabaseAdmin.from("connection_credentials").select("ciphertext,iv").eq("connection_id", data.id).maybeSingle();
    if (!sealed) throw new Error("No stored keys — update keys first");
    try {
      const creds = await decryptJson<{ apiKey: string; apiSecret: string; passphrase?: string }>(sealed.ciphertext, sealed.iv);
      const balances = await fetchBalances(own.exchange, creds, own.is_testnet);
      const now = new Date().toISOString();
      await supabaseAdmin.from("exchange_connections").update({
        status: "connected", last_error: null, last_synced_at: now, permissions: { verified_at: now, balances: balances.slice(0, 50) } as unknown as never,
      }).eq("id", data.id);
      return { ok: true as const, assets: balances.length };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabaseAdmin.from("exchange_connections").update({ status: "error", last_error: msg.slice(0, 500) }).eq("id", data.id);
      return { ok: false as const, error: msg };
    }
  });
