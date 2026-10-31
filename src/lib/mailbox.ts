import {z} from "zod";
export const supportMailSchema=z.object({ticketId:z.string().uuid().nullable(),subject:z.string().trim().max(160),body:z.string().trim().min(1).max(4000),recipient:z.literal("support")}).strict().refine(d=>d.ticketId!==null||d.subject.length>0,"Subject is required");
export type SupportMail=z.infer<typeof supportMailSchema>;
export function mailboxUnread(lastSender:string,lastAt:string,readAt:string|null){return lastSender==="support"&&(!readAt||Date.parse(lastAt)>Date.parse(readAt));}