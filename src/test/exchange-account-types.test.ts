import { describe, expect, it } from "vitest";
import { accountTypeSchema, validateAccountSelection } from "../lib/exchange-account-types";

describe("exchange account selections", () => {
  for (const exchange of ["binance", "bybit", "okx"]) {
    it(`${exchange} allows one or both account types and later changes`, () => {
      for (const choice of ["spot", "both", "futures", "spot"] as const) {
        expect(validateAccountSelection(exchange, accountTypeSchema.parse(choice))).toBe(choice);
      }
    });
  }
  it("does not add both to other venues", () => {
    expect(() => validateAccountSelection("deriv", "both")).toThrow();
    expect(() => validateAccountSelection("coinbase", "both")).toThrow();
    expect(accountTypeSchema.safeParse("invalid").success).toBe(false);
  });
});