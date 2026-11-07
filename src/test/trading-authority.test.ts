import { describe, expect, it } from "vitest";
import { accountRiskBlock } from "../lib/engine.server";

type Reply = { data: unknown; error: unknown };
function database(replies: Reply[]) {
  const builder = {
    select: () => builder, eq: () => builder, gte: () => builder,
    maybeSingle: async () => replies.shift(),
    then: (resolve: (value: Reply | undefined) => unknown) => Promise.resolve(replies.shift()).then(resolve),
  };
  return { from: () => builder } as unknown as Parameters<typeof accountRiskBlock>[0];
}
const risk = { trading_halted:false,max_total_positions:3,max_open_exposure:1000,max_daily_loss:100 };
describe("Account safety gates",()=>{
  it("blocks entries when risk settings are missing",async()=>{expect(await accountRiskBlock(database([{data:null,error:null}]),"owner",100)).toContain("unavailable");});
  it("blocks entries when the risk read fails",async()=>{expect(await accountRiskBlock(database([{data:risk,error:{message:"offline"}}]),"owner",100)).toContain("unavailable");});
  it("blocks entries when exposure cannot be read",async()=>{expect(await accountRiskBlock(database([{data:risk,error:null},{data:null,error:{message:"offline"}}]),"owner",100)).toContain("exposure unavailable");});
  it("includes open losses so keeping losing positions open cannot bypass the loss limit",async()=>{expect(await accountRiskBlock(database([{data:risk,error:null},{data:[{entry_price:100,quantity:1,unrealized_pnl:-120}],error:null},{data:[],error:null}]),"owner",100)).toBe("account daily loss limit reached");});
  it("cannot hide losses with profitable unrealized positions",async()=>{expect(await accountRiskBlock(database([{data:risk,error:null},{data:[{entry_price:100,quantity:1,unrealized_pnl:-120},{entry_price:100,quantity:1,unrealized_pnl:500}],error:null},{data:[],error:null}]),"owner",100)).toBe("account daily loss limit reached");});
  it("rejects invalid entry amounts before any query",async()=>{expect(await accountRiskBlock(database([]),"owner",NaN)).toBe("invalid entry cost");});
  it("blocks halted accounts regardless of proposed profitability",async()=>{expect(await accountRiskBlock(database([{data:{...risk,trading_halted:true},error:null}]),"owner",100)).toContain("trading halted");});
});