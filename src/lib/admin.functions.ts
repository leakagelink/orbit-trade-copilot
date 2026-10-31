import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: any; userId: string };

/** Verifies the caller is an admin (and passes two-step checks) before any privileged work. */
async function requireAdmin(ctx: Ctx) {
  const [a, s, mfa] = await Promise.all([
    ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "admin" }),
    ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "super_admin" }),
    ctx.supabase.rpc("account_mfa_allowed"),
  ]);
  if (mfa.data !== true) throw new Error("Complete two-step verification first");
  if (a.data !== true && s.data !== true) throw new Error("Admins only");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return { db: supabaseAdmin, isSuper: s.data === true };
}

async function audit(db: any, actor: string, action: string, entityType: string, entityId: string | null, details: Record<string, unknown>) {
  await db.from("audit_logs").insert({ user_id: actor, action, entity_type: entityType, entity_id: entityId, details });
}

const uid = z.string().uuid();

export const adminUserDetail = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ userId: uid }).parse(i))
  .handler(async ({ context, data }) => {
    const { db } = await requireAdmin(context);
    const [u, roles, sub, wallet, bots, pos] = await Promise.all([
      db.auth.admin.getUserById(data.userId),
      db.from("user_roles").select("role").eq("user_id", data.userId),
      db.from("subscriptions").select("plan,status,current_period_end,provider").eq("user_id", data.userId).maybeSingle(),
      db.from("wallets").select("balance,currency").eq("user_id", data.userId).maybeSingle(),
      db.from("trading_bots").select("id,name,trading_pair,mode,status").eq("user_id", data.userId).order("created_at", { ascending: false }).limit(50),
      db.from("positions").select("id", { count: "exact", head: true }).eq("user_id", data.userId).eq("is_open", true),
    ]);
    const user = u.data?.user;
    return {
      email: user?.email ?? "",
      bannedUntil: (user as any)?.banned_until ?? null,
      roles: (roles.data ?? []).map((r: any) => r.role as string),
      subscription: sub.data,
      wallet: wallet.data,
      bots: bots.data ?? [],
      openPositions: pos.count ?? 0,
    };
  });

export const adminSetPlan = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ userId: uid, plan: z.enum(["free", "pro", "elite"]), days: z.number().int().min(0).max(3650) }).parse(i))
  .handler(async ({ context, data }) => {
    const { db } = await requireAdmin(context);
    const end = data.plan === "free" || data.days === 0 ? null : new Date(Date.now() + data.days * 86_400_000).toISOString();
    const { error } = await db.from("subscriptions").upsert({ user_id: data.userId, plan: data.plan, status: "active", current_period_end: end, provider: "admin" }, { onConflict: "user_id" });
    if (error) throw new Error("Couldn't change plan");
    await audit(db, context.userId, "admin.set_plan", "user", data.userId, { plan: data.plan, days: data.days });
    return { ok: true };
  });

export const adminSetRole = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ userId: uid, role: z.enum(["admin", "super_admin"]), grant: z.boolean() }).parse(i))
  .handler(async ({ context, data }) => {
    const { db, isSuper } = await requireAdmin(context);
    if (data.role === "super_admin" && !isSuper) throw new Error("Only a super admin can change super admin access");
    if (data.userId === context.userId && !data.grant) throw new Error("You can't remove your own admin access");
    const r = data.grant
      ? await db.from("user_roles").upsert({ user_id: data.userId, role: data.role }, { onConflict: "user_id,role" })
      : await db.from("user_roles").delete().eq("user_id", data.userId).eq("role", data.role);
    if (r.error) throw new Error("Couldn't update role");
    await audit(db, context.userId, data.grant ? "admin.grant_role" : "admin.revoke_role", "user", data.userId, { role: data.role });
    return { ok: true };
  });

export const adminSetBan = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ userId: uid, banned: z.boolean() }).parse(i))
  .handler(async ({ context, data }) => {
    const { db } = await requireAdmin(context);
    if (data.userId === context.userId) throw new Error("You can't suspend yourself");
    const { error } = await db.auth.admin.updateUserById(data.userId, { ban_duration: data.banned ? "876000h" : "none" });
    if (error) throw new Error("Couldn't update account");
    if (data.banned) await db.from("trading_bots").update({ status: "stopped", status_reason: "Account suspended by admin" }).eq("user_id", data.userId).in("status", ["running", "paper_trading"]);
    await audit(db, context.userId, data.banned ? "admin.suspend" : "admin.unsuspend", "user", data.userId, {});
    return { ok: true };
  });

export const adminDeleteUser = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ userId: uid, confirm: z.literal("DELETE") }).parse(i))
  .handler(async ({ context, data }) => {
    const { db, isSuper } = await requireAdmin(context);
    if (!isSuper) throw new Error("Only a super admin can delete accounts");
    if (data.userId === context.userId) throw new Error("You can't delete your own account here");
    const open = await db.from("positions").select("id", { count: "exact", head: true }).eq("user_id", data.userId).eq("is_open", true).eq("mode", "live");
    if ((open.count ?? 0) > 0) throw new Error("This user has open live positions — close them first");
    await db.from("trading_bots").update({ status: "stopped", status_reason: "Account deleted" }).eq("user_id", data.userId);
    const { error } = await db.auth.admin.deleteUser(data.userId);
    if (error) throw new Error("Couldn't delete account");
    await audit(db, context.userId, "admin.delete_user", "user", data.userId, {});
    return { ok: true };
  });

export const adminAdjustWallet = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ userId: uid, amount: z.number().finite().refine(v => v !== 0 && Math.abs(v) <= 10_000_000), note: z.string().trim().min(3).max(200) }).parse(i))
  .handler(async ({ context, data }) => {
    const { db } = await requireAdmin(context);
    const { data: balance, error } = await db.rpc("wallet_apply", { _user: data.userId, _amount: data.amount, _kind: data.amount > 0 ? "deposit" : "withdrawal", _position: null as unknown as string, _note: `Admin: ${data.note}` });
    if (error) throw new Error(error.message.includes("insufficient") ? "Balance can't go below zero" : "Couldn't adjust demo wallet");
    await audit(db, context.userId, "admin.wallet_adjust", "user", data.userId, { amount: data.amount, note: data.note });
    return { balance };
  });

export const adminStopBot = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ botId: uid }).parse(i))
  .handler(async ({ context, data }) => {
    const { db } = await requireAdmin(context);
    const { error } = await db.from("trading_bots").update({ status: "stopped", status_reason: "Stopped by admin" }).eq("id", data.botId);
    if (error) throw new Error("Couldn't stop bot");
    await audit(db, context.userId, "admin.stop_bot", "bot", data.botId, {});
    return { ok: true };
  });

export const adminListContent = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { db } = await requireAdmin(context);
    const [refs, strats, bots, logs] = await Promise.all([
      db.from("referrals").select("id,referrer_id,referred_id,reward_status,created_at").order("created_at", { ascending: false }).limit(200),
      db.from("strategies").select("id,name,user_id,clone_count,published_at").eq("is_published", true).order("published_at", { ascending: false }).limit(200),
      db.from("trading_bots").select("id,name,user_id,trading_pair,mode,status,last_heartbeat_at").in("status", ["running", "paper_trading"]).order("updated_at", { ascending: false }).limit(200),
      db.from("audit_logs").select("id,user_id,action,entity_type,entity_id,details,created_at").like("action", "admin.%").order("created_at", { ascending: false }).limit(100),
    ]);
    const ids = new Set<string>();
    for (const r of refs.data ?? []) { ids.add(r.referrer_id); ids.add(r.referred_id); }
    for (const r of [...(strats.data ?? []), ...(bots.data ?? [])]) ids.add(r.user_id);
    for (const r of logs.data ?? []) { if (r.user_id) ids.add(r.user_id); if (r.entity_type === "user" && r.entity_id) ids.add(r.entity_id); }
    const names: Record<string, string> = {};
    if (ids.size) {
      const p = await db.from("profiles").select("id,display_name").in("id", [...ids]);
      for (const r of p.data ?? []) names[r.id] = r.display_name || r.id.slice(0, 8);
    }
    return { referrals: refs.data ?? [], strategies: strats.data ?? [], bots: bots.data ?? [], logs: logs.data ?? [], names };
  });

export const adminSetReferral = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: uid, status: z.enum(["pending", "granted", "rejected"]) }).parse(i))
  .handler(async ({ context, data }) => {
    const { db } = await requireAdmin(context);
    const { error } = await db.from("referrals").update({ reward_status: data.status }).eq("id", data.id);
    if (error) throw new Error("Couldn't update referral");
    await audit(db, context.userId, "admin.referral", "referral", data.id, { status: data.status });
    return { ok: true };
  });

export const adminModerateStrategy = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: uid }).parse(i))
  .handler(async ({ context, data }) => {
    const { db } = await requireAdmin(context);
    const { error } = await db.from("strategies").update({ is_published: false, published_at: null }).eq("id", data.id);
    if (error) throw new Error("Couldn't unpublish");
    await audit(db, context.userId, "admin.unpublish_strategy", "strategy", data.id, {});
    return { ok: true };
  });

export const adminNotifyUser = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ userId: uid, title: z.string().trim().min(3).max(120), body: z.string().trim().min(1).max(1000) }).parse(i))
  .handler(async ({ context, data }) => {
    const { db } = await requireAdmin(context);
    const { error } = await db.from("notifications").insert({ user_id: data.userId, title: data.title, body: data.body, kind: "system" });
    if (error) throw new Error("Couldn't send notice");
    await audit(db, context.userId, "admin.notify", "user", data.userId, { title: data.title });
    return { ok: true };
  });
