// AI Autopilot chat: Claude (owner's AI Prime Tech connection) operating paper tools, plus live tools when the owner enabled real money. Bearer-verified, Pro-gated.
import { AI_NOT_CONNECTED, aiStreamErrorMessage } from "./ai-provider";
import { convertToModelMessages, isStepCount, streamText, type UIMessage } from "ai";
import type { Json } from "@/integrations/supabase/types";
import { AUTOPILOT_MAX_STEPS, AUTOPILOT_MODEL, AUTOPILOT_SYSTEM, createRunBudget, liveRules } from "./autopilot-guard";

export async function handleAutopilot(request: Request) {
  const { verifyAiRequest } = await import("./ai-auth.server");
  const caller = await verifyAiRequest(request, "AI Autopilot needs a Pro plan");
  if (caller instanceof Response) return caller;
  const { supabase, userId } = caller;

  const { aiPrimeProvider, aiPrimeReady } = await import("./ai-prime.server");
  if (!aiPrimeReady()) return new Response(AI_NOT_CONNECTED, { status: 503 });

  const body = (await request.json()) as { messages?: UIMessage[]; sessionId?: string };
  const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  if (!messages.length || !body.sessionId) return new Response("Bad request", { status: 400 });
  const { data: session } = await supabase.from("ai_sessions").select("id,title,kind").eq("id", body.sessionId).eq("user_id", userId).maybeSingle();
  if (!session || session.kind !== "autopilot") return new Response("Conversation not found", { status: 404 });

  const { autopilotTools } = await import("./autopilot-tools.server");
  const { loadLiveAccounts } = await import("./autopilot-settings.server");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const live = await loadLiveAccounts(supabaseAdmin, userId);
  const anthropic = await aiPrimeProvider();
  const result = streamText({
    model: anthropic(AUTOPILOT_MODEL),
    system: AUTOPILOT_SYSTEM + (live ? liveRules(live) : ""),
    messages: await convertToModelMessages(messages),
    tools: autopilotTools({ supabase, userId, budget: createRunBudget(), live }),
    stopWhen: isStepCount(AUTOPILOT_MAX_STEPS),
    maxOutputTokens: 8000,
    maxRetries: 0,
    abortSignal: request.signal,
  });

  const firstUser = messages.find((m) => m.role === "user");
  const firstText = firstUser?.parts.find((p) => p.type === "text") as { text?: string } | undefined;
  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: async ({ messages: all }) => {
      const title = session.title === "New conversation" && firstText?.text ? firstText.text.slice(0, 60) : session.title;
      const { error } = await supabase.from("ai_sessions").update({ messages: all as unknown as Json, title }).eq("id", session.id);
      if (error) console.error("Failed to save autopilot conversation", error.message);
    },
    onError: (e) => aiStreamErrorMessage(e instanceof Error ? e.message : "Autopilot request failed"),
  });
}
