import { describe, expect, it, vi } from "vitest";
import { runDecisionStages, type AgentResult, type ResearchAgent } from "../lib/research-pipeline";
import { unavailableReport, researchSnapshot } from "../lib/research";
import { buildResearchProposal, researchProposal } from "../lib/research-proposal";

const now = Date.UTC(2026,10,7);
const report = { ...unavailableReport("Historical thesis"), outlook: "bullish" as const };
const result = (agent: ResearchAgent): AgentResult => ({ agent, status: "completed", report });
const snapshot = researchSnapshot(Array.from({length:60},(_,i)=>({t:now-(60-i)*86400000,o:100,h:102,l:98,c:100,v:1000})),now);
const all = (["market","manager","trader","risk_aggressive","risk_conservative","risk_neutral","portfolio"] as const).map(result);

describe("Advisory decision stages", () => {
  it("orders trader then three risk reviews then portfolio and saves all",async()=>{
    const calls:ResearchAgent[]=[],saved:AgentResult[]=[];
    const results=await runDecisionStages([result("manager")],snapshot,async a=>{calls.push(a);return report;},async r=>{saved.push(r);});
    expect(calls).toEqual(["trader","risk_aggressive","risk_conservative","risk_neutral","portfolio"]);expect(saved).toHaveLength(5);expect(results).toHaveLength(6);
  });
  it("makes no decision calls without completed upstream research",async()=>{
    const analyze=vi.fn();const saved:AgentResult[]=[];
    await runDecisionStages([],snapshot,analyze,async r=>{saved.push(r);});expect(analyze).not.toHaveBeenCalled();expect(saved.every(r=>r.status==="unavailable")).toBe(true);expect(saved).toHaveLength(5);
  });
  it("pauses risk and portfolio after trader failure without retry",async()=>{
    const analyze=vi.fn(async()=>{throw new Error("unknown outcome");});const results=await runDecisionStages([result("manager")],snapshot,analyze,async()=>{});
    expect(analyze).toHaveBeenCalledTimes(1);expect(results.find(r=>r.agent==="portfolio")?.status).toBe("unavailable");
  });
  it("requires all three successful risk reviews",async()=>{
    const analyze=vi.fn(async(a:ResearchAgent)=>{if(a==="risk_conservative")throw new Error("failure");return report;});
    const results=await runDecisionStages([result("manager")],snapshot,analyze,async()=>{});expect(analyze.mock.calls.map(c=>c[0])).not.toContain("portfolio");expect(results.find(r=>r.agent==="portfolio")?.status).toBe("unavailable");
  });
  it("drains sibling risk writes before reporting storage failure",async()=>{
    let saved=false;await expect(runDecisionStages([result("manager")],snapshot,async()=>report,async r=>{if(r.agent==="risk_aggressive")throw new Error("storage");if(r.agent==="risk_neutral"){await new Promise(resolve=>setTimeout(resolve,10));saved=true;}})).rejects.toThrow("storage");expect(saved).toBe(true);
  });
});
describe("Historical proposal safety",()=>{
  it("computes grounded levels, not AI prices, and never allows execution or sizing",()=>{
    const p=buildResearchProposal(snapshot,all,now);expect(p.status).toBe("scenario");expect(p.hypotheticalEntry).toBe(100);expect(p.stopLoss).toBe(96);expect(p.takeProfit).toBe(108);expect(p.rewardRisk).toBe(2);expect(p.executionAllowed).toBe(false);expect(p.positionSize).toBeNull();expect(p.confidence).toBeNull();
  });
  it("withholds proposals on missing risk evidence",()=>{const p=buildResearchProposal(snapshot,all.filter(r=>r.agent!=="risk_conservative"),now);expect(p.status).toBe("withheld");expect(p.hypotheticalEntry).toBeNull();});
  it("withholds conflicting directional assessments",()=>{const p=buildResearchProposal(snapshot,all.map(r=>r.agent==="risk_conservative"?{...r,report:{...report,outlook:"bearish"}}:r),now);expect(p.status).toBe("withheld");});
  it("rejects stale evidence and nonpositive volatility",()=>{expect(buildResearchProposal(snapshot,all,now+8*86400000).status).toBe("withheld");expect(buildResearchProposal({...snapshot,candles:snapshot.candles.map(c=>({...c,h:100,l:100}))},all,now).status).toBe("withheld");});
  it("reverses stop and target correctly for a short scenario",()=>{const p=buildResearchProposal(snapshot,all.map(r=>({...r,report:{...report,outlook:"bearish"}})),now);expect(p.direction).toBe("short");expect(p.stopLoss).toBe(104);expect(p.takeProfit).toBe(92);});
  it("cannot parse execution permission or AI-supplied size",()=>{const p=buildResearchProposal(snapshot,all,now);expect(researchProposal.safeParse({...p,executionAllowed:true}).success).toBe(false);expect(researchProposal.safeParse({...p,positionSize:100}).success).toBe(false);});
});