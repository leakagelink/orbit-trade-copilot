import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowDownToLine, ArrowUpFromLine, Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { walletDeposit, walletWithdraw, WALLET_MAX_DEPOSIT } from "@/lib/wallet.functions";
import { fmtMoney } from "@/lib/metrics";

const D = "Your demo wallet: deposit, withdraw and fund manual trades.";
export const Route = createFileRoute("/_authenticated/wallet")({
  head: () => ({ meta: [{ title: "Wallet — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Wallet — Quantra" }, { property: "og:description", content: D }] }),
  component: WalletPage,
});

const KIND: Record<string, string> = { deposit: "Deposit", withdrawal: "Withdrawal", trade_open: "Trade opened", trade_close: "Trade closed" };

function WalletPage() {
  const qc = useQueryClient();
  const deposit = useServerFn(walletDeposit);
  const withdraw = useServerFn(walletWithdraw);
  const [amount, setAmount] = useState("10000");
  const [busy, setBusy] = useState<"deposit" | "withdraw" | null>(null);

  const q = useQuery({
    queryKey: ["wallet"],
    queryFn: async () => {
      const [w, tx, pos] = await Promise.all([
        supabase.from("wallets").select("balance,currency").maybeSingle(),
        supabase.from("wallet_transactions").select("*").order("created_at", { ascending: false }).limit(100),
        supabase.from("positions").select("wallet_margin,unrealized_pnl").eq("is_open", true).not("wallet_margin", "is", null),
      ]);
      if (tx.error) throw new Error(tx.error.message);
      const inTrades = (pos.data ?? []).reduce((a, p) => a + Number(p.wallet_margin), 0);
      const upnl = (pos.data ?? []).reduce((a, p) => a + Number(p.unrealized_pnl), 0);
      return { balance: Number(w.data?.balance ?? 0), inTrades, upnl, open: pos.data?.length ?? 0, tx: tx.data };
    },
    refetchInterval: 30_000,
  });

  async function run(kind: "deposit" | "withdraw") {
    const n = Number(amount);
    if (!(n > 0)) return toast.error("Enter an amount");
    setBusy(kind);
    try {
      const r = await (kind === "deposit" ? deposit : withdraw)({ data: { amount: n } });
      toast.success(`${kind === "deposit" ? "Deposited" : "Withdrew"} ${fmtMoney(n)} · balance ${fmtMoney(r.balance)}`);
      qc.invalidateQueries({ queryKey: ["wallet"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    setBusy(null);
  }

  const d = q.data;
  return (
    <div>
      <PageHeader title="Wallet" description={D} actions={<Button size="sm" asChild><Link to="/trade">Trade</Link></Button>} />
      <div className="space-y-4 p-4">
        <div className="flex gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p><span className="font-medium">Demo money.</span> <span className="text-muted-foreground">Deposits and withdrawals here are virtual — no real money moves. Prices are real (crypto exchanges and Yahoo Finance). To trade with real money, connect your own broker on the Exchanges page.</span></p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Available balance", d?.balance],
            ["In open trades", d?.inTrades],
            ["Unrealized PnL", d?.upnl],
            ["Equity", d ? d.balance + d.inTrades + d.upnl : undefined],
          ].map(([label, v]) => (
            <div key={label as string} className="rounded-lg border bg-card p-4">
              <div className="text-xs text-muted-foreground">{label as string}</div>
              {q.isLoading ? <Skeleton className="mt-2 h-7 w-28" /> : (
                <div className={`mt-1 font-mono text-2xl ${label === "Unrealized PnL" ? (Number(v) >= 0 ? "text-gain" : "text-loss") : ""}`}>{fmtMoney(Number(v ?? 0))}</div>
              )}
            </div>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
          <div className="space-y-3 rounded-lg border bg-card p-4">
            <div className="text-sm font-medium">Deposit or withdraw</div>
            <div className="space-y-1.5">
              <Label htmlFor="amt" className="text-xs">Amount (USD)</Label>
              <Input id="amt" type="number" min={0} max={WALLET_MAX_DEPOSIT} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[1000, 10000, 50000, 100000].map((n) => <Button key={n} size="sm" variant="outline" onClick={() => setAmount(String(n))}>{fmtMoney(n)}</Button>)}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => run("deposit")} disabled={!!busy}><ArrowDownToLine className="mr-1 h-4 w-4" />{busy === "deposit" ? "…" : "Deposit"}</Button>
              <Button variant="outline" onClick={() => run("withdraw")} disabled={!!busy}><ArrowUpFromLine className="mr-1 h-4 w-4" />{busy === "withdraw" ? "…" : "Withdraw"}</Button>
            </div>
            <p className="text-xs text-muted-foreground">Up to {fmtMoney(WALLET_MAX_DEPOSIT)} per deposit. Money in open trades comes back when you close them.</p>
          </div>

          <div className="rounded-lg border bg-card">
            <div className="border-b px-4 py-2 text-sm font-medium">History</div>
            {q.isLoading ? <Skeleton className="m-4 h-24" /> : !d?.tx.length ? (
              <p className="p-4 text-sm text-muted-foreground">No transactions yet — make your first deposit.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground">{["Date", "Type", "Details", "Amount", "Balance"].map((h) => <th key={h} className="px-4 py-2 font-normal">{h}</th>)}</tr></thead>
                  <tbody>
                    {d.tx.map((t) => (
                      <tr key={t.id} className="border-t">
                        <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{new Date(t.created_at).toLocaleString()}</td>
                        <td className="px-4 py-2"><Badge variant="secondary">{KIND[t.kind] ?? t.kind}</Badge></td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{t.note}</td>
                        <td className={`px-4 py-2 font-mono text-xs ${Number(t.amount) >= 0 ? "text-gain" : "text-loss"}`}>{Number(t.amount) >= 0 ? "+" : ""}{fmtMoney(Number(t.amount))}</td>
                        <td className="px-4 py-2 font-mono text-xs">{fmtMoney(Number(t.balance_after))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
