import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { MARKETS, marketOf } from "./markets";
import { TIMEFRAMES } from "./strategy";

const symbol = z.string().refine((s) => MARKETS.some((m) => m.symbol === s), "Unknown market");
const venue = z.object({
  connectionId: z.string().uuid().nullable(),
  paperExchange: z.enum(["binance", "bybit", "okx", "kucoin", "coinbase"]).default("binance"),
});

/** Demo-wallet price source: Yahoo Finance for forex & commodities, the chosen crypto exchange for crypto. */
const priceSource = (sym: string, paperExchange: string) => (marketOf(sym)?.category === "crypto" ? paperExchange : "yahoo");

async function account(userId: string, connectionId: string | null, paperExchange: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { loadAccount } = await import("./manual.server");
  return { db: supabaseAdmin, a: await loadAccount(supabaseAdmin, userId, connectionId, paperExchange) };
}

/** Loads the account for an order and checks the market can trade there. */
async function tradingAccount(userId: string, data: { symbol: string; amount: number; connectionId: string | null; paperExchange: string }) {
  const { db, a } = await account(userId, data.connectionId, priceSource(data.symbol, data.paperExchange));
  const m = marketOf(data.symbol)!, cat = m.category;
  if (cat !== "crypto" && a.connId && a.exchange !== "oanda") throw new Error("Forex and commodities trade through the demo wallet or an OANDA account");
  if (a.exchange === "oanda" && !m.oanda) throw new Error(`${data.symbol} is not available on OANDA — use the demo wallet`);
  if (cat === "crypto" && a.exchange === "oanda") throw new Error("Pick a crypto exchange account (or paper) for crypto");
  if (a.exchange === "oanda" && !Number.isInteger(data.amount)) throw new Error("OANDA trades whole units");
  return { db, a };
}

async function candlesFor(userId: string, connectionId: string | null, paperExchange: string, sym: string, tf: string) {
  const { a } = await account(userId, connectionId, priceSource(sym, paperExchange));
  const ad = await import("./exchange-adapters.server");
  return a.exchange === "oanda" ? ad.oandaCandles(a.creds!, a.testnet, sym, tf, 500) : ad.fetchCandles(a.exchange, sym, tf, a.testnet, 500);
}

export const getMarketCandles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => venue.extend({ symbol, timeframe: z.enum(TIMEFRAMES) }).parse(i))
  .handler(async ({ data, context }) => {
    try {
      return { candles: await candlesFor(context.userId, data.connectionId, data.paperExchange, data.symbol, data.timeframe), error: null };
    } catch (e) {
      return { candles: [], error: e instanceof Error ? e.message : "Market data unavailable" };
    }
  });

export const placeManualOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    venue.extend({
      symbol, side: z.enum(["buy", "sell"]), amount: z.number().positive().max(1e9),
      sl: z.number().positive().nullable(), tp: z.number().positive().nullable(),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { db, a } = await tradingAccount(context.userId, data);
    const { openManual } = await import("./manual.server");
    return openManual(db, context.userId, a, { symbol: data.symbol, side: data.side, amount: data.amount, sl: data.sl, tp: data.tp });
  });

export const closeManualPosition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { data: own } = await context.supabase.from("positions").select("id").eq("id", data.id).eq("is_open", true).is("bot_id", null).maybeSingle();
    if (!own) throw new Error("Open manual position not found");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: p } = await supabaseAdmin.from("positions").select("*").eq("id", data.id).single();
    const { closeManual } = await import("./manual.server");
    const r = await closeManual(supabaseAdmin, p, "manual");
    await context.supabase.from("audit_logs").insert({ user_id: context.userId, action: "trade.manual_close", entity_type: "position", entity_id: data.id, details: r });
    return r;
  });

// ---- Scalping (Elite): one-click trades whose stop/target/time limit are set on the server from the live price ----
export const placeScalp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    venue.extend({
      symbol, side: z.enum(["buy", "sell"]), amount: z.number().positive().max(1e9),
      tpPct: z.number().positive(), slPct: z.number().positive(), holdMin: z.number().int().positive().nullable(),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { requireElite } = await import("./plan.server");
    await requireElite(context.supabase, context.userId);
    const { db, a } = await tradingAccount(context.userId, data);
    const { openManual } = await import("./manual.server");
    return openManual(db, context.userId, a, {
      symbol: data.symbol, side: data.side, amount: data.amount, sl: null, tp: null,
      scalp: { tpPct: data.tpPct, slPct: data.slPct, holdMin: data.holdMin },
    });
  });

/** Checks the caller's open scalps right now (the engine also checks every minute). Returns the scalps that closed. */
export const checkScalps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Risk exits remain available to the owner even after their plan changes.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { manageManualPositions } = await import("./manual.server");
    return { closed: await manageManualPositions(supabaseAdmin, context.userId) };
  });

/** Closes all of the caller's open scalps at market. Allowed on any plan so positions can always be exited. */
export const closeAllScalps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: own } = await context.supabase.from("positions").select("id").eq("is_open", true).eq("is_scalp", true).is("bot_id", null);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { closeManual } = await import("./manual.server");
    let closed = 0, net = 0; const failed: string[] = [];
    for (const { id } of own ?? []) {
      const { data: p } = await supabaseAdmin.from("positions").select("*").eq("id", id).eq("is_open", true).maybeSingle();
      if (!p) continue;
      try { const r = await closeManual(supabaseAdmin, p, "manual"); closed++; net += r.pnl; }
      catch (e) { failed.push(`${p.trading_pair}: ${e instanceof Error ? e.message : "close failed"}`); }
    }
    await context.supabase.from("audit_logs").insert({ user_id: context.userId, action: "trade.scalp_close_all", entity_type: "position", details: { closed, net, failed } });
    return { closed, net, failed };
  });

const ideaSchema = z.object({
  bias: z.enum(["long", "short", "neutral"]),
  confidence: z.number().min(0).max(100),
  entry: z.number().nullable(),
  stop_loss: z.number().nullable(),
  take_profit: z.number().nullable(),
  rationale: z.string(),
});
export type TradeIdea = z.infer<typeof ideaSchema> & { price: number };

// AI trade idea from real candles + computed indicators (Pro plan). Never places orders itself — the user confirms.
export const aiTradeIdea = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => venue.extend({ symbol, timeframe: z.enum(TIMEFRAMES) }).parse(i))
  .handler(async ({ data, context }): Promise<TradeIdea> => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const cs = await candlesFor(context.userId, data.connectionId, data.paperExchange, data.symbol, data.timeframe);
    const { marketFacts } = await import("./market-facts");
    const facts = marketFacts(cs, data.symbol, data.timeframe);
    const last = facts.price;
    const { aiPrimeMessage, messageText } = await import("./ai-prime.server");
    const { AI_MODEL } = await import("./ai-provider");
    const reply = await aiPrimeMessage({
      model: AI_MODEL,
      max_tokens: 1500,
      system: "You are a disciplined technical analyst. Use ONLY the provided data. Reply with a single JSON object: {\"bias\":\"long|short|neutral\",\"confidence\":0-100,\"entry\":number|null,\"stop_loss\":number|null,\"take_profit\":number|null,\"rationale\":\"2-4 short sentences\"}. Stop loss must be on the correct side of entry; use ATR for distances; prefer neutral when signals conflict. No markdown.",
      messages: [{ role: "user", content: JSON.stringify(facts) }],
    });
    const text = messageText(reply);
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    const idea = ideaSchema.safeParse(json ? JSON.parse(json) : null);
    if (!idea.success) throw new Error("The AI returned an unreadable answer — try again");
    return { ...idea.data, price: last };
  });
