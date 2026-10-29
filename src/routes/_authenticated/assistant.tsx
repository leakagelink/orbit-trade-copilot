import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { Activity, Plus, Trash2, Save } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { validateStrategy, type StrategyConfig } from "@/lib/strategy";
import { createStrategy } from "@/lib/strategies.api";
import { cn } from "@/lib/utils";

const D = "Chat with the AI about strategies, indicators and risk parameters.";
export const Route = createFileRoute("/_authenticated/assistant")({
  validateSearch: z.object({ session: z.string().uuid().optional(), prompt: z.string().max(1000).optional() }),
  head: () => ({ meta: [{ title: "AI Assistant — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "AI Assistant — Quantra" }, { property: "og:description", content: D }] }),
  component: Assistant,
});

const SUGGESTIONS = ["Generate an RSI mean-reversion strategy for BTC/USDT", "Create an EMA crossover strategy on 4h", "Design a DCA strategy for ETH/USDT", "Suggest stop-loss and take-profit levels for a swing strategy"];

function Assistant() {
  const { session } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const sessions = useQuery({
    queryKey: ["ai_sessions"],
    queryFn: async () => {
      const { data, error } = await supabase.from("ai_sessions").select("id,title,updated_at").order("updated_at", { ascending: false }).limit(50);
      if (error) throw new Error(error.message);
      return data;
    },
  });

  async function newSession() {
    const { data: u } = await supabase.auth.getUser();
    const { data, error } = await supabase.from("ai_sessions").insert({ user_id: u.user!.id }).select("id").single();
    if (error) return void toast.error(error.message);
    await qc.invalidateQueries({ queryKey: ["ai_sessions"] });
    navigate({ to: "/assistant", search: { session: data.id } });
  }

  useEffect(() => {
    if (session || !sessions.data) return;
    if (sessions.data[0]) navigate({ to: "/assistant", search: { session: sessions.data[0].id }, replace: true });
    else void newSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessions.data]);

  async function remove(id: string) {
    await supabase.from("ai_sessions").delete().eq("id", id);
    await qc.invalidateQueries({ queryKey: ["ai_sessions"] });
    if (id === session) navigate({ to: "/assistant", search: {} });
  }

  return (
    <div className="flex h-[calc(100vh-49px)] md:h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r lg:flex">
        <div className="p-3"><Button variant="outline" className="w-full" onClick={newSession}><Plus className="mr-1 h-4 w-4" />New chat</Button></div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {sessions.data?.map((s) => (
            <div key={s.id} className={cn("group flex items-center rounded-md text-sm", s.id === session ? "bg-accent text-accent-foreground" : "hover:bg-muted")}>
              <button className="flex-1 truncate px-3 py-2 text-left" onClick={() => navigate({ to: "/assistant", search: { session: s.id } })}>{s.title}</button>
              <button aria-label="Delete chat" className="mr-1 hidden p-1 text-muted-foreground hover:text-destructive group-hover:block" onClick={() => remove(s.id)}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {session ? <ChatWindow key={session} sessionId={session} onSaved={() => qc.invalidateQueries({ queryKey: ["ai_sessions"] })} /> : <div className="p-6"><Skeleton className="h-40" /></div>}
      </div>
    </div>
  );
}

function ChatWindow({ sessionId, onSaved }: { sessionId: string; onSaved: () => void }) {
  const q = useQuery({
    queryKey: ["ai_session", sessionId],
    queryFn: async () => {
      const { data, error } = await supabase.from("ai_sessions").select("messages").eq("id", sessionId).single();
      if (error) throw new Error(error.message);
      return (data.messages as unknown as UIMessage[]) ?? [];
    },
    staleTime: Infinity,
  });
  if (q.isError) return <div className="p-6 text-sm text-destructive">{q.error.message}</div>;
  if (!q.data) return <div className="p-6"><Skeleton className="h-40" /></div>;
  return <Chat sessionId={sessionId} initial={q.data} onSaved={onSaved} />;
}

function extractStrategy(text: string): StrategyConfig | null {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of blocks.reverse()) {
    try {
      const obj = JSON.parse(b ?? "");
      if (obj && Array.isArray(obj.pairs) && obj.entry && obj.risk) return obj as StrategyConfig;
    } catch { /* not JSON */ }
  }
  return null;
}

function Chat({ sessionId, initial, onSaved }: { sessionId: string; initial: UIMessage[]; onSaved: () => void }) {
  const navigate = useNavigate();
  const { prompt } = Route.useSearch();
  const [input, setInput] = useState(prompt ?? "");
  const transport = useMemo(() => new DefaultChatTransport({
    api: "/api/chat",
    body: { sessionId },
    headers: async (): Promise<Record<string, string>> => {
      const { data } = await supabase.auth.getSession();
      return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
    },
  }), [sessionId]);
  const { messages, sendMessage, status, stop } = useChat({
    id: sessionId,
    messages: initial,
    transport,
    onFinish: onSaved,
    onError: (e) => {
      const m = e.message || "";
      toast.error(m.includes("429") ? "Too many requests — try again shortly." : m.includes("402") ? "AI credits exhausted. Add credits in workspace settings." : m || "AI request failed");
    },
  });
  const busy = status === "submitted" || status === "streaming";

  function send(text: string) {
    if (!text.trim() || busy) return;
    sendMessage({ text });
    setInput("");
  }

  async function saveStrategy(cfg: StrategyConfig) {
    try {
      const id = await createStrategy(`AI: ${cfg.pairs.join(", ")} ${cfg.timeframe}`, cfg, "ai", "Generated by AI assistant");
      const { data: u } = await supabase.auth.getUser();
      await supabase.from("ai_strategy_generations").insert({ user_id: u.user!.id, session_id: sessionId, strategy_id: id, prompt: "chat", model: "openai/gpt-6-astra", output: cfg as never });
      const issues = validateStrategy(cfg);
      toast.success(issues.length ? `Saved as draft — ${issues.length} issue(s) to review` : "Saved and validated");
      navigate({ to: "/strategies/$id", params: { id } });
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <>
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState icon={<Activity className="h-8 w-8 text-primary" />} title="Quantra AI" description="Strategy design, indicators and risk. No live market data yet — the AI won't invent prices.">
              <div className="mt-6 grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-md border bg-card px-3 py-2 text-left text-sm hover:border-primary">{s}</button>)}
              </div>
            </ConversationEmptyState>
          ) : messages.map((m) => {
            const text = m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
            const cfg = m.role === "assistant" && !(busy && m.id === messages.at(-1)?.id) ? extractStrategy(text) : null;
            return (
              <Message key={m.id} from={m.role}>
                <MessageContent className={m.role === "user" ? "bg-primary text-primary-foreground" : ""}>
                  {m.parts.map((p, i) => p.type === "text" ? <MessageResponse key={i}>{p.text}</MessageResponse> : p.type === "reasoning" && p.text ? <p key={i} className="border-l-2 pl-3 text-xs text-muted-foreground">{p.text}</p> : null)}
                  {cfg && <Button size="sm" variant="outline" className="mt-2 w-fit" onClick={() => saveStrategy(cfg)}><Save className="mr-1 h-3.5 w-3.5" />Save as strategy</Button>}
                </MessageContent>
              </Message>
            );
          })}
          {status === "submitted" && <Shimmer className="text-sm">Thinking…</Shimmer>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-4">
        <PromptInput onSubmit={(msg) => send(msg.text ?? "")}>
          <PromptInputBody>
            <PromptInputTextarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about a strategy, indicator or risk setup…" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools><span className="px-2 text-xs text-muted-foreground">Not financial advice. AI cannot place orders.</span></PromptInputTools>
            <PromptInputSubmit status={status} onStop={stop} disabled={!busy && !input.trim()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </>
  );
}
