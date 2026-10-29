import { describe, expect, it } from "vitest";
import { evalCondition, rsi, sma, ema } from "@/lib/indicators";

describe("indicators", () => {
  it("SMA of 1..5 over 3", () => expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]));
  it("EMA seeds with SMA", () => expect(ema([2, 4, 6, 8], 3)[2]).toBe(4));
  it("RSI is 100 when price only rises", () => expect(rsi([1, 2, 3, 4, 5, 6], 3)[5]).toBe(100));
  it("crosses_above needs prior below", () => {
    const m = { price: [9, 11], ema_1: [10, 10] };
    expect(evalCondition({ left: "price", operator: "crosses_above", right: "ema_1" }, m, 1)).toBe(true);
    expect(evalCondition({ left: "price", operator: "crosses_below", right: "ema_1" }, m, 1)).toBe(false);
  });
});
