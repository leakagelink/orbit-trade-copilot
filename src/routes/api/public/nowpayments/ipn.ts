import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Ipn = z.object({
  payment_id: z.union([z.number().int().positive(), z.string().regex(/^\d{1,20}$/)]),
  order_id: z.string().uuid().nullable().optional(),
}).passthrough();

// NOWPayments payment-status callback. The body is only a hint: the payment is
// re-read from NOWPayments with our API key before anything changes.
export const Route = createFileRoute("/api/public/nowpayments/ipn")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        if (raw.length > 20_000) return new Response("Too large", { status: 413 });
        let json: unknown;
        try { json = JSON.parse(raw); } catch { return new Response("Bad request", { status: 400 }); }
        const parsed = Ipn.safeParse(json);
        if (!parsed.success) return new Response("Bad request", { status: 400 });

        const { verifyIpnSignature, syncPayment } = await import("@/lib/nowpayments.server");
        const secret = process.env["NOWPAYMENTS_IPN_SECRET"];
        if (secret && !(await verifyIpnSignature(json, request.headers.get("x-nowpayments-sig"), secret))) {
          return new Response("Invalid signature", { status: 401 });
        }
        try {
          const out = await syncPayment(String(parsed.data.payment_id), parsed.data.order_id ?? undefined);
          return Response.json({ ok: true, result: out.result });
        } catch (e) {
          console.error("NOWPayments IPN sync failed", e);
          return new Response("Retry later", { status: 502 });
        }
      },
    },
  },
});
