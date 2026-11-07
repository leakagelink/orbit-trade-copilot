import { describe, expect, it, vi } from "vitest";
import { filterResearchNews } from "../lib/research-news";
import { runResearchStages, type AgentResult, type ResearchAgent } from "../lib/research-pipeline";
import { unavailableReport } from "../lib/research";
const now = Date.UTC(2026,10,7);
const item = { uuid: "story-1", title: "Company earnings", publisher: "Publisher", link: "https://finance.yahoo.com/news/story", providerPublishTime: now/1000-3600, relatedTickers: ["AAPL"] };
describe("Research news evidence", () => {
  it("keeps only explicitly ticker-related stories", () => { expect(filterResearchNews({news:[item]},"AAPL",now)).toHaveLength(1); expect(filterResearchNews({news:[item]},"TCS.NS",now)).toEqual([]); });
  it("rejects stale and future headlines", () => { expect(filterResearchNews({news:[{...item,providerPublishTime:now/1000-8*86400},{...item,providerPublishTime:now/1000+1}]},"AAPL",now)).toEqual([]); });
  it("rejects executable URLs and deduplicates stories", () => { expect(filterResearchNews({news:[{...item,link:"javascript:alert(1)"}]},"AAPL",now)).toEqual([]); expect(filterResearchNews({news:[item,item]},"AAPL",now)).toHaveLength(1); });
  it("never invents news from invalid responses", () => { expect(filterResearchNews("blocked","AAPL",now)).toEqual([]); });
});
describe("Research debate dependency safety", () => {
  const inputs = {market:{evidence:{close:100}},fundamentals:{evidence:[],missing:"No financial statements"},news:{evidence:[item]},sentiment:{evidence:[],missing:"Social provider unavailable"}};
  it("skips unsupported fundamentals and social inference and saves every report", async () => {
    const calls: ResearchAgent[] = [], saved: AgentResult[] = [];
    const result = await runResearchStages(inputs,async agent => { calls.push(agent); return {...unavailableReport("Evidence-based report"),outlook:"neutral"}; },async r => {saved.push(r);});
    expect(calls).toEqual(["market","news","bull","bear","manager"]); expect(saved).toHaveLength(7); expect(result.status).toBe("partial"); expect(result.results.find(r=>r.agent==="sentiment")?.status).toBe("unavailable");
  });
  it("does not synthesize when one side of the debate fails", async () => {
    const analyze = vi.fn(async (agent: ResearchAgent) => {if(agent==="bear")throw new Error("provider failure"); return unavailableReport("Evidence");});
    const result = await runResearchStages(inputs,analyze,async()=>{});
    expect(analyze.mock.calls.map(c=>c[0])).not.toContain("manager"); expect(result.results.find(r=>r.agent==="manager")?.status).toBe("unavailable");
  });
  it("runs no debate when every analyst lacks evidence", async () => {
    const analyze=vi.fn();const missing={evidence:[],missing:"Unavailable"};await runResearchStages({market:missing,fundamentals:missing,news:missing,sentiment:missing},analyze,async()=>{});expect(analyze).not.toHaveBeenCalled();
  });
  it("pauses dependent inference after an analyst failure", async () => {
    const analyze=vi.fn(async(agent:ResearchAgent)=>{if(agent==="market")throw new Error("unknown outcome");return unavailableReport("Evidence");});
    const result=await runResearchStages(inputs,analyze,async()=>{});
    expect(analyze.mock.calls.map(c=>c[0])).toEqual(["market","news"]);expect(result.results.find(r=>r.agent==="bull")?.status).toBe("unavailable");
  });
  it("drains sibling writes before reporting a storage failure", async () => {
    let newsSaved=false;
    await expect(runResearchStages(inputs,async()=>unavailableReport("Evidence"),async r=>{if(r.agent==="market")throw new Error("storage");if(r.agent==="news"){await new Promise(resolve=>setTimeout(resolve,10));newsSaved=true;}})).rejects.toThrow("storage");expect(newsSaved).toBe(true);
  });
});