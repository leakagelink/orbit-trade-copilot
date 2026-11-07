import { describe, expect, it } from "vitest";
import { derivAppId, parseDerivBalances } from "../lib/deriv";
import { EXCHANGES } from "../lib/exchanges";

const response = { data: [
  { account_id: "demo-account", balance: 10000, currency: "USD", account_type: "demo" },
  { account_id: "real-account", balance: "25.5", currency: "USD", account_type: "real" },
] };
describe("Deriv connection", () => {
  it("offers connection without claiming order support", () => {
    expect(EXCHANGES.find((e) => e.id === "deriv")).toMatchObject({ available: true, orderTypes: [], connectionOnly: true });
  });
  it("keeps demo funds separate from real funds", () => {
    expect(parseDerivBalances(response, true)).toEqual([{ asset: "USD", free: 10000, locked: 0 }]);
    expect(parseDerivBalances(response, false)).toEqual([{ asset: "USD", free: 25.5, locked: 0 }]);
  });
  it("rejects absent accounts and invalid balances", () => {
    expect(() => parseDerivBalances({ data: [] }, true)).toThrow();
    expect(() => parseDerivBalances({ data: [{ ...response.data[0], balance: "invalid" }] }, true)).toThrow();
  });
  it("accepts short application IDs but rejects header injection", () => {
    expect(derivAppId.parse("1234")).toBe("1234");
    expect(derivAppId.safeParse("1234\r\nX-Other: value").success).toBe(false);
  });
});