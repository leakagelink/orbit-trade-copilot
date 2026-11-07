import {expect,it} from "vitest";
import {researchCapacity,researchRunLimit} from "../lib/research-allowance";
it("uses bounded default research run allowances",()=>{expect(researchRunLimit(false)).toBe(10);expect(researchRunLimit(true)).toBe(30);});
it("blocks another attempt once all run slots are consumed",()=>{expect(researchCapacity(10,10)).toBe(0);expect(researchCapacity(30,30)).toBe(0);});
it("counts failed and unknown attempts as consumed slots",()=>{expect(researchCapacity(9,10)).toBe(1);expect(researchCapacity(11,10)).toBe(0);});
it("rejects corrupt quota inputs",()=>{expect(()=>researchCapacity(-1,10)).toThrow();expect(()=>researchCapacity(1,0)).toThrow();});