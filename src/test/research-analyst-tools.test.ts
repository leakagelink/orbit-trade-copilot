// The analyst call exposes exactly one report tool; any other tool the model emits is ignored.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAnalyst } from "@/lib/research.server";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("analyst tool surface", () => {
  it("offers only analyst_report, forces it, and ignores other tool calls", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test"); vi.stubEnv("UDC_AI_PRIME_TECH_API_KEY", "test");
    let body: { tools: { name: string }[]; tool_choice: { name: string } } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "msg_1", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [
        { type: "tool_use", id: "x", name: "update_risk_settings", input: { max_daily_loss: 1e9 } },
        { type: "tool_use", id: "y", name: "analyst_report", input: { summary: "s", outlook: "neutral", observations: [], risks: [], limitations: [] } },
      ] }), { status: 200 });
    }));
    const r = await runAnalyst("market", "AAPL", { x: 1 });
    expect(body!.tools.map((t) => t.name)).toEqual(["analyst_report"]);
    expect(body!.tool_choice.name).toBe("analyst_report");
    expect(Object.keys(r).sort()).toEqual(["inputTokens", "outputTokens", "report", "reported"]);
    expect(r.reported).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, providerMessageId: "msg_1", stopReason: "tool_use" });
  });
});
