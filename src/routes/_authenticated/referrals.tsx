import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Copy, Gift } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { toolkitHead, QueryError } from "@/components/toolkit-shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/referrals")({
  head: () => toolkitHead("Invite friends", "Share your Quantra invite link and track friends who join."),
  component: Referrals,
});

function Referrals() {
  const q = useQuery({
    queryKey: ["referrals"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      const id = u.user?.id;
      const [p, r] = await Promise.all([
        supabase.from("profiles").select("referral_code").eq("id", id!).maybeSingle(),
        supabase.from("referrals").select("id, reward_status, created_at, referrer_id").eq("referrer_id", id!).order("created_at", { ascending: false }),
      ]);
      if (p.error || r.error) throw new Error("Invites unavailable");
      return { code: p.data?.referral_code ?? "", list: r.data ?? [] };
    },
  });
  const link = q.data?.code ? `${typeof window !== "undefined" ? window.location.origin : ""}/auth?mode=register&ref=${q.data.code}` : "";
  return (
    <div>
      <PageHeader title="Invite friends" description="Friends who sign up within 7 days using your link are counted here." />
      <div className="space-y-6 px-5 pb-8 md:px-7">
        <QueryError error={q.error} />
        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2"><Gift className="h-5 w-5 text-primary" /><h2 className="font-semibold">Your invite link</h2></div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Input readOnly value={link} aria-label="Invite link" className="font-mono text-xs" />
            <Button disabled={!link} onClick={() => { navigator.clipboard.writeText(link); toast.success("Link copied"); }}><Copy className="h-4 w-4" />Copy</Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Code: <span className="font-mono">{q.data?.code ?? "—"}</span>. Rewards are reviewed by our team and are not automatic.</p>
        </div>
        <div className="rounded-lg border bg-card">
          <div className="border-b p-4 text-sm font-medium">Friends joined · {q.data?.list.length ?? 0}</div>
          {(q.data?.list ?? []).length === 0 ? <p className="p-4 text-sm text-muted-foreground">No one has joined with your link yet.</p> :
            <ul className="divide-y">{q.data!.list.map((r, i) => <li key={r.id} className="flex items-center justify-between p-4 text-sm"><span>Friend #{q.data!.list.length - i} · {new Date(r.created_at).toLocaleDateString()}</span><Badge variant={r.reward_status === "granted" ? "default" : "secondary"}>{r.reward_status === "granted" ? "Reward given" : r.reward_status === "rejected" ? "Not eligible" : "Under review"}</Badge></li>)}</ul>}
        </div>
      </div>
    </div>
  );
}
