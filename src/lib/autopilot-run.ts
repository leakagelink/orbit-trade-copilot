// Automatic Autopilot runs advance in short, resumable steps (scheduler calls are only a few seconds long):
// one Claude Message Batch per model step, then one tool per tick. Pure state transitions live here.
import { z } from "zod";

export const RUN_MAX_STEPS = 14;
export const TOOL_RESULT_LIMIT = 8000;

export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export interface Msg { role: "user" | "assistant"; content: string | Block[] }
export interface PendingTool { id: string; name: string; input: unknown; started?: boolean; result?: string; isError?: boolean }

export interface RunState { status: "waiting_model" | "executing" | "done" | "failed" | "stopped"; step: number; messages: Msg[]; pending_tools: PendingTool[]; batch_id: string | null; summary?: string | null; error?: string | null }

const modelMessage = z.object({
  content: z.array(z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
    z.object({ type: z.string() }).passthrough(),
  ])),
  stop_reason: z.string().nullable(),
});

/** One JSONL line from a batch's results file → Claude's message, or an error. */
export function parseBatchLine(line: string): { ok: true; message: z.infer<typeof modelMessage> } | { ok: false; error: string } {
  let j: { result?: { type?: string; message?: unknown; error?: { error?: { message?: string }; message?: string } } };
  try { j = JSON.parse(line); } catch { return { ok: false, error: "Unreadable Claude result" }; }
  const r = j.result;
  if (r?.type !== "succeeded") {
    const msg = r?.error?.error?.message ?? r?.error?.message ?? r?.type ?? "unknown";
    return { ok: false, error: `Claude request ${r?.type ?? "failed"}: ${msg}` };
  }
  const m = modelMessage.safeParse(r.message);
  return m.success ? { ok: true, message: m.data } : { ok: false, error: "Unexpected Claude response" };
}

/** Applies Claude's reply: tool calls → executing, otherwise the run is done with its text as summary. */
export function applyModelReply(s: RunState, reply: z.infer<typeof modelMessage>): RunState {
  const blocks = reply.content.filter((b): b is Block => b.type === "text" || b.type === "tool_use") as Block[];
  const messages = [...s.messages, { role: "assistant" as const, content: blocks.length ? blocks : [{ type: "text" as const, text: "(no reply)" }] }];
  const tools = blocks.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
  const text = blocks.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n").trim();
  if (tools.length && reply.stop_reason === "tool_use") {
    return { ...s, messages, batch_id: null, status: "executing", pending_tools: tools.map((t) => ({ id: t.id, name: t.name, input: t.input })) };
  }
  return { ...s, messages, batch_id: null, status: "done", pending_tools: [], summary: text || "Run finished." };
}

/** Next tool to execute. A tool that started but has no result was interrupted: it is never re-run blindly. */
export function nextTool(pending: PendingTool[]): { kind: "run"; index: number } | { kind: "interrupted"; index: number } | { kind: "complete" } {
  const i = pending.findIndex((t) => t.result == null);
  if (i < 0) return { kind: "complete" };
  return pending[i]!.started ? { kind: "interrupted", index: i } : { kind: "run", index: i };
}

export const INTERRUPTED_RESULT = JSON.stringify({ ok: false, error: "Outcome unknown: this action was interrupted. Check open positions and orders before doing anything else; do not repeat it blindly." });

export function clip(value: unknown) {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return s.length > TOOL_RESULT_LIMIT ? `${s.slice(0, TOOL_RESULT_LIMIT)}…(truncated)` : s;
}

/** All tool results recorded → send them back to Claude and wait for the next model step (or stop at the step limit). */
export function completeTools(s: RunState): RunState {
  const content: Block[] = s.pending_tools.map((t) => ({ type: "tool_result", tool_use_id: t.id, content: t.result ?? INTERRUPTED_RESULT, ...(t.isError ? { is_error: true } : {}) }));
  const messages = [...s.messages, { role: "user" as const, content }];
  const step = s.step + 1;
  if (step >= RUN_MAX_STEPS) return { ...s, messages, step, pending_tools: [], status: "done", summary: "Stopped at the step limit for one run; it continues next run." };
  return { ...s, messages, step, pending_tools: [], status: "waiting_model", batch_id: null };
}

export function isErrorResult(result: unknown) {
  return !!result && typeof result === "object" && (result as { ok?: unknown }).ok === false;
}
