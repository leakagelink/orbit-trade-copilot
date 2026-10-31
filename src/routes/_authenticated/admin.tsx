import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ShieldCheck, Search } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { toolkitHead, QueryError } from "@/components/toolkit-shared";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useIsAdmin } from "@/hooks/use-is-admin";
import {
  adminUserDetail, adminSetPlan, adminSetRole, adminSetBan, adminDeleteUser, adminAdjustWallet,
  adminStopBot, adminListContent, adminSetReferral, adminModerateStrategy, adminNotifyUser,
} from "@/lib/admin.functions";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => toolkitHead("Admin panel", "Manage Quantra users, plans, roles, wallets, bots, referrals and marketplace content."),
  component: Admin,
});

const STATS: [string, string][] = [["users", "Total users"], ["new_7d", "New this week"], ["pro", "Pro"], ["elite", "Elite"], ["open_tickets", "Open support tickets"], ["trades_7d", "Trades this week"], ["live_bots", "Live bots running"], ["referrals", "Referrals"]];

function useAction() {
  const qc = useQueryClient();
  return async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.success(ok); qc.invalidateQueries({ queryKey: ["admin"] }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Action failed"); }
  };
}

function Admin() {
  const isAdmin = useIsAdmin();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const overview = useQuery({ queryKey: ["admin", "overview"], enabled: isAdmin.data === true, queryFn: async () => {
    const r = await supabase.rpc("admin_overview"); if (r.error) throw new Error("Overview unavailable"); return r.data as Record<string, number>;
  } });
  const users = useQuery({ queryKey: ["admin", "users", search], enabled: isAdmin.data === true, queryFn: async () => {
    const r = await supabase.rpc("admin_users", { _search: search }); if (r.error) throw new Error("Users unavailable"); return r.data ?? [];
  } });

  if (isAdmin.isLoading) return null;
  if (!isAdmin.data) return <div><PageHeader title="Admin panel" /><p className="px-5 text-sm text-muted-foreground md:px-7">This area is only for platform administrators.</p></div>;

  return (
    <div>
      <PageHeader title="Admin panel" description="Every change is recorded in the admin activity log." actions={<Button variant="outline" asChild><Link to="/support"><ShieldCheck className="h-4 w-4" />Support tickets</Link></Button>} />
      <div className="space-y-6 px-5 pb-8 md:px-7">
        <QueryError error={overview.error ?? users.error} />
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
          {STATS.map(([k, l]) => <div key={k} className="bg-card p-4"><div className="text-xs text-muted-foreground">{l}</div><div className="mt-1 font-mono text-xl">{overview.data?.[k] ?? "—"}</div></div>)}
        </div>
        <Tabs defaultValue="users">
          <TabsList className="flex h-auto flex-wrap"><TabsTrigger value="users">Users</TabsTrigger><TabsTrigger value="bots">Running bots</TabsTrigger><TabsTrigger value="referrals">Referrals</TabsTrigger><TabsTrigger value="strategies">Marketplace</TabsTrigger><TabsTrigger value="log">Activity log</TabsTrigger></TabsList>
          <TabsContent value="users">
            <div className="rounded-lg border bg-card">
              <div className="flex items-center gap-2 border-b p-3"><Search className="h-4 w-4 text-muted-foreground" /><Input placeholder="Search email or name" value={search} onChange={e => setSearch(e.target.value)} className="max-w-sm" /></div>
              <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="p-3">User</th><th className="p-3">Plan</th><th className="p-3">Joined</th><th className="p-3 text-right">Trades</th><th className="p-3" /></tr></thead>
                <tbody className="divide-y">{(users.data ?? []).map(u => (
                  <tr key={u.id}><td className="p-3"><div>{u.display_name || "—"}</div><div className="text-xs text-muted-foreground">{u.email}</div></td><td className="p-3"><Badge variant={u.plan === "free" ? "secondary" : "default"}>{u.plan}</Badge></td><td className="p-3 text-xs">{new Date(u.joined).toLocaleDateString()}</td><td className="p-3 text-right font-mono">{u.trades}</td><td className="p-3 text-right"><Button size="sm" variant="outline" onClick={() => setSelected(u.id)}>Manage</Button></td></tr>
                ))}</tbody>
              </table></div>
            </div>
          </TabsContent>
          <ContentTabs />
        </Tabs>
      </div>
      {selected && <UserDialog userId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ContentTabs() {
  const list = useServerFn(adminListContent), stop = useServerFn(adminStopBot), ref = useServerFn(adminSetReferral), mod = useServerFn(adminModerateStrategy);
  const act = useAction();
  const q = useQuery({ queryKey: ["admin", "content"], queryFn: () => list() });
  const n = (id: string | null) => (id && q.data?.names[id]) || id?.slice(0, 8) || "—";
  const empty = <p className="p-4 text-sm text-muted-foreground">Nothing here.</p>;
  const box = "divide-y rounded-lg border bg-card";
  return (<>
    <TabsContent value="bots"><QueryError error={q.error} /><ul className={box}>{q.data?.bots.length ? q.data.bots.map(b => <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"><span>{b.name} · {b.trading_pair} · {n(b.user_id)} <Badge variant={b.mode === "live" ? "destructive" : "secondary"}>{b.mode}</Badge></span><Button size="sm" variant="outline" onClick={() => act(() => stop({ data: { botId: b.id } }), "Bot stopped")}>Stop</Button></li>) : empty}</ul></TabsContent>
    <TabsContent value="referrals"><ul className={box}>{q.data?.referrals.length ? q.data.referrals.map(r => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"><span>{n(r.referrer_id)} invited {n(r.referred_id)} · {new Date(r.created_at).toLocaleDateString()}</span><Select value={r.reward_status} onValueChange={v => act(() => ref({ data: { id: r.id, status: v as "pending" | "granted" | "rejected" } }), "Referral updated")}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pending">Under review</SelectItem><SelectItem value="granted">Reward given</SelectItem><SelectItem value="rejected">Not eligible</SelectItem></SelectContent></Select></li>) : empty}</ul><p className="mt-2 text-xs text-muted-foreground">To give a free Pro reward, open the inviter in Users and set their plan.</p></TabsContent>
    <TabsContent value="strategies"><ul className={box}>{q.data?.strategies.length ? q.data.strategies.map(s => <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"><span>{s.name} · by {n(s.user_id)} · {s.clone_count} copies</span><Button size="sm" variant="outline" onClick={() => act(() => mod({ data: { id: s.id } }), "Removed from marketplace")}>Unpublish</Button></li>) : empty}</ul></TabsContent>
    <TabsContent value="log"><ul className={box}>{q.data?.logs.length ? q.data.logs.map(l => <li key={l.id} className="p-3 text-sm"><span className="font-mono text-xs text-muted-foreground">{new Date(l.created_at).toLocaleString()}</span> · {n(l.user_id)} · {l.action.replace("admin.", "").replace(/_/g, " ")}{l.entity_type === "user" ? ` → ${n(l.entity_id)}` : ""} <span className="text-xs text-muted-foreground">{JSON.stringify(l.details) !== "{}" ? JSON.stringify(l.details) : ""}</span></li>) : empty}</ul></TabsContent>
  </>);
}

function UserDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const detail = useServerFn(adminUserDetail), setPlan = useServerFn(adminSetPlan), setRole = useServerFn(adminSetRole), ban = useServerFn(adminSetBan),
    del = useServerFn(adminDeleteUser), wallet = useServerFn(adminAdjustWallet), stop = useServerFn(adminStopBot), notify = useServerFn(adminNotifyUser);
  const act = useAction();
  const q = useQuery({ queryKey: ["admin", "user", userId], queryFn: () => detail({ data: { userId } }) });
  const [plan, setPlanV] = useState<"free" | "pro" | "elite">("pro"), [days, setDays] = useState("30");
  const [amount, setAmount] = useState(""), [note, setNote] = useState("");
  const [title, setTitle] = useState(""), [body, setBody] = useState(""), [confirm, setConfirm] = useState("");
  const d = q.data;
  const isAdm = d?.roles.includes("admin"), isSup = d?.roles.includes("super_admin");
  const section = "space-y-2 rounded-md border p-3";
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>{d?.email ?? "Loading…"}</DialogTitle></DialogHeader>
        <QueryError error={q.error} />
        {d && <div className="space-y-4 text-sm">
          <div className="flex flex-wrap gap-2"><Badge>{d.subscription?.plan ?? "free"}</Badge>{d.roles.map(r => <Badge key={r} variant="outline">{r}</Badge>)}{d.bannedUntil && <Badge variant="destructive">Suspended</Badge>}<Badge variant="secondary">Demo wallet {Number(d.wallet?.balance ?? 0).toFixed(2)} USD</Badge><Badge variant="secondary">{d.openPositions} open positions</Badge></div>
          <div className={section}><div className="font-medium">Plan</div><div className="flex flex-wrap gap-2">
            <Select value={plan} onValueChange={v => setPlanV(v as typeof plan)}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="free">Free</SelectItem><SelectItem value="pro">Pro</SelectItem><SelectItem value="elite">Elite</SelectItem></SelectContent></Select>
            <Input className="w-28" type="number" min={0} value={days} onChange={e => setDays(e.target.value)} aria-label="Days (0 = no end)" />
            <Button size="sm" onClick={() => act(() => setPlan({ data: { userId, plan, days: Math.max(0, Math.floor(Number(days) || 0)) } }), "Plan updated")}>Set plan</Button></div>
            <p className="text-xs text-muted-foreground">Days = length of access; 0 means no end date.</p></div>
          <div className={section}><div className="font-medium">Demo wallet adjustment</div><div className="flex flex-wrap gap-2"><Input className="w-32" type="number" placeholder="+500 or -200" value={amount} onChange={e => setAmount(e.target.value)} /><Input className="min-w-0 flex-1" placeholder="Reason" value={note} onChange={e => setNote(e.target.value)} /><Button size="sm" onClick={() => act(() => wallet({ data: { userId, amount: Number(amount), note } }), "Wallet adjusted")}>Apply</Button></div></div>
          <div className={section}><div className="font-medium">Send notice to user</div><Input placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} /><Textarea placeholder="Message" value={body} onChange={e => setBody(e.target.value)} /><Button size="sm" onClick={() => act(() => notify({ data: { userId, title, body } }), "Notice sent")}>Send</Button></div>
          {d.bots.length > 0 && <div className={section}><div className="font-medium">Bots</div>{d.bots.map((b: any) => <div key={b.id} className="flex items-center justify-between gap-2"><span>{b.name} · {b.trading_pair} · {b.mode} · {b.status}</span>{["running", "paper_trading"].includes(b.status) && <Button size="sm" variant="outline" onClick={() => act(() => stop({ data: { botId: b.id } }), "Bot stopped")}>Stop</Button>}</div>)}</div>}
          <div className={section}><div className="font-medium">Access</div><div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => act(() => setRole({ data: { userId, role: "admin", grant: !isAdm } }), "Role updated")}>{isAdm ? "Remove admin" : "Make admin"}</Button>
            <Button size="sm" variant="outline" onClick={() => act(() => setRole({ data: { userId, role: "super_admin", grant: !isSup } }), "Role updated")}>{isSup ? "Remove super admin" : "Make super admin"}</Button>
            <Button size="sm" variant={d.bannedUntil ? "outline" : "destructive"} onClick={() => act(() => ban({ data: { userId, banned: !d.bannedUntil } }), d.bannedUntil ? "Account restored" : "Account suspended")}>{d.bannedUntil ? "Restore account" : "Suspend account"}</Button></div>
            <p className="text-xs text-muted-foreground">Suspending blocks sign-in and stops the user's running bots.</p></div>
          <div className="space-y-2 rounded-md border border-destructive/50 p-3"><div className="font-medium text-destructive">Delete account (super admin)</div><p className="text-xs text-muted-foreground">Permanent. Blocked while the user has open live positions. Type DELETE to confirm.</p><div className="flex gap-2"><Input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="DELETE" /><Button size="sm" variant="destructive" disabled={confirm !== "DELETE"} onClick={() => act(async () => { await del({ data: { userId, confirm: "DELETE" } }); onClose(); }, "Account deleted")}>Delete</Button></div></div>
        </div>}
      </DialogContent>
    </Dialog>
  );
}
