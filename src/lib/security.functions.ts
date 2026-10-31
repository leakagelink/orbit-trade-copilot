import {createServerFn} from "@tanstack/react-start";
import {getRequest} from "@tanstack/react-start/server";
import {requireSupabaseAuth} from "@/integrations/supabase/auth-middleware";
import {z} from "zod";
export const recordSession=createServerFn({method:"POST"}).middleware([requireSupabaseAuth]).handler(async({context})=>{
 const id=context.claims.session_id;if(typeof id!=="string")throw new Error("Session unavailable");
 const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");
 const old=await db.from("workspace_sessions").select("id,revoked_at").eq("id",id).maybeSingle();if(old.error||old.data?.revoked_at)throw new Error("Session revoked");
 const ua=getRequest().headers.get("user-agent")??"Unknown browser";
 const device=(/Android/i.test(ua)?"Android":/iPhone|iPad/i.test(ua)?"iOS":/Windows/i.test(ua)?"Windows":/Macintosh/i.test(ua)?"Mac":"Desktop")+" · "+(/Edg\//.test(ua)?"Edge":/Chrome\//.test(ua)?"Chrome":/Firefox\//.test(ua)?"Firefox":/Safari\//.test(ua)?"Safari":"Browser");
 const r=old.data?await db.from("workspace_sessions").update({last_seen_at:new Date().toISOString()}).eq("id",id).is("revoked_at",null):await db.from("workspace_sessions").upsert({id,user_id:context.userId,device},{onConflict:"id",ignoreDuplicates:true});
 if(r.error)throw new Error("Could not record session");return {id};
});
export const revokeWorkspaceSession=createServerFn({method:"POST"}).middleware([requireSupabaseAuth]).inputValidator((i:unknown)=>z.object({id:z.string().uuid()}).parse(i)).handler(async({context,data})=>{
 if(data.id===context.claims.session_id)throw new Error("Use Sign out for this session");
 const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");
 const r=await db.from("workspace_sessions").update({revoked_at:new Date().toISOString()}).eq("id",data.id).eq("user_id",context.userId);if(r.error)throw new Error("Could not revoke session");return {ok:true};
});