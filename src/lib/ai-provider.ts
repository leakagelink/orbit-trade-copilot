// Browser-safe AI provider facts: every AlgoVirt AI feature runs on the owner's AI Prime Tech (Claude) connection.
export const AI_PROVIDER_NAME = "AI Prime Tech";
export const AI_MODEL = "claude-sonnet-5-5";
export const AI_NOT_CONNECTED = "AI is not connected — link the AI Prime Tech connection to use AI features.";

/** Plain-language message for a failed AI Prime Tech reply (status + body text). */
export function aiErrorMessage(status: number, body: string): string {
  const b = body.toLowerCase();
  if (status === 401 || status === 403 || /invalid (x-)?api[- ]?key|unauthori[sz]ed/.test(b)) return "AI Prime Tech rejected the API key — reconnect it with a valid key.";
  if (status === 402 || /credit|balance|quota|insufficient|expired|plan/.test(b)) return "Your AI Prime Tech balance or plan has run out — top it up in your AI Prime Tech dashboard.";
  if (status === 429) return "AI Prime Tech is limiting requests right now — try again in a minute.";
  if (status === 404) return "The AI model is not available on your AI Prime Tech key group.";
  if (status >= 500 || status === 0) return "AI Prime Tech is temporarily unavailable — try again shortly.";
  return `AI request failed (${status}): ${body.slice(0, 200)}`;
}

/** Same mapping for streaming errors where only a message string is available. */
export function aiStreamErrorMessage(message: string): string {
  const status = Number(message.match(/\b(40[0-9]|429|5\d\d)\b/)?.[1] ?? NaN);
  return Number.isFinite(status) ? aiErrorMessage(status, message) : /rate/i.test(message) ? aiErrorMessage(429, message) : message;
}
