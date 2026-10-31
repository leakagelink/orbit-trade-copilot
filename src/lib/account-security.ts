import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
export const accountSecurityMiddleware = createMiddleware({type:"function"}).server(async({next})=>{
  const token=getRequest().headers.get("authorization")?.replace(/^Bearer /,"");
  if(!token) return next();
  const {createClient}=await import("@supabase/supabase-js");
  const url=process.env["SUPABASE_URL"],key=process.env["SUPABASE_PUBLISHABLE_KEY"];
  if(!url||!key)throw new Error("Account security unavailable");
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:`Bearer ${token}`},fetch:(input,init)=>{const h=new Headers(init?.headers);if(key.startsWith("sb_")&&h.get("Authorization")===`Bearer ${key}`)h.delete("Authorization");h.set("apikey",key);return fetch(input,{...init,headers:h});}}});
  const {data,error}=await db.auth.getUser(token);if(error||!data.user)throw new Error("Sign in again");
  const allowed=await db.rpc("account_mfa_allowed");if(allowed.error||allowed.data!==true)throw new Error("Verify your authenticator code to continue");
  const claims=await db.auth.getClaims(token);const sessionId=claims.data?.claims.session_id;
  if(typeof sessionId==="string"){
    const {supabaseAdmin}=await import("@/integrations/supabase/client.server");
    const session=await supabaseAdmin.from("workspace_sessions").select("revoked_at").eq("id",sessionId).maybeSingle();
    if(session.error||session.data?.revoked_at)throw new Error("This workspace session was revoked. Sign in again.");
  }
  return next();
});