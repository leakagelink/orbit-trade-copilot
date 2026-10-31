import {beforeEach,describe,it,expect,vi} from "vitest";
const mocks=vi.hoisted(()=>({allowed:true,revoked:null as string|null,valid:true}));
vi.mock("@tanstack/react-start",()=>({createMiddleware:()=>({server:(fn:unknown)=>fn})}));
vi.mock("@tanstack/react-start/server",()=>({getRequest:()=>({headers:new Headers({authorization:"Bearer test-token"})})}));
vi.mock("@supabase/supabase-js",()=>({createClient:()=>({auth:{getUser:async()=>({data:{user:mocks.valid?{id:"owner"}:null},error:null}),getClaims:async()=>({data:{claims:{session_id:"session-1"}}})},rpc:async()=>({data:mocks.allowed,error:null})})}));
vi.mock("@/integrations/supabase/client.server",()=>({supabaseAdmin:{from:()=>{const c={select:()=>c,eq:()=>c,maybeSingle:async()=>({data:{revoked_at:mocks.revoked},error:null})};return c;}}}));
import {accountSecurityMiddleware} from "@/lib/account-security";
const run=accountSecurityMiddleware as unknown as (args:{next:()=>Promise<string>})=>Promise<string>;
beforeEach(()=>{mocks.allowed=true;mocks.valid=true;mocks.revoked=null;vi.stubEnv("SUPABASE_URL","https://example.invalid");vi.stubEnv("SUPABASE_PUBLISHABLE_KEY","test-public-key");});
describe("workspace security boundary",()=>{
 it("denies an account that still needs its authenticator challenge",async()=>{mocks.allowed=false;await expect(run({next:async()=>"unsafe"})).rejects.toThrow("authenticator");});
 it("denies a revoked workspace session",async()=>{mocks.revoked="2026-10-31T00:00:00Z";await expect(run({next:async()=>"unsafe"})).rejects.toThrow("revoked");});
 it("denies expired sign-in even with stored claims",async()=>{mocks.valid=false;await expect(run({next:async()=>"unsafe"})).rejects.toThrow("Sign in again");});
 it("allows an authenticated verified unrevoked session",async()=>{await expect(run({next:async()=>"allowed"})).resolves.toBe("allowed");});
});