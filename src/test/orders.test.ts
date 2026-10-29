import { describe, expect, it } from "vitest";
import { floorToStep } from "@/lib/exchange-adapters.server";

describe("order sizing", () => {
  it("rounds sell quantity down to the exchange step", () => {
    expect(floorToStep(0.0123456, 0.00001)).toBe(0.01234);
    expect(floorToStep(1.999, 0.01)).toBe(1.99);
    expect(floorToStep(0.3, 0.1)).toBe(0.3);
  });
});
