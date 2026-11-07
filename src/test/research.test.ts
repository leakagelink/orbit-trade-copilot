import { describe, it, expect } from "vitest";
import { researchInput, researchSnapshot, analystReport, unavailableReport } from "../lib/research";
import { canOpen } from "../lib/plans";
const now = Date.UTC(2026,10,7);
const candles = Array.from({length:60}, (_,i) => ({ t: now-(61-i)*86400000, o:100+i, h:102+i, l:99+i, c:101+i, v:1000 }));
describe("Phase 1 research safety", () => {
  it("requires paid AI access outside promotional access", () => { expect(canOpen("/research","free")).toBe(false); expect(canOpen("/research","pro")).toBe(true); });
  it("accepts Indian equity research symbols but not arbitrary URLs", () => { const requestId = "00000000-0000-4000-8000-000000000001"; expect(researchInput.parse({requestId,symbol:"RELIANCE.NS"}).symbol).toBe("RELIANCE.NS"); expect(researchInput.safeParse({requestId,symbol:"https://evil.test"}).success).toBe(false); });
  it("grounds close and indicators in completed candles", () => { const result = researchSnapshot([...candles,{t:now,o:999,h:999,l:999,c:999,v:1}],now); expect(result.close).toBe(160); expect(result.candles).toHaveLength(60); expect(result.rsi14).toBe(100); });
  it("rejects stale market data rather than estimating prices", () => { expect(() => researchSnapshot(candles,now+8*86400000)).toThrow("too old"); });
  it("does not claim fundamentals when data is missing", () => { expect(analystReport.parse(unavailableReport("No statements")).outlook).toBe("insufficient_data"); });
  it("rejects too little evidence", () => { expect(() => researchSnapshot(candles.slice(-10),now)).toThrow("Not enough"); });
});