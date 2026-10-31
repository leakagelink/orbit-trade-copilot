import {beforeEach,describe,it,expect,vi} from "vitest";
const mocks=vi.hoisted(()=>({fetch:vi.fn(),rpc:vi.fn(),rows:[] as Array<Record<string,unknown>>,updates:[] as Array<Record<string,unknown>>}));
vi.mock("@/lib/exchange-adapters.server",()=>({fetchCandles:mocks.fetch}));
vi.mock("@/integrations/supabase/client.server",()=>({supabaseAdmin:{rpc:mocks.rpc,from:()=>{
 const chain={select:()=>chain,eq:()=>chain,order:()=>chain,limit:()=>chain,in:()=>chain,update:(row:Record<string,unknown>)=>{mocks.updates.push(row);return chain;},then:(resolve:(v:unknown)=>unknown)=>Promise.resolve(resolve({data:mocks.rows,error:null}))};return chain;
}}}));
import {evaluateAlerts} from "@/lib/alerts.server";
beforeEach(()=>{vi.clearAllMocks();mocks.updates=[];mocks.rows=[{id:"alert-1",user_id:"owner",symbol:"BTC/USDT",direction:"above",target:100}];mocks.fetch.mockResolvedValue([{t:Date.now(),c:110}]);mocks.rpc.mockResolvedValue({data:true,error:null});});
describe("durable alert evaluation",()=>{
 it("uses an atomic database claim before counting a delivered alert",async()=>{expect((await evaluateAlerts("owner")).triggered).toBe(1);expect(mocks.rpc).toHaveBeenCalledWith("trigger_price_alert",{_id:"alert-1",_price:110});mocks.rpc.mockResolvedValue({data:false,error:null});expect((await evaluateAlerts("owner")).triggered).toBe(0);});
 it("does not trigger on stale or unavailable prices",async()=>{mocks.fetch.mockResolvedValue([{t:Date.now()-240000,c:110}]);expect((await evaluateAlerts("owner")).failed).toBe(1);expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.updates[0]).toHaveProperty("last_error");});
 it("shares one fetch across alerts for the same market",async()=>{mocks.rows.push({...mocks.rows[0],id:"alert-2"});await evaluateAlerts();expect(mocks.fetch).toHaveBeenCalledTimes(1);expect(mocks.rpc).toHaveBeenCalledTimes(2);});
});