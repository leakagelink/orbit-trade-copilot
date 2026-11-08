import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { Bot, CheckCircle2, CircleAlert, KeyRound, Loader2, Plus, Settings2, ShieldCheck, Trash2, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { autopilotStatus } from "@/lib/autopilot.functions";
import { AutopilotSettings, useAutopilotSettings } from "@/components/autopilot-settings";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const T = "AI Autopilot — AlgoVirt";
const D = "Let the AI build strategies, run bots and trade for you — demo by default, real money on Binance and Deriv when you switch it on.";
export const Route = createFileRoute("/_authenticated/autopilot")({
  validateSearch: z.object({ session: z.string().uuid().optional() }),
  head: () => ({ meta: [{ title: T }, { name: "description", content: D }, { property: "og:title", content: T }, { property: "og:description", content: D }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }] }),
  component: Autopilot,
});

const TASKS = [
  "Run a full autopilot cycle: check BTC/USDT and ETH/USDT, design a strategy, backtest it for 180 days and start a paper bot if the results are good",
  "Review my open demo positions and bots, close or stop anything that breaks its plan, and summarise",
  "Find one high-quality demo trade in gold, EUR/USD or BTC right now with a tight stop loss",
  "Scan BTC/USDT arbitrage across Binance, OKX, Bybit and KuCoin and run a paper round if net is positive",
];

const TOOL_LABELS: Record<string, string> = {
  get_account_overview: "Checked account", list_markets: "Listed markets", get_market_snapshot: "Read market data",
  create_strategy: "Created strategy", run_backtest: "Ran backtest", start_paper_bot: "Started paper bot", stop_bot: "Stopped bot",
  open_paper_trade: "Opened demo trade", open_paper_scalp: "Opened demo scalp", close_paper_position: "Closed demo position",
  scan_arbitrage: "Scanned arbitrage", run_paper_arbitrage: "Ran paper arbitrage",
  live_account_balances: "Checked real balances", live_close_position: "Closed REAL position", live_open_binance_trade: "Opened REAL Binance trade",
  live_deriv_symbols: "Listed Deriv markets", live_deriv_snapshot: "Read Deriv market data", live_open_deriv_multiplier: "Opened REAL Deriv multiplier",
};

function Autopilot() {
  const { session } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useServerFn(autopilotStatus);
  const ready = useQuery({ queryKey: ["autopilot_status"], queryFn: () => status(), staleTime: 60_000 });
  const sessions = useQuery({
    queryKey: ["autopilot_sessions"],
    queryFn: async () => {
      const { data, error } = await supabase.from("ai_sessions").select("id,title,updated_at").eq("kind", "autopilot").order("updated_at", { ascending: false }).limit(50);
      if (error) throw new Error(error.message);
      return data;
    },
  });

  async function newSession() {
    const { data: u } = await supabase.auth.getUser();
    const { data, error } = await supabase.from("ai_sessions").insert({ user_id: u.user!.id, kind: "autopilot" }).select("id").single();
    if (error) return void toast.error(error.message);
    await qc.invalidateQueries({ queryKey: ["autopilot_sessions"] });
    navigate({ to: "/autopilot", search: { session: data.id } });
  }

  useEffect(() => {
    if (session || !sessions.data) return;
    if (sessions.data[0]) navigate({ to: "/autopilot", search: { session: sessions.data[0].id }, replace: true });
    else void newSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessions.data]);

  async function remove(id: string) {
    await supabase.from("ai_sessions").delete().eq("id", id);
    await qc.invalidateQueries({ queryKey: ["autopilot_sessions"] });
    if (id === session) navigate({ to: "/autopilot", search: {} });
  }

  const claudeReady = ready.data?.claudeReady ?? false;
  const settings = useAutopilotSettings();
  const live = !!settings.data?.settings?.live_enabled;
  const auto = !!settings.data?.settings?.enabled;
  const [open, setOpen] = useState(false);
  return (
    <div className="assistant-workspace flex min-h-0 min-w-0">
      <aside className="hidden w-60 shrink-0 flex-col border-r lg:flex">
        <div className="p-3"><Button variant="outline" className="w-full" onClick={newSession}><Plus className="mr-1 h-4 w-4" />New run</Button></div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {sessions.data?.map((s) => (
            <div key={s.id} className={cn("group flex items-center rounded-md text-sm", s.id === session ? "bg-accent text-accent-foreground" : "hover:bg-muted")}>
              <button className="flex-1 truncate px-3 py-2 text-left" onClick={() => navigate({ to: "/autopilot", search: { session: s.id } })}>{s.title}</button>
              <button aria-label="Delete run" className="mr-1 hidden p-1 text-muted-foreground hover:text-destructive group-hover:block" onClick={() => remove(s.id)}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
          {live
            ? <span className="inline-flex items-center gap-1 rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 font-medium text-destructive"><Zap className="h-3.5 w-3.5" />Real money ON</span>
            : <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-medium text-primary"><ShieldCheck className="h-3.5 w-3.5" />Demo / paper only</span>}
          <span className="text-muted-foreground">{auto ? "Automatic runs on." : "Automatic runs off."} Risk settings apply. No withdrawals or key changes.</span>
          <span className="ml-auto flex items-center gap-3">
            <Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(true)}><Settings2 className="mr-1 h-3.5 w-3.5" />Automatic & real money</Button>
            <Link to="/risk" className="text-primary hover:underline">Emergency stop</Link>
          </span>
        </div>
        {!ready.isLoading && !claudeReady && (
          <div className="m-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div><p className="font-medium">Claude API key needed</p><p className="text-muted-foreground">Autopilot runs on your own Anthropic Claude account. Once the key is added it starts working here automatically.</p></div>
          </div>
        )}
        <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b p-3 lg:hidden">
          <Select value={session ?? ""} onValueChange={(value) => navigate({ to: "/autopilot", search: { session: value } })}>
            <SelectTrigger aria-label="Autopilot runs"><SelectValue placeholder="Autopilot runs" /></SelectTrigger>
            <SelectContent>{sessions.data?.map(s => <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="icon" aria-label="New run" onClick={newSession}><Plus /></Button>
        </div>
        {session ? <RunWindow key={session} sessionId={session} disabled={!claudeReady} live={live} onSaved={() => qc.invalidateQueries({ queryKey: ["autopilot_sessions"] })} /> : <div className="p-6"><Skeleton className="h-40" /></div>}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader><DialogTitle>Automatic & real money</DialogTitle><DialogDescription>Choose when the AI runs by itself and whether it may trade real money.</DialogDescription></DialogHeader>
            <AutopilotSettings claudeReady={claudeReady} />
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function RunWindow({ sessionId, disabled, live, onSaved }: { sessionId: string; disabled: boolean; live: boolean; onSaved: () => void }) {
  const q = useQuery({
    queryKey: ["autopilot_session", sessionId],
    queryFn: async () => {
      const { data, error } = await supabase.from("ai_sessions").select("messages").eq("id", sessionId).single();
      if (error) throw new Error(error.message);
      return (data.messages as unknown as UIMessage[]) ?? [];
    },
    staleTime: Infinity,
  });
  if (q.isError) return <div className="p-6 text-sm text-destructive">{q.error.message}</div>;
  if (!q.data) return <div className="p-6"><Skeleton className="h-40" /></div>;
  return <Run sessionId={sessionId} initial={q.data} disabled={disabled} live={live} onSaved={onSaved} />;
}

type ToolPart = { type: string; state?: string; input?: unknown; output?: unknown; errorText?: string };

function summarize(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { ok?: boolean; error?: string; stats?: { total_trades?: number; net_profit?: number; max_drawdown_pct?: number } | null; price?: unknown; netPnl?: number } & Record<string, unknown>;
  if (o.ok === false) return String(o.error ?? "Failed");
  const ids = ["strategyId", "backtestId", "botId", "positionId", "runId"].filter((k) => o[k]).map((k) => `${k.replace(/Id$/, "")} ${String(o[k]).slice(0, 8)}`);
  const s = o.stats;
  const bits = [
    ...ids,
    s ? `${s.total_trades ?? 0} trades, net ${Number(s.net_profit ?? 0).toFixed(2)}, max DD ${Number(s.max_drawdown_pct ?? 0).toFixed(1)}%` : null,
    typeof o.price === "number" ? `price ${o.price}` : null,
    o.netPnl != null ? `net ${Number(o.netPnl).toFixed(2)}` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
}

function ToolCard({ part }: { part: ToolPart }) {
  const name = part.type.replace(/^tool-/, "");
  const failed = part.state === "output-error" || (part.output as { ok?: boolean } | undefined)?.ok === false;
  const done = part.state === "output-available" || part.state === "output-error";
  const detail = part.state === "output-error" ? part.errorText : summarize(part.output);
  return (
    <div className={cn("flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-xs", failed && "border-destructive/40")}>
      {!done ? <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-primary" /> : failed ? <CircleAlert className="mt-0.5 h-3.5 w-3.5 text-destructive" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-primary" />}
      <div className="min-w-0"><p className="font-medium">{TOOL_LABELS[name] ?? name}</p>{detail && <p className="break-words text-muted-foreground">{detail}</p>}</div>
    </div>
  );
}

function Run({ sessionId, initial, disabled, live, onSaved }: { sessionId: string; initial: UIMessage[]; disabled: boolean; live: boolean; onSaved: () => void }) {
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const transport = useMemo(() => new DefaultChatTransport({
    api: "/api/autopilot",
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
    onFinish: () => { onSaved(); void qc.invalidateQueries(); },
    onError: (e) => toast.error(e.message || "Autopilot request failed"),
  });
  const busy = status === "submitted" || status === "streaming";

  function send(text: string) {
    if (!text.trim() || busy || disabled) return;
    sendMessage({ text });
    setInput("");
  }

  return (
    <>
      <Conversation className="min-h-0 min-w-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState icon={<Bot className="h-8 w-8 text-primary" />} title="AI Autopilot" description={live ? "Real money is ON for your chosen accounts. Tell the AI what to do, or switch on automatic runs." : "Tell the AI what to do. It builds and tests strategies, runs paper bots and places demo trades, scalps and arbitrage — then reports back."}>
              <div className="mt-6 grid gap-2 sm:grid-cols-2">
                {TASKS.map((s) => <button key={s} disabled={disabled} onClick={() => send(s)} className="rounded-md border bg-card px-3 py-2 text-left text-sm hover:border-primary disabled:opacity-50">{s}</button>)}
              </div>
            </ConversationEmptyState>
          ) : messages.map((m) => (
            <Message key={m.id} from={m.role}>
              <MessageContent className={cn("min-w-0 max-w-full gap-2 break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto", m.role === "user" && "bg-primary text-primary-foreground")}>
                {m.parts.map((p, i) => p.type === "text" ? <MessageResponse key={i}>{p.text}</MessageResponse> : p.type.startsWith("tool-") ? <ToolCard key={i} part={p as ToolPart} /> : null)}
              </MessageContent>
            </Message>
          ))}
          {status === "submitted" && <Shimmer className="text-sm">Planning…</Shimmer>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl shrink-0 p-3 sm:p-4">
        <PromptInput onSubmit={(msg) => send(msg.text ?? "")}>
          <PromptInputBody>
            <PromptInputTextarea value={input} disabled={disabled} onChange={(e) => setInput(e.target.value)} placeholder={disabled ? "Add your Claude API key to start" : "Tell the autopilot what to do…"} />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools className="min-w-0"><span className={cn("min-w-0 px-2 text-[10px] sm:text-xs", live ? "text-destructive" : "text-muted-foreground")}>{live ? "Real money is ON — the AI can place real orders." : "Demo money only."} Profit is never guaranteed.</span></PromptInputTools>
            <PromptInputSubmit status={status} onStop={stop} disabled={disabled || (!busy && !input.trim())} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </>
  );
}
