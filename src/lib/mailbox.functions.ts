import {createServerFn} from "@tanstack/react-start";
import {requireSupabaseAuth} from "@/integrations/supabase/auth-middleware";
import {supportMailSchema} from "./mailbox";
import {z} from "zod";
export const sendSupportMail=createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((i:unknown)=>supportMailSchema.parse(i)).handler(async({context,data})=>{
 const r=await context.supabase.rpc("mailbox_send",{_ticket:data.ticketId,_subject:data.subject,_body:data.body,_recipient:data.recipient});
 if(r.error)throw new Error("Unable to send: conversations are restricted to you and support");return {id:r.data};
});
export const getMailbox=createServerFn({method:"POST"}).middleware([requireSupabaseAuth]).handler(async({context})=>{
 const db=context.supabase;
 const role=await db.rpc("is_support_operator");if(role.error)throw new Error("Mailbox unavailable");
 const [tickets,states,drafts]=await Promise.all([db.from("support_tickets").select("*").order("created_at",{ascending:false}).limit(300),db.from("mailbox_states").select("*").eq("user_id",context.userId),db.from("support_drafts").select("*").order("updated_at",{ascending:false})]);
 if(tickets.error||states.error||drafts.error)throw new Error("Mailbox unavailable");
 const ids=tickets.data.map(t=>t.id);
 const messages=[];
 if(ids.length){for(let start=0;;start+=500){const r=await db.from("support_messages").select("*").in("ticket_id",ids).order("created_at").order("id").range(start,start+499);if(r.error)throw new Error("Messages unavailable");messages.push(...r.data);if(r.data.length<500)break;}}
 return {userId:context.userId,operator:role.data===true,tickets:tickets.data,states:states.data,drafts:drafts.data,messages};
});
export const setMailboxState=createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((i:unknown)=>z.object({ticketId:z.string().uuid(),starred:z.boolean().optional(),folder:z.enum(["inbox","archive","trash"]).optional(),read:z.boolean().optional()}).parse(i)).handler(async({context,data})=>{
 const existing=await context.supabase.from("mailbox_states").select("*").eq("ticket_id",data.ticketId).eq("user_id",context.userId).maybeSingle();if(existing.error)throw new Error("Could not update conversation");
 const r=await context.supabase.from("mailbox_states").upsert({ticket_id:data.ticketId,user_id:context.userId,starred:data.starred??existing.data?.starred??false,folder:data.folder??existing.data?.folder??"inbox",read_at:data.read===undefined?(existing.data?.read_at??null):data.read?new Date().toISOString():null});
 if(r.error)throw new Error("Could not update conversation");return {ok:true};
});
export const saveMailDraft=createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((i:unknown)=>z.object({id:z.string().uuid().nullable(),subject:z.string().max(160),body:z.string().max(4000)}).parse(i)).handler(async({context,data})=>{
 const entry={user_id:context.userId,subject:data.subject,body:data.body,updated_at:new Date().toISOString()};
 const r=data.id?await context.supabase.from("support_drafts").update(entry).eq("id",data.id).eq("user_id",context.userId).select("id").single():await context.supabase.from("support_drafts").insert(entry).select("id").single();
 if(r.error)throw new Error("Could not save draft");return {id:r.data.id};
});
export const deleteMailDraft=createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((i:unknown)=>z.object({id:z.string().uuid()}).parse(i)).handler(async({context,data})=>{const r=await context.supabase.from("support_drafts").delete().eq("id",data.id).eq("user_id",context.userId);if(r.error)throw new Error("Could not delete draft");return {ok:true};});