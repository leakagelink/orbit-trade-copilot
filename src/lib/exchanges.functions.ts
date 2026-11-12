import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { EXCHANGES } from "./exchanges";
import { derivAppId, DERIV_DISCONNECT_FIRST } from "./deriv";
import { accountTypeSchema, supportsBothAccounts, validateAccountSelection } from "./exchange-account-types";
import { bindCredentials, envLabel, futuresEnvironment, withEnv } from "./binance-futures-env";

const credsSchema = z.object({
  apiKey: z.string().trim().min(8).max(256),
  apiSecret: z.string().trim().min(1).max(512),
  passphrase: z.string().trim().max(256).optional(),
});

const connectSchema = credsSchema.extend({
  exchange: z.string(),
  label: z.string().trim().min(1).max(60),
  accountType: accountTypeSchema,
  isTestnet: z.boolean(),
});

const PENDING_NOTE =
  "Credentials stored encrypted. Click Verify to test the keys and load balances.";

export const connectExchange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => connectSchema.parse(input))
  .handler(async ({ data, context }) => {
    const meta = EXCHANGES.find((e) => e.id === data.exchange);
    if (!meta || !meta.available) throw new Error("This exchange is not supported yet");
    validateAccountSelection(meta.id, data.accountType);
    if (meta.id === "deriv") derivAppId.parse(data.apiSecret);
    else if (data.apiSecret.length < 8) throw new Error("API secret must have at least 8 characters");
    if (meta.needsPassphrase && !data.passphrase) throw new Error(`${meta.name} requires an API passphrase`);
    const { encryptJson } = await import("./crypto.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const environment = futuresEnvironment(data.isTestnet);
    if (meta.id === "binance") {
      // Before anything is stored: refuse keys known from the other environment, and prove Testnet keys on Testnet only.
      const { assertKeyNotFromOtherEnvironment, verifyBinanceTestnetCredentials } = await import("./testnet-credentials.server");
      await assertKeyNotFromOtherEnvironment(supabaseAdmin, context.userId, meta.id, data.isTestnet, data.apiKey);
      if (data.isTestnet) await verifyBinanceTestnetCredentials(data.accountType, { apiKey: data.apiKey, apiSecret: data.apiSecret, ...(data.passphrase ? { passphrase: data.passphrase } : {}) });
    }
    const { data: conn, error } = await supabaseAdmin
      .from("exchange_connections")
      .insert({
        user_id: context.userId,
        exchange: meta.id,
        label: data.label,
        account_type: meta.id === "deriv" ? "options" : data.accountType,
        is_testnet: data.isTestnet,
        status: "pending",
        api_key_hint: meta.id === "deriv" ? null : `••••${data.apiKey.slice(-4)}`,
        last_error: PENDING_NOTE,
      })
      .select("id")
      .single();
    if (error) throw new Error(meta.id === "deriv" && error.code === "23505" ? DERIV_DISCONNECT_FIRST : error.message);
    const sealed = await encryptJson({ apiKey: data.apiKey, apiSecret: data.apiSecret, passphrase: data.passphrase, environment });
    const { error: credErr } = await supabaseAdmin
      .from("connection_credentials")
      .insert({ connection_id: conn.id, user_id: context.userId, ...sealed });
    if (credErr) {
      await supabaseAdmin.from("exchange_connections").delete().eq("id", conn.id);
      throw new Error("Could not store credentials securely");
    }
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "exchange.connect", entity_type: "exchange_connection", entity_id: conn.id,
      details: { exchange: meta.id, testnet: data.isTestnet, environment: envLabel(data.isTestnet) },
    });
    return { id: conn.id };
  });

export const updateExchangeCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => credsSchema.extend({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    // RLS-scoped read proves ownership before privileged write.
    const { data: own } = await context.supabase.from("exchange_connections").select("id,exchange,is_testnet,account_type").eq("id", data.id).maybeSingle();
    if (!own) throw new Error("Connection not found");
    if (own.exchange === "deriv") throw new Error(DERIV_DISCONNECT_FIRST);
    else if (data.apiSecret.length < 8) throw new Error("API secret must have at least 8 characters");
    const { encryptJson } = await import("./crypto.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (own.exchange === "binance") {
      // Verification happens before the upsert, so a failed Testnet key leaves the stored key untouched.
      const { assertKeyNotFromOtherEnvironment, verifyBinanceTestnetCredentials } = await import("./testnet-credentials.server");
      await assertKeyNotFromOtherEnvironment(supabaseAdmin, context.userId, own.exchange, own.is_testnet, data.apiKey, own.id);
      if (own.is_testnet) await verifyBinanceTestnetCredentials(own.account_type as "spot" | "futures" | "both", { apiKey: data.apiKey, apiSecret: data.apiSecret, ...(data.passphrase ? { passphrase: data.passphrase } : {}) });
    }
    const sealed = await encryptJson({ apiKey: data.apiKey, apiSecret: data.apiSecret, passphrase: data.passphrase, environment: futuresEnvironment(own.is_testnet) });
    await supabaseAdmin.from("connection_credentials").upsert({ connection_id: data.id, user_id: context.userId, ...sealed });
    await supabaseAdmin.from("exchange_connections").update({
      status: "pending", api_key_hint: own.exchange === "deriv" ? null : `••••${data.apiKey.slice(-4)}`, last_error: PENDING_NOTE,
    }).eq("id", data.id);
    await context.supabase.from("audit_logs").insert({ user_id: context.userId, action: "exchange.reconnect", entity_type: "exchange_connection", entity_id: data.id, details: { exchange: own.exchange, environment: envLabel(own.is_testnet) } });
    return { ok: true };
  });

export const updateExchangeAccountType = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid(), accountType: accountTypeSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const own = await context.supabase.from("exchange_connections").select("id,exchange,status").eq("id", data.id).eq("user_id", context.userId).maybeSingle();
    if (own.error || !own.data) throw new Error("Connection not found");
    if (!supportsBothAccounts(own.data.exchange) || own.data.status === "disconnected") throw new Error("Account selection cannot be changed for this connection");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const result = await supabaseAdmin.from("exchange_connections").update({ account_type: validateAccountSelection(own.data.exchange, data.accountType) }).eq("id", data.id).eq("user_id", context.userId).neq("status", "disconnected").select("id").maybeSingle();
    if (result.error || !result.data) throw new Error("Account selection could not be saved");
    return { ok: true };
  });

export const disconnectExchange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: own } = await context.supabase.from("exchange_connections").select("id,exchange,is_testnet").eq("id", data.id).maybeSingle();
    if (!own) throw new Error("Connection not found");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const removed = await supabaseAdmin.from("connection_credentials").delete().eq("connection_id", data.id).eq("user_id", context.userId);
    if (removed.error) throw new Error("Could not delete stored credentials; try disconnecting again");
    const changed = await supabaseAdmin.from("exchange_connections").update({ status: "disconnected", last_error: null, permissions: {} }).eq("id", data.id).eq("user_id", context.userId);
    if (changed.error) throw new Error("Could not finish disconnecting; try again");
    await context.supabase.from("audit_logs").insert({ user_id: context.userId, action: "exchange.disconnect", entity_type: "exchange_connection", entity_id: data.id, details: { exchange: own.exchange, environment: envLabel(own.is_testnet) } });
    return { ok: true };
  });

// Signed read-only call to the exchange: proves the keys work and caches balances.
export const verifyExchange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: own } = await context.supabase.from("exchange_connections").select("id,exchange,is_testnet,status,account_type").eq("id", data.id).maybeSingle();
    if (!own) throw new Error("Connection not found");
    if (own.status === "disconnected") throw new Error("This account is disconnected");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { openCredentials } = await import("./credential-environment.server");
    const { fetchBalances } = await import("./exchange-adapters.server");
    const environment = futuresEnvironment(own.is_testnet);
    const { data: sealed } = await supabaseAdmin.from("connection_credentials").select("ciphertext,iv").eq("connection_id", data.id).eq("user_id",context.userId).maybeSingle();
    if (!sealed) throw new Error("No stored keys — update keys first");
    try {
      const creds = await openCredentials(sealed, own.is_testnet);
      // Futures-only Binance keys (e.g. Futures testnet) cannot read Spot; verify on the Futures API instead.
      const balances = own.exchange === "binance" && own.account_type === "futures"
        ? await (async () => { const { futuresAccountState } = await import("./binance-futures.server"); const s = await futuresAccountState({ connectionId: own.id, testnet: own.is_testnet, creds: bindCredentials(creds, environment) }); if (!s.canTrade) throw new Error("Futures trading permission is unavailable on this API key"); return [{ asset: "USDT", free: Number(s.availableBalance), locked: 0 }]; })()
        : await (async () => {
          const spot = await fetchBalances(own.exchange, creds, own.is_testnet);
          if (own.exchange !== "binance" || own.account_type !== "both") return spot;
          // Spot + Futures: also show the Futures wallet so moved funds stay visible.
          try { const { futuresAccountState } = await import("./binance-futures.server"); const s = await futuresAccountState({ connectionId: own.id, testnet: own.is_testnet, creds: bindCredentials(creds, environment) }); return [{ asset: "USDT (Futures)", free: Number(s.availableBalance), locked: 0 }, ...spot]; } catch { return spot; }
        })();
      const now = new Date().toISOString();
      const saved = await supabaseAdmin.from("exchange_connections").update({
        status: "connected", last_error: null, last_synced_at: now, permissions: { verified_at: now, balances: balances.slice(0, 50) } as unknown as never,
      }).eq("id", data.id).eq("user_id", context.userId).neq("status", "disconnected").select("id").maybeSingle();
      if (saved.error || !saved.data) throw new Error("Connection changed during verification; refresh and try again");
      await context.supabase.from("audit_logs").insert({ user_id: context.userId, action: "exchange.verify", entity_type: "exchange_connection", entity_id: data.id, details: { exchange: own.exchange, environment: envLabel(own.is_testnet), ok: true } });
      return { ok: true as const, assets: balances.length };
    } catch (e) {
      const msg = withEnv(own.is_testnet, e instanceof Error ? e.message : String(e));
      await supabaseAdmin.from("exchange_connections").update({ status: "error", last_error: msg.slice(0, 500) }).eq("id", data.id).eq("user_id", context.userId).neq("status", "disconnected");
      return { ok: false as const, error: msg };
    }
  });
