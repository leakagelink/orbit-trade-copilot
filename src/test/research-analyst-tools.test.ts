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

describe("streamed replies", () => {
  it("rebuilds tool input, thinking signature and usage from events", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test"); vi.stubEnv("UDC_AI_PRIME_TECH_API_KEY", "test");
    const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
    const input = { summary: "s", outlook: "bearish", observations: ["o"], risks: [], limitations: [] };
    const j = JSON.stringify(input);
    const body = ev("message_start", { type: "message_start", message: { id: "msg_s", usage: { input_tokens: 40, cache_read_input_tokens: 3 } } })
      + ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })
      + ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } })
      + ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } })
      + ev("content_block_stop", { type: "content_block_stop", index: 0 })
      + ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "analyst_report", input: {} } })
      + ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: j.slice(0, 10) } })
      + ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: j.slice(10) } })
      + ev("content_block_stop", { type: "content_block_stop", index: 1 })
      + ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 77 } })
      + ev("message_stop", { type: "message_stop" });
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => { expect(JSON.parse(String(init?.body)).stream).toBe(true); return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }); });
    vi.stubGlobal("fetch", f);
    const r = await runAnalyst("market", "AAPL", {});
    expect(r.report).toEqual(input);
    expect(r.reported).toMatchObject({ inputTokens: 40, outputTokens: 77, cacheReadTokens: 3, providerMessageId: "msg_s", stopReason: "tool_use", repairs: 0 });
  });
  it("treats a stream with no final stop as an error", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test"); vi.stubEnv("UDC_AI_PRIME_TECH_API_KEY", "test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })));
    await expect(runAnalyst("market", "AAPL", {})).rejects.toThrow(/ended the reply early/);
  });
});
