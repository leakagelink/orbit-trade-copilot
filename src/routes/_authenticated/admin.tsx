import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ShieldCheck, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { toolkitHead, QueryError } from "@/components/toolkit-shared";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => toolkitHead("Admin panel", "Platform overview, users and support for Quantra administrators."),
  component: Admin,
});

export function useIsAdmin() {
  return useQuery({ queryKey: ["is-admin"], staleTime: 300_000, queryFn: async () => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return false;
    const [a, s] = await Promise.all([
      supabase.rpc("has_role", { _user_id: u.user.id, _role: "admin" }),
      supabase.rpc("has_role", { _user_id: u.user.id, _role: "super_admin" }),
    ]);
    return a.data === true || s.data === true;
  } });
}

const STATS: [string, string][] = [["users", "Total users"], ["new_7d", "New this week"], ["pro", "Pro"], ["elite", "Elite"], ["open_tickets", "Open support tickets"], ["trades_7d", "Trades this week"], ["live_bots", "Live bots running"], ["referrals", "Referrals"]];

function Admin() {
  const isAdmin = useIsAdmin();
  const [search, setSearch] = useState("");
  const overview = useQuery({ queryKey: ["admin", "overview"], enabled: isAdmin.data === true, queryFn: async () => {
    const r = await supabase.rpc("admin_overview");
    if (r.error) throw new Error("Overview unavailable");
    return r.data as Record<string, number>;
  } });
  const users = useQuery({ queryKey: ["admin", "users", search], enabled: isAdmin.data === true, queryFn: async () => {
    const r = await supabase.rpc("admin_users", { _search: search });
    if (r.error) throw new Error("Users unavailable");
    return r.data ?? [];
  } });

  if (isAdmin.isLoading) return null;
  if (!isAdmin.data) return <div><PageHeader title="Admin panel" /><p className="px-5 text-sm text-muted-foreground md:px-7">This area is only for platform administrators.</p></div>;

  return (
    <div>
      <PageHeader title="Admin panel" description="Read-only platform overview." actions={<Button variant="outline" asChild><Link to="/support"><ShieldCheck className="h-4 w-4" />Support tickets</Link></Button>} />
      <div className="space-y-6 px-5 pb-8 md:px-7">
        <QueryError error={overview.error ?? users.error} />
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
          {STATS.map(([k, l]) => <div key={k} className="bg-card p-4"><div className="text-xs text-muted-foreground">{l}</div><div className="mt-1 font-mono text-xl">{overview.data?.[k] ?? "—"}</div></div>)}
        </div>
        <div className="rounded-lg border bg-card">
          <div className="flex items-center gap-2 border-b p-3"><Search className="h-4 w-4 text-muted-foreground" /><Input placeholder="Search email or name" value={search} onChange={e => setSearch(e.target.value)} className="max-w-sm" /></div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="p-3">User</th><th className="p-3">Plan</th><th className="p-3">Joined</th><th className="p-3">Last sign-in</th><th className="p-3 text-right">Trades</th></tr></thead>
              <tbody className="divide-y">{(users.data ?? []).map(u => (
                <tr key={u.id}><td className="p-3"><div>{u.display_name || "—"}</div><div className="text-xs text-muted-foreground">{u.email}</div></td><td className="p-3"><Badge variant={u.plan === "free" ? "secondary" : "default"}>{u.plan}</Badge></td><td className="p-3 text-xs">{new Date(u.joined).toLocaleDateString()}</td><td className="p-3 text-xs">{u.last_sign_in ? new Date(u.last_sign_in).toLocaleString() : "—"}</td><td className="p-3 text-right font-mono">{u.trades}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
