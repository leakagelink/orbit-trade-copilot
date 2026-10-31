import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { toast } from "sonner";
import { Check, Crown, Zap, CandlestickChart, ShieldCheck, Bitcoin, Loader2, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePlan } from "@/hooks/use-plan";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { PLAN_FEATURES, PLAN_IDS, type BillingInterval } from "@/lib/plans";
import { PAYMENT_STATUS_LABEL, checkoutBlockedReason, planPrice, yearlySavingsPercent, type PaidPlanId } from "@/lib/billing";
import { createCryptoCheckout, refreshCryptoPayments } from "@/lib/billing.functions";

const D = "Free manual trading, Pro AI and trading bots from $249/month, or Elite scalping and arbitrage from $449/month. Pay with crypto.";
export const Route = createFileRoute("/_authenticated/plans")({
  validateSearch: (s) => z.object({ payment: z.enum(["success", "cancelled"]).optional() }).parse(s),
  head: () => ({ meta: [{ title: "Free, Pro & Elite Plans — AlgoVirt" }, { name: "description", content: D }, { property: "og:title", content: "Free, Pro & Elite Plans — AlgoVirt" }, { property: "og:description", content: D }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }] }),
  component: PlansPage,
});

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

function usePayments(poll: boolean) {
  return useQuery({
    queryKey: ["crypto-payments"],
    queryFn: async () => {
      const { data, error } = await supabase.from("crypto_payments").select("id,plan,billing_interval,amount_usd,status,pay_currency,activated_at,period_end,created_at,invoice_url").order("created_at", { ascending: false }).limit(10);
      if (error) throw new Error("Unable to load payments");
      return data;
    },
    refetchInterval: poll ? 15_000 : false,
  });
}

function PlansPage() {
  const plan = usePlan();
  const qc = useQueryClient();
  const { payment } = Route.useSearch();
  const current = plan.data?.plan ?? "free";
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [busy, setBusy] = useState<PaidPlanId | null>(null);
  const [checking, setChecking] = useState(false);
  const checkout = useServerFn(createCryptoCheckout);
  const refresh = useServerFn(refreshCryptoPayments);
  const payments = usePayments(payment === "success");
  const pending = (payments.data ?? []).some(p => !p.activated_at && ["created", "waiting", "confirming", "confirmed", "sending", "finished"].includes(p.status));
  const icons = { free: CandlestickChart, pro: Zap, elite: Crown };

  useEffect(() => {
    if (payment !== "success") return;
    const t = window.setInterval(() => qc.invalidateQueries({ queryKey: ["plan"] }), 15_000);
    return () => window.clearInterval(t);
  }, [payment, qc]);

  async function pay(id: PaidPlanId) {
    setBusy(id);
    try {
      const { url } = await checkout({ data: { plan: id, interval } });
      window.location.assign(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start checkout");
      setBusy(null);
    }
  }

  async function check() {
    setChecking(true);
    try {
      const r = await refresh();
      await Promise.all([qc.invalidateQueries({ queryKey: ["crypto-payments"] }), qc.invalidateQueries({ queryKey: ["plan"] })]);
      toast.success(r.activated ? "Payment confirmed — your plan is active." : r.checked ? "Payment is still being confirmed." : "No payment to check yet. It can take a few minutes to appear.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not check payment");
    } finally { setChecking(false); }
  }

  const sub = plan.data ? { plan: plan.data.subPlan, status: plan.data.status, periodEnd: plan.data.periodEnd } : null;

  return (
    <div>
      <PageHeader title="Plans" description="Manual. Automated. Advanced." />
      <div className="max-w-6xl space-y-6 px-4 pb-8 md:px-7">
      {payment === "success" && (
        <Card className="border-gain/40 p-4 text-sm">
          <p className="font-medium">Thanks! We're waiting for the blockchain to confirm your payment.</p>
          <p className="mt-1 text-muted-foreground">This usually takes a few minutes. Your plan turns on automatically — this page checks every 15 seconds.</p>
        </Card>
      )}
      {payment === "cancelled" && <Card className="p-4 text-sm text-muted-foreground">Checkout was cancelled. You haven't been charged.</Card>}
      <div className="flex flex-wrap items-center justify-between gap-4 border-y py-4">
        <div className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4 text-primary" />{plan.isLoading ? "Loading your plan…" : plan.isError ? "Plan unavailable" : `${PLAN_FEATURES[current].name} workspace${plan.data?.periodEnd && current !== "free" ? ` · until ${new Date(plan.data.periodEnd).toLocaleDateString()}` : ""}`}</div>
        <Tabs value={interval} onValueChange={v => { if (v === "monthly" || v === "yearly") setInterval(v); }}>
          <TabsList aria-label="Billing interval" className="h-auto"><TabsTrigger value="monthly" className="min-h-11">Monthly</TabsTrigger><TabsTrigger value="yearly" className="min-h-11">Yearly</TabsTrigger></TabsList>
        </Tabs>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {PLAN_IDS.map((id) => {
          const p = PLAN_FEATURES[id];
          const Icon = icons[id];
          const isCurrent = !plan.isLoading && !plan.isError && current === id;
          const paid = id !== "free" ? id : null;
          const blocked = paid ? checkoutBlockedReason(sub, paid) : null;
          return (
            <Card key={id} className={`flex min-w-0 flex-col p-5 md:p-6 ${id === "pro" ? "border-primary/50" : id === "elite" ? "border-warning/40" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Icon className={`h-5 w-5 ${id === "elite" ? "text-warning" : "text-primary"}`} />
                <h2 className="text-xl font-semibold">{p.name}</h2>
                {isCurrent && <Badge>Current plan</Badge>}
                {paid && interval === "yearly" && <Badge variant="outline">Save {yearlySavingsPercent(paid)}%</Badge>}
              </div>
              <p className="mt-2 min-h-10 text-sm text-muted-foreground">{p.summary}</p>
              <div className="my-5 min-h-16 border-b pb-5">{!paid ? <><span className="font-mono text-3xl">$0</span><span className="ml-2 text-xs text-muted-foreground">Always free</span></> : <><span className="font-mono text-3xl">{usd(planPrice(paid, interval))}</span><span className="ml-2 text-xs text-muted-foreground">{interval === "monthly" ? "/ month" : "/ year"}</span><div className="mt-1 text-xs text-muted-foreground">{interval === "yearly" ? `≈ ${usd(Math.round(planPrice(paid, "yearly") / 12))}/month · ` : ""}One-time crypto payment · no auto-renew</div></>}</div>
              <ul className="flex-1 space-y-3 text-sm">
                {p.features.map((f) => <li key={f} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-gain" />{f}</li>)}
              </ul>
              {plan.isLoading ? <Skeleton className="mt-6 h-11" /> : paid && !blocked ? (
                <Button className="mt-6 h-11 w-full" variant={id === "elite" ? "outline" : "default"} disabled={busy !== null} onClick={() => pay(paid)}>
                  {busy === paid ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Bitcoin className="mr-2 h-4 w-4" />}
                  {isCurrent ? `Extend ${p.name}` : `Get ${p.name}`} · Pay with crypto
                </Button>
              ) : (
                <Button className="mt-6 h-11 w-full" variant="outline" disabled title={blocked ?? undefined}>{isCurrent ? "Your plan" : "Included"}</Button>
              )}
            </Card>
          );
        })}
      </div>
      {(payments.data?.length ?? 0) > 0 && (
        <Card className="p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">Your payments</h2>
            {pending && <Button size="sm" variant="outline" className="min-h-11" onClick={check} disabled={checking}>{checking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Check payment status</Button>}
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-2 font-normal">Date</th><th className="font-normal">Plan</th><th className="font-normal">Amount</th><th className="font-normal">Status</th></tr></thead>
              <tbody>
                {payments.data!.map(r => (
                  <tr key={r.id} className="border-t">
                    <td className="py-2">{new Date(r.created_at).toLocaleDateString()}</td>
                    <td>{PLAN_FEATURES[r.plan as PaidPlanId]?.name ?? r.plan} · {r.billing_interval === "yearly" ? "Yearly" : "Monthly"}</td>
                    <td className="font-mono">{usd(Number(r.amount_usd))}{r.pay_currency ? ` · ${r.pay_currency.toUpperCase()}` : ""}</td>
                    <td>{r.activated_at ? <span className="text-gain">Active{r.period_end ? ` until ${new Date(r.period_end).toLocaleDateString()}` : ""}</span> : PAYMENT_STATUS_LABEL[r.status] ?? r.status}{!r.activated_at && r.status === "created" && r.invoice_url && <a className="ml-2 text-primary underline" href={r.invoice_url}>Open</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">Prices are in US dollars, paid in crypto through NOWPayments. Each payment covers one month or one year and does not renew automatically; paying again before it ends adds time. Wallet funds are virtual. Live trades use your own connected exchange or broker. Trading profits are not guaranteed.</p>
      </div>
    </div>
  );
}
