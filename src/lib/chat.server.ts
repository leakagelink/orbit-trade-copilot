import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { createLovableAiGatewayRunIdFetch, getLovableAiGatewayRunId, withLovableAiGatewayRunIdHeader } from "./run-id.server";

const MODEL = "openai/gpt-6-astra";
const SYSTEM = `You are Quantra's AI trading assistant for an algorithmic crypto trading platform.
- Help users analyze markets, design strategies (RSI, MACD, EMA, SMA, Bollinger Bands, ATR, Stochastic RSI, volume), and set risk parameters.
- You do NOT have live market data in this phase. Never invent current prices, volumes, or indicator readings; say so and explain how to analyze instead.
- When proposing a strategy, include a JSON code block matching: {"pairs":["BTC/USDT"],"timeframe":"1h","indicators":[{"id":"rsi_1","type":"RSI","params":{"period":14}}],"entry":{"logic":"all","conditions":[{"left":"rsi_1","operator":"<","right":"30"}]},"exit":{"logic":"any","conditions":[{"left":"rsi_1","operator":">","right":"70"}]},"risk":{"stop_loss_pct":2,"take_profit_pct":4,"trailing_stop_pct":null,"position_size_pct":10,"capital_allocation":1000,"max_open_positions":1,"daily_loss_limit_pct":5}}
- Always include a stop loss. Never promise returns. You cannot place orders; all execution goes through validation and risk management.
- Be concise and structured.`;

function userClient(token: string) {
  const url = process.env["SUPABASE_URL"]!;
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    global: {
      headers: { Authorization: `Bearer ${token}` },
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

export async function handleChat(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return new Response("Unauthorized", { status: 401 });
  const supabase = userClient(token);
  const { data: claims, error: authErr } = await supabase.auth.getClaims(token);
  if (authErr || !claims?.claims?.sub) return new Response("Unauthorized", { status: 401 });

  const body = (await request.json()) as { messages?: UIMessage[]; sessionId?: string };
  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
  if (!messages.length || !body.sessionId) return new Response("Bad request", { status: 400 });
  const { data: session } = await supabase.from("ai_sessions").select("id,title").eq("id", body.sessionId).maybeSingle();
  if (!session) return new Response("Conversation not found", { status: 404 });

  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return new Response("AI is not configured", { status: 500 });

  const runIdFetch = createLovableAiGatewayRunIdFetch(getLovableAiGatewayRunId(request));
  const provider = createOpenAI({
    baseURL: "https://ai.gateway.lovable.dev/v1",
    apiKey,
    headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    fetch: runIdFetch.fetch,
  });
  const result = streamText({
    model: provider.responses(MODEL),
    instructions: SYSTEM,
    messages: await convertToModelMessages(messages),
    abortSignal: request.signal,
    providerOptions: {
      openai: {
        forceReasoning: true,
        reasoningEffort: "low",
        reasoningSummary: "auto",
        store: false,
        include: ["reasoning.encrypted_content"],
      },
    },
  });

  const firstUser = messages.find((m) => m.role === "user");
  const firstText = firstUser?.parts.find((p) => p.type === "text") as { text?: string } | undefined;
  return withLovableAiGatewayRunIdHeader(
    result.toUIMessageStreamResponse({
      originalMessages: messages,
      sendReasoning: true,
      onFinish: async ({ messages: all }) => {
        const title = session.title === "New conversation" && firstText?.text ? firstText.text.slice(0, 60) : session.title;
        const { error } = await supabase
          .from("ai_sessions")
          .update({ messages: all as unknown as Json, title })
          .eq("id", session.id);
        if (error) console.error("Failed to save conversation", error.message);
      },
      onError: (e) => (e instanceof Error ? e.message : "AI request failed"),
    }),
    runIdFetch,
  );
}
