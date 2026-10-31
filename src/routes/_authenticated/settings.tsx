import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { SecurityPanel } from "@/components/security-panel";

const D = "Manage your profile, password and account details.";
export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Settings — Quantra" }, { property: "og:description", content: D }] }),
  component: Settings,
});

function Settings() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Sign in again");
      const user = u.user;
      const [p, r, s] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", user.id).single(),
        supabase.from("user_roles").select("role").eq("user_id", user.id),
        supabase.from("subscriptions").select("plan,status").eq("user_id", user.id).maybeSingle(),
      ]);
      if (p.error) throw new Error(p.error.message);
      return { email: user.email, profile: p.data, roles: r.data?.map((x) => x.role) ?? [], sub: s.data };
    },
  });
  const [busy, setBusy] = useState(false);

  async function saveProfile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!q.data) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const { error } = await supabase.from("profiles").update({
      display_name: String(f.get("display_name")).slice(0, 60),
      timezone: String(f.get("timezone")).slice(0, 60),
      base_currency: String(f.get("base_currency")).toUpperCase().slice(0, 10),
    }).eq("id", q.data.profile.id);
    setBusy(false);
    if (error) return void toast.error(error.message);
    toast.success("Profile saved");
    qc.invalidateQueries({ queryKey: ["settings"] });
  }

  async function changePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const password = String(f.get("password"));
    if (password.length < 8) return void toast.error("Password must be at least 8 characters");
    const { error } = await supabase.auth.updateUser({ password, current_password: String(f.get("current")) } as { password: string });
    if (error) return void toast.error(error.message);
    form.reset();
    toast.success("Password changed");
  }

  return (
    <div>
      <PageHeader title="Settings" description={D} />
      {!q.data ? <div className="p-6"><Skeleton className="h-64 max-w-xl" /></div> : (
        <div className="grid max-w-3xl gap-6 p-6">
          <SecurityPanel />
          <section className="rounded-lg border bg-card p-5">
            <h2 className="mb-1 font-medium">Account</h2>
            <p className="font-mono text-sm text-muted-foreground">{q.data.email}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {q.data.roles.map((r) => <Badge key={r} variant="secondary">{r.replace("_", " ")}</Badge>)}
              <Badge>{q.data.sub?.plan ?? "free"} plan</Badge>
            </div>
          </section>
          <form onSubmit={saveProfile} className="space-y-4 rounded-lg border bg-card p-5">
            <h2 className="font-medium">Profile</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5"><Label htmlFor="dn">Display name</Label><Input id="dn" name="display_name" defaultValue={q.data.profile.display_name ?? ""} /></div>
              <div className="space-y-1.5"><Label htmlFor="tz">Timezone</Label><Input id="tz" name="timezone" defaultValue={q.data.profile.timezone ?? "UTC"} /></div>
              <div className="space-y-1.5"><Label htmlFor="bc">Base currency</Label><Input id="bc" name="base_currency" defaultValue={q.data.profile.base_currency} /></div>
            </div>
            <Button disabled={busy}>Save profile</Button>
          </form>
          <form onSubmit={changePassword} className="space-y-4 rounded-lg border bg-card p-5">
            <h2 className="font-medium">Change password</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="cur">Current password</Label><Input id="cur" name="current" type="password" autoComplete="current-password" /></div>
              <div className="space-y-1.5"><Label htmlFor="np">New password</Label><Input id="np" name="password" type="password" minLength={8} required autoComplete="new-password" /></div>
            </div>
            <Button variant="outline">Update password</Button>
          </form>
        </div>
      )}
    </div>
  );
}
