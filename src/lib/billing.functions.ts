import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkoutBlockedReason, planPrice } from "./billing";
import { PLAN_FEATURES } from "./plans";
import { SITE_URL } from "./site";

const ALLOWED_RETURN = /^https:\/\/(algovirt\.com|www\.algovirt\.com|[a-z0-9-]+\.lovable\.app)$/;

function returnOrigin(): string {
  const origin = getRequest().headers.get("origin") ?? "";
  return ALLOWED_RETURN.test(origin) ? origin : SITE_URL;
}

/** Creates a NOWPayments crypto invoice for a Pro/Elite period. Price comes from the server-side table. */
export const createCryptoCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ plan: z.enum(["pro", "elite"]), interval: z.enum(["monthly", "yearly"]) }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: sub, error: subError } = await context.supabase.from("subscriptions").select("plan,status,current_period_end").eq("user_id", context.userId).maybeSingle();
    if (subError) throw new Error("Unable to read your current plan");
    const blocked = checkoutBlockedReason(sub ? { plan: sub.plan, status: sub.status, periodEnd: sub.current_period_end } : null, data.plan);
    if (blocked) throw new Error(blocked);

    const amount = planPrice(data.plan, data.interval);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await supabaseAdmin.from("crypto_payments").select("id", { count: "exact", head: true })
      .eq("user_id", context.userId).eq("status", "created").gte("created_at", new Date(Date.now() - 60 * 60_000).toISOString());
    if ((count ?? 0) >= 10) throw new Error("Too many unpaid checkouts in the last hour. Please finish or wait for one to expire.");

    const { data: row, error } = await supabaseAdmin.from("crypto_payments")
      .insert({ user_id: context.userId, plan: data.plan, billing_interval: data.interval, amount_usd: amount })
      .select("id").single();
    if (error || !row) throw new Error("Could not start checkout");

    const origin = returnOrigin();
    const { createInvoice } = await import("./nowpayments.server");
    try {
      const invoice = await createInvoice({
        price_amount: amount,
        price_currency: "usd",
        order_id: row.id,
        order_description: `AlgoVirt ${PLAN_FEATURES[data.plan].name} — ${data.interval === "yearly" ? "1 year" : "1 month"}`,
        ipn_callback_url: `${SITE_URL}/api/public/nowpayments/ipn`,
        success_url: `${origin}/plans?payment=success`,
        cancel_url: `${origin}/plans?payment=cancelled`,
      });
      if (!invoice.invoice_url?.startsWith("https://")) throw new Error("Payment provider returned no checkout link");
      await supabaseAdmin.from("crypto_payments").update({ invoice_id: String(invoice.id), invoice_url: invoice.invoice_url }).eq("id", row.id);
      return { url: invoice.invoice_url };
    } catch (e) {
      await supabaseAdmin.from("crypto_payments").update({ status: "failed" }).eq("id", row.id);
      throw e;
    }
  });

/** Re-checks the caller's own in-progress payments with NOWPayments (in case a callback was missed). */
export const refreshCryptoPayments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.from("crypto_payments").select("id,payment_id")
      .eq("user_id", context.userId).is("activated_at", null).not("payment_id", "is", null)
      .in("status", ["waiting", "confirming", "confirmed", "sending", "finished"]).limit(5);
    if (error) throw new Error("Unable to read your payments");
    const { syncPayment } = await import("./nowpayments.server");
    let activated = 0;
    for (const p of data ?? []) {
      const out = await syncPayment(p.payment_id as string, p.id);
      if (out.result === "activated") activated++;
    }
    return { checked: data?.length ?? 0, activated };
  });
