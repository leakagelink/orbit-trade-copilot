// Server-only access to Claude through the owner's AI Prime Tech connection (Lovable connector gateway).
// Credentials are read per call inside server code and never reach the browser.
import { AI_NOT_CONNECTED, aiErrorMessage } from "./ai-provider";

const GATEWAY = "https://connector-gateway.lovable.dev/udc_ai_prime_tech";
export const AI_PRIME_MESSAGES_URL = `${GATEWAY}/v1/messages`;

export function aiPrimeHeaders(): Record<string, string> | null {
  const lovable = process.env["LOVABLE_API_KEY"];
  const connection = process.env["UDC_AI_PRIME_TECH_API_KEY"];
  if (!lovable || !connection) return null;
  return { Authorization: `Bearer ${lovable}`, "X-Connection-Api-Key": connection, "anthropic-version": "2023-06-01", "content-type": "application/json" };
}

export function aiPrimeReady() {
  return aiPrimeHeaders() !== null;
}

/** Anthropic-format provider for the Vercel AI SDK (streaming chat + tools), routed through the connection. */
export async function aiPrimeProvider() {
  const headers = aiPrimeHeaders();
  if (!headers) throw new Error(AI_NOT_CONNECTED);
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  return createAnthropic({
    baseURL: `${GATEWAY}/v1`,
    apiKey: "via-connection",
    fetch: (input, init) => {
      const h = new Headers(init?.headers);
      h.delete("x-api-key");
      for (const [k, v] of Object.entries(headers)) h.set(k, v);
      return fetch(input, { ...init, headers: h });
    },
  });
}

export type ClaudeBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: string; [k: string]: unknown };
export interface ClaudeMessage { content: ClaudeBlock[]; stop_reason: string | null; usage?: { input_tokens?: number; output_tokens?: number } }

/** One non-streaming Messages call. Throws a plain-language error on failure. */
export async function aiPrimeMessage(body: Record<string, unknown>, timeoutMs = 120_000): Promise<ClaudeMessage> {
  const headers = aiPrimeHeaders();
  if (!headers) throw new Error(AI_NOT_CONNECTED);
  const r = await fetch(AI_PRIME_MESSAGES_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  if (!r.ok) {
    console.error(`AI Prime Tech request failed [${r.status}]: ${text.slice(0, 500)}`);
    throw new Error(aiErrorMessage(r.status, text));
  }
  return JSON.parse(text) as ClaudeMessage;
}

/** Rebuilds a Messages response from Server-Sent Events, keeping thinking signatures and tool inputs intact. */
export function assembleClaudeStream(events: { event: string; data: unknown }[]): ClaudeMessage {
  let message: Record<string, unknown> = {}; const blocks: Record<string, unknown>[] = []; const json: string[] = [];
  let usage: Record<string, unknown> = {}; let stop: string | null = null;
  for (const { event, data } of events) {
    const d = (data ?? {}) as Record<string, any>;
    if (event === "error" || d.type === "error") { console.error(`AI Prime Tech stream error: ${JSON.stringify(d).slice(0, 500)}`); throw new Error(aiErrorMessage(529, JSON.stringify(d))); }
    if (d.type === "message_start") { message = { ...d.message }; usage = { ...(d.message?.usage ?? {}) }; }
    else if (d.type === "content_block_start") { blocks[d.index] = { ...d.content_block }; json[d.index] = ""; }
    else if (d.type === "content_block_delta") {
      const b = blocks[d.index]; const x = d.delta ?? {};
      if (!b) continue;
      if (x.type === "text_delta") b.text = String(b.text ?? "") + x.text;
      else if (x.type === "input_json_delta") json[d.index] += x.partial_json ?? "";
      else if (x.type === "thinking_delta") b.thinking = String(b.thinking ?? "") + x.thinking;
      else if (x.type === "signature_delta") b.signature = String(b.signature ?? "") + x.signature;
    } else if (d.type === "content_block_stop") {
      const b = blocks[d.index];
      if (b?.type === "tool_use" && json[d.index]) { try { b.input = JSON.parse(json[d.index]!); } catch { b.input = json[d.index]; } }
    } else if (d.type === "message_delta") { stop = d.delta?.stop_reason ?? stop; usage = { ...usage, ...(d.usage ?? {}) }; }
  }
  return { ...message, content: blocks.filter(Boolean) as ClaudeBlock[], stop_reason: stop, usage: usage as ClaudeMessage["usage"] };
}

/**
 * One streamed Messages call, returned as a complete message. Streaming keeps long reasoning replies alive past the
 * connector's response timeout; a non-streamed JSON reply is also accepted.
 */
export async function aiPrimeMessageStreamed(body: Record<string, unknown>, timeoutMs = 300_000): Promise<ClaudeMessage> {
  const headers = aiPrimeHeaders();
  if (!headers) throw new Error(AI_NOT_CONNECTED);
  const r = await fetch(AI_PRIME_MESSAGES_URL, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) {
    const text = await r.text();
    console.error(`AI Prime Tech request failed [${r.status}]: ${text.slice(0, 500)}`);
    throw new Error(aiErrorMessage(r.status, text));
  }
  const text = await r.text();
  if (!(r.headers.get("content-type") ?? "").includes("event-stream")) return JSON.parse(text) as ClaudeMessage;
  const events = text.split(/\r?\n\r?\n/).flatMap((chunk) => {
    const lines = chunk.split(/\r?\n/);
    const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "";
    const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) return [];
    try { return [{ event, data: JSON.parse(data) as unknown }]; } catch { return []; }
  });
  const m = assembleClaudeStream(events);
  if (!m.stop_reason) throw new Error("AI Prime Tech ended the reply early — try again shortly.");
  return m;
}

export function messageText(m: ClaudeMessage) {
  return m.content.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n").trim();
}
