import {describe,it,expect} from "vitest";
import {supportMailSchema,mailboxUnread} from "@/lib/mailbox";
import {canOpen} from "@/lib/plans";
const mail={ticketId:null,subject:"Trade question",body:"Please check this trade",recipient:"support"};
describe("support-only mailbox",()=>{
 it("allows only the support recipient",()=>{expect(supportMailSchema.safeParse(mail).success).toBe(true);expect(supportMailSchema.safeParse({...mail,recipient:"other@example.com"}).success).toBe(false);});
 it("rejects attempts to select another user",()=>{expect(supportMailSchema.safeParse({...mail,userId:"other-user"}).success).toBe(false);});
 it("requires nonempty new messages and subjects",()=>{expect(supportMailSchema.safeParse({...mail,subject:" "}).success).toBe(false);expect(supportMailSchema.safeParse({...mail,body:" "}).success).toBe(false);});
 it("detects unread support replies not user messages",()=>{expect(mailboxUnread("support","2026-10-31T10:00:00Z","2026-10-31T09:00:00Z")).toBe(true);expect(mailboxUnread("user","2026-10-31T10:00:00Z",null)).toBe(false);expect(mailboxUnread("support","2026-10-31T10:00:00Z","2026-10-31T11:00:00Z")).toBe(false);});
 it("keeps support mailbox available on the Free plan",()=>{expect(canOpen("/mailbox","free")).toBe(true);});
});