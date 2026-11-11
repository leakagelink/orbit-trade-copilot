import { describe, expect, it } from "vitest";
import { liveEnableProblems, liveToolInputs } from "@/lib/autopilot-guard";
import { applyModelReply, completeTools, INTERRUPTED_RESULT, nextTool, parseModelResponse, RUN_MAX_STEPS, type RunState } from "@/lib/autopilot-run";
import { derivCloseRecord, derivContractClosed, derivOpenContract, parseDerivCandles } from "@/lib/deriv";

const risk = { max_daily_loss: 50, max_open_exposure: 500, trading_halted: false };
const acct = "00000000-0000-0000-0000-000000000001";

describe("real-money Autopilot can only be switched on safely", () => {
  it("needs the typed LIVE confirmation", () => {
    expect(liveEnableProblems({ confirm: "live", risk, binanceId: acct, derivId: null })).toContain("Type LIVE to confirm real-money trading");
  });
  it("needs at least one connected account", () => {
    expect(liveEnableProblems({ confirm: "LIVE", risk, binanceId: null, derivId: null }).length).toBe(1);
  });
  it("needs saved risk settings with a daily loss limit and exposure limit", () => {
    expect(liveEnableProblems({ confirm: "LIVE", risk: null, binanceId: acct, derivId: null })).toEqual(["Save your risk settings first (Risk page)"]);
    expect(liveEnableProblems({ confirm: "LIVE", risk: { ...risk, max_daily_loss: null }, binanceId: acct, derivId: null })).toEqual(["Set a maximum daily loss on the Risk page"]);
    expect(liveEnableProblems({ confirm: "LIVE", risk: { ...risk, max_open_exposure: null }, binanceId: acct, derivId: null })).toEqual(["Set a maximum open exposure on the Risk page"]);
  });
  it("is blocked while the emergency stop is active", () => {
    expect(liveEnableProblems({ confirm: "LIVE", risk: { ...risk, trading_halted: true }, binanceId: acct, derivId: null }).length).toBe(1);
  });
  it("allows it when everything is in place", () => {
    expect(liveEnableProblems({ confirm: "LIVE", risk, binanceId: acct, derivId: acct })).toEqual([]);
  });
});

describe("live trade inputs", () => {
  const deriv = { symbol: "R_100", direction: "up", stake: 10, multiplier: 50, stopLossAmount: 5, takeProfitAmount: null };
  it("Deriv multiplier needs a stop loss no bigger than the stake", () => {
    expect(liveToolInputs.openDeriv.safeParse(deriv).success).toBe(true);
    expect(liveToolInputs.openDeriv.safeParse({ ...deriv, stopLossAmount: 11 }).success).toBe(false);
    const { stopLossAmount: _omit, ...noStop } = deriv;
    expect(liveToolInputs.openDeriv.safeParse(noStop).success).toBe(false);
  });
  it("live inputs cannot choose a different account", () => {
    expect(liveToolInputs.openDeriv.safeParse({ ...deriv, connectionId: acct }).success).toBe(false);
    expect(liveToolInputs.openBinance.safeParse({ symbol: "BTC/USDT", amountUsd: 20, stopLoss: 1, takeProfit: null, connectionId: acct }).success).toBe(false);
  });
  it("Binance live has no sell side (spot buy only)", () => {
    expect(liveToolInputs.openBinance.safeParse({ symbol: "BTC/USDT", amountUsd: 20, stopLoss: 1, takeProfit: null, side: "sell" }).success).toBe(false);
  });
});

describe("automatic runs advance safely", () => {
  const base: RunState = { status: "waiting_model", step: 0, messages: [{ role: "user", content: "go" }], pending_tools: [], batch_id: "b1" };
  it("a tool call moves the run to executing", () => {
    const s = applyModelReply(base, { content: [{ type: "tool_use", id: "t1", name: "get_account_overview", input: {} }], stop_reason: "tool_use" });
    expect(s.status).toBe("executing");
    expect(s.pending_tools).toHaveLength(1);
  });
  it("a plain reply finishes the run with its summary", () => {
    const s = applyModelReply(base, { content: [{ type: "text", text: "Nothing to do." }], stop_reason: "end_turn" });
    expect(s.status).toBe("done");
    expect(s.summary).toBe("Nothing to do.");
  });
  it("an interrupted action is never repeated", () => {
    expect(nextTool([{ id: "t1", name: "live_open_binance_trade", input: {}, started: true }])).toEqual({ kind: "interrupted", index: 0 });
    expect(nextTool([{ id: "t1", name: "x", input: {} }])).toEqual({ kind: "run", index: 0 });
    const s = completeTools({ ...base, status: "executing", pending_tools: [{ id: "t1", name: "x", input: {}, started: true }] });
    expect(JSON.stringify(s.messages.at(-1))).toContain(JSON.stringify(INTERRUPTED_RESULT).slice(1, 40));
  });
  it(`stops after ${RUN_MAX_STEPS} model steps`, () => {
    const s = completeTools({ ...base, step: RUN_MAX_STEPS - 1, status: "executing", pending_tools: [{ id: "t1", name: "x", input: {}, result: "{}" }] });
    expect(s.status).toBe("done");
  });
  it("reads AI errors instead of acting", () => {
    expect(parseModelResponse({ status_code: 402, content: "insufficient balance", timed_out: false, error_msg: null })).toEqual({ ok: false, error: "Your AI Prime Tech balance or plan has run out — top it up in your AI Prime Tech dashboard." });
    expect(parseModelResponse({ status_code: null, content: null, timed_out: true, error_msg: null }).ok).toBe(false);
    expect(parseModelResponse({ status_code: 200, content: "not json", timed_out: false, error_msg: null })).toEqual({ ok: false, error: "Unreadable AI reply" });
  });
  it("reads a stored Claude reply with a tool call", () => {
    const r = parseModelResponse({ status_code: 200, content: JSON.stringify({ content: [{ type: "tool_use", id: "t1", name: "get_account_overview", input: {} }], stop_reason: "tool_use" }), timed_out: false, error_msg: null });
    expect(r.ok && r.message.stop_reason).toBe("tool_use");
  });
});

describe("Deriv contract records", () => {
  it("splits Deriv's net profit into gross PnL and commission", () => {
    const c = derivOpenContract.parse({ contract_id: 1, buy_price: "10", profit: "-2.5", commission: "0.3", exit_spot: "100.5", is_sold: 1 });
    expect(derivContractClosed(c)).toBe(true);
    const r = derivCloseRecord(c, 99);
    expect(r.net).toBe(-2.5);
    expect(r.fees).toBeCloseTo(0.3);
    expect(r.gross).toBeCloseTo(-2.2);
    expect(r.exit).toBe(100.5);
  });
  it("an open contract is not treated as closed", () => {
    expect(derivContractClosed(derivOpenContract.parse({ contract_id: 1, status: "open", is_sold: 0 }))).toBe(false);
  });
  it("rejects malformed candles instead of inventing prices", () => {
    expect(() => parseDerivCandles({ candles: [{ epoch: 1, open: "x" }] })).toThrow();
    expect(parseDerivCandles({ candles: [{ epoch: 2, open: 1, high: 2, low: 0.5, close: 1.5 }] })[0]).toEqual({ t: 2000, o: 1, h: 2, l: 0.5, c: 1.5, v: 0 });
  });
});
