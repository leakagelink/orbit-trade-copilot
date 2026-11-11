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

export function messageText(m: ClaudeMessage) {
  return m.content.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n").trim();
}
