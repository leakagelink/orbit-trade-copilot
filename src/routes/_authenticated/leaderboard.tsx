import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trophy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { toolkitHead, QueryError } from "@/components/toolkit-shared";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/leaderboard")({
  head: () => toolkitHead("Demo leaderboard", "Top paper-trading results over the last 30 days from traders who opted in."),
  component: Leaderboard,
});

function Leaderboard() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["leaderboard", "me"], queryFn: async () => {
    const { data: u } = await supabase.auth.getUser();
    const r = await supabase.from("profiles").select("id, leaderboard_opt_in").eq("id", u.user!.id).maybeSingle();
    return r.data;
  } });
  const board = useQuery({ queryKey: ["leaderboard", "rows"], queryFn: async () => {
    const r = await supabase.rpc("demo_leaderboard");
    if (r.error) throw new Error("Leaderboard unavailable");
    return r.data ?? [];
  } });
  async function toggle(v: boolean) {
    if (!me.data) return;
    await supabase.from("profiles").update({ leaderboard_opt_in: v }).eq("id", me.data.id);
    qc.invalidateQueries({ queryKey: ["leaderboard"] });
  }
  return (
    <div>
      <PageHeader title="Demo leaderboard" description="Paper trades only, last 30 days, net of fees. No real money or prizes." />
      <div className="space-y-6 px-5 pb-8 md:px-7">
        <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
          <Switch id="optin" checked={me.data?.leaderboard_opt_in ?? false} onCheckedChange={toggle} disabled={!me.data} />
          <Label htmlFor="optin" className="text-sm">Show my display name and demo results on the leaderboard</Label>
        </div>
        <QueryError error={board.error} />
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="p-3">#</th><th className="p-3">Trader</th><th className="p-3 text-right">Net PnL</th><th className="p-3 text-right">Trades</th><th className="p-3 text-right">Win rate</th></tr></thead>
            <tbody className="divide-y">
              {(board.data ?? []).map(r => (
                <tr key={`${r.rank}-${r.trader}`} className={r.is_me ? "bg-accent/50" : ""}>
                  <td className="p-3 font-mono">{Number(r.rank) <= 3 ? <Trophy className="h-4 w-4 text-primary" /> : r.rank}</td>
                  <td className="p-3">{r.trader}{r.is_me && " (you)"}</td>
                  <td className={`p-3 text-right font-mono ${Number(r.net_pnl) >= 0 ? "text-gain" : "text-loss"}`}>{Number(r.net_pnl).toFixed(2)}</td>
                  <td className="p-3 text-right font-mono">{r.trades}</td>
                  <td className="p-3 text-right font-mono">{Number(r.win_rate).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {board.data?.length === 0 && <p className="p-4 text-sm text-muted-foreground">No ranked traders yet. Opt in and close at least 3 paper trades to appear.</p>}
        </div>
      </div>
    </div>
  );
}
