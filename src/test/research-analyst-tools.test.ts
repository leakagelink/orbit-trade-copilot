// The analyst call exposes exactly one report tool; any other tool the model emits is ignored.
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeReportInput, runAnalyst } from "@/lib/research.server";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("analyst tool surface", () => {
  it("offers only analyst_report, requires it in the instructions, and ignores other tool calls", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test"); vi.stubEnv("UDC_AI_PRIME_TECH_API_KEY", "test");
    let body: { tools: { name: string; strict?: boolean }[]; tool_choice: { type: string }; system: string } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "msg_1", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [
        { type: "tool_use", id: "x", name: "update_risk_settings", input: { max_daily_loss: 1e9 } },
        { type: "tool_use", id: "y", name: "analyst_report", input: { summary: "s", outlook: "neutral", observations: [], risks: [], limitations: [] } },
      ] }), { status: 200 });
    }));
    const r = await runAnalyst("market", "AAPL", { x: 1 });
    expect(body!.tools.map((t) => t.name)).toEqual(["analyst_report"]);
    expect(body!.tool_choice.type).toBe("auto");
    expect(body!.tools[0]!.strict).toBe(true);
    expect(body!.system).toMatch(/calling the analyst_report tool exactly once/);
    expect(Object.keys(r).sort()).toEqual(["inputTokens", "outputTokens", "report", "reported"]);
    expect(r.reported).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, providerMessageId: "msg_1", stopReason: "tool_use", repairs: 0 });
  });
});

const reply = (content: unknown[], stop = "tool_use", usage = { input_tokens: 10, output_tokens: 5 }) => new Response(JSON.stringify({ id: "m", stop_reason: stop, usage, content }), { status: 200 });
const good = { type: "tool_use", id: "t2", name: "analyst_report", input: { summary: "s", outlook: "neutral", observations: [], risks: [], limitations: [] } };
const bad = { type: "tool_use", id: "t1", name: "analyst_report", input: { summary: "s", outlook: "up", observations: [], risks: [], limitations: [] } };

describe("format correction", () => {
  it("makes exactly one correction call with the validation error, then sums usage", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test"); vi.stubEnv("UDC_AI_PRIME_TECH_API_KEY", "test");
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? reply([bad]) : reply([good]); });
    vi.stubGlobal("fetch", f);
    const before = vi.fn();
    const r = await runAnalyst("market", "AAPL", {}, before);
    expect(f).toHaveBeenCalledTimes(2);
    expect(before).toHaveBeenCalledTimes(1);
    expect(r.report.outlook).toBe("neutral");
    expect(r.reported).toMatchObject({ inputTokens: 20, outputTokens: 10, repairs: 1 });
    const correction = bodies[1]!.messages[2]!.content as { type: string; tool_use_id: string; is_error: boolean; content: string }[];
    expect(correction[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: true });
    expect(correction[0]!.content).toMatch(/outlook/);
  });
  it("fails after the single correction without a third call", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test"); vi.stubEnv("UDC_AI_PRIME_TECH_API_KEY", "test");
    const f = vi.fn(async () => reply([{ type: "text", text: "Buy now" }], "end_turn"));
    vi.stubGlobal("fetch", f);
    await expect(runAnalyst("market", "AAPL", {})).rejects.toThrow(/after one format correction/);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("gives the correction twice the output allowance only after an output-limit stop", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test"); vi.stubEnv("UDC_AI_PRIME_TECH_API_KEY", "test");
    const caps: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => { caps.push(JSON.parse(String(init?.body)).max_tokens); return caps.length === 1 ? reply([], "max_tokens") : reply([good]); }));
    await runAnalyst("market", "AAPL", {});
    expect(caps).toEqual([4000, 8000]);
    caps.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => { caps.push(JSON.parse(String(init?.body)).max_tokens); return caps.length === 1 ? reply([bad]) : reply([good]); }));
    await runAnalyst("market", "AAPL", {});
    expect(caps).toEqual([4000, 4000]);
  });
  it("refuses the correction when the spending check refuses it", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test"); vi.stubEnv("UDC_AI_PRIME_TECH_API_KEY", "test");
    const f = vi.fn(async () => reply([], "max_tokens"));
    vi.stubGlobal("fetch", f);
    await expect(runAnalyst("market", "AAPL", {}, () => { throw new Error("budget stop"); })).rejects.toThrow(/budget stop/);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("decodeReportInput", () => {
  it("decodes JSON-text lists and outlook case without changing content", () => {
    expect(decodeReportInput({ summary: "s", outlook: " Neutral ", observations: '["a","b"]', risks: [], limitations: "[]" }))
      .toEqual({ summary: "s", outlook: "neutral", observations: ["a", "b"], risks: [], limitations: [] });
  });
  it("leaves plain text and unknown values for validation to reject", () => {
    expect(decodeReportInput({ outlook: "mixed", risks: "rates may rise" })).toEqual({ outlook: "mixed", risks: "rates may rise" });
    expect(decodeReportInput({ risks: '[1,2]' })).toEqual({ risks: '[1,2]' });
  });
});
