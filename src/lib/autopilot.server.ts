// AI Autopilot chat: Claude (owner's own Anthropic key) operating paper tools, plus live tools when the owner enabled real money. Bearer-verified, Pro-gated.
import { createAnthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, isStepCount, streamText, type UIMessage } from "ai";
import type { Json } from "@/integrations/supabase/types";
import { AUTOPILOT_MAX_STEPS, AUTOPILOT_MODEL, AUTOPILOT_SYSTEM, createRunBudget, liveRules } from "./autopilot-guard";

export async function handleAutopilot(request: Request) {
  const { verifyAiRequest } = await import("./ai-auth.server");
  const caller = await verifyAiRequest(request, "AI Autopilot needs a Pro plan");
  if (caller instanceof Response) return caller;
  const { supabase, userId } = caller;

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return new Response("Claude API key not added yet", { status: 503 });

  const body = (await request.json()) as { messages?: UIMessage[]; sessionId?: string };
  const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  if (!messages.length || !body.sessionId) return new Response("Bad request", { status: 400 });
  const { data: session } = await supabase.from("ai_sessions").select("id,title,kind").eq("id", body.sessionId).eq("user_id", userId).maybeSingle();
  if (!session || session.kind !== "autopilot") return new Response("Conversation not found", { status: 404 });

  const { autopilotTools } = await import("./autopilot-tools.server");
  const { loadLiveAccounts } = await import("./autopilot-settings.server");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const live = await loadLiveAccounts(supabaseAdmin, userId);
  const anthropic = createAnthropic({ apiKey });
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
    onError: (e) => {
      const msg = e instanceof Error ? e.message : "Autopilot request failed";
      if (/401|invalid x-api-key|authentication/i.test(msg)) return "Claude rejected the API key — add a valid Anthropic key.";
      if (/credit|billing|402/i.test(msg)) return "Your Anthropic account has no credit — add billing in your Anthropic console.";
      if (/429|rate/i.test(msg)) return "Claude is rate-limiting requests — try again in a minute.";
      return msg;
    },
  });
}
