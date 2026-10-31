// Server-only NOWPayments access through the Lovable connector gateway.
const GATEWAY_URL = "https://connector-gateway.lovable.dev/udc_nowpayments";

function headers() {
  const lovable = process.env["LOVABLE_API_KEY"];
  const connection = process.env["UDC_NOWPAYMENTS_API_KEY"];
  if (!lovable || !connection) throw new Error("Crypto payments are not configured yet.");
  return { Authorization: `Bearer ${lovable}`, "X-Connection-Api-Key": connection, "Content-Type": "application/json" };
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, { method: init?.method ?? "GET", headers: headers(), body: init?.body === undefined ? null : JSON.stringify(init.body) });
  if (!res.ok) {
    const text = await res.text();
    console.error(`NOWPayments request failed [${res.status}]: ${text}`);
    throw new Error(`Payment provider error [${res.status}]: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export type NowInvoice = { id: string | number; invoice_url: string };
export type NowPayment = {
  payment_id: string | number;
  payment_status: string;
  order_id: string | null;
  price_amount: number | string;
  price_currency: string;
  pay_currency: string | null;
  actually_paid: number | string | null;
};

export function createInvoice(body: {
  price_amount: number; price_currency: "usd"; order_id: string; order_description: string;
  ipn_callback_url: string; success_url: string; cancel_url: string;
}) {
  return call<NowInvoice>("/v1/invoice", { method: "POST", body });
}

export function getPayment(paymentId: string) {
  if (!/^\d{1,20}$/.test(paymentId)) throw new Error("Invalid payment id");
  return call<NowPayment>(`/v1/payment/${paymentId}`);
}

/** NOWPayments signs the IPN body as HMAC-SHA512 over JSON with keys sorted at every level. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = sortKeys((value as Record<string, unknown>)[k]);
      return acc;
    }, {});
  }
  return value;
}

export async function verifyIpnSignature(payload: unknown, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(sortKeys(payload)))));
  const expected = Array.from(mac, b => b.toString(16).padStart(2, "0")).join("");
  const given = signature.toLowerCase();
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/**
 * Re-reads the payment from NOWPayments (never trusting the callback body) and applies it.
 * The database function activates the plan at most once and checks order, amount and currency.
 */
export async function syncPayment(paymentId: string, expectedOrder?: string) {
  const payment = await getPayment(paymentId);
  const order = payment.order_id ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(order)) return { result: "unknown_order" };
  if (expectedOrder && expectedOrder !== order) return { result: "payment_mismatch" };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("apply_crypto_payment", {
    _order: order,
    _payment_id: String(payment.payment_id),
    _status: payment.payment_status,
    _pay_currency: payment.pay_currency ?? "",
    _actually_paid: Number(payment.actually_paid ?? 0),
    _price_amount: Number(payment.price_amount),
    _price_currency: payment.price_currency,
  });
  if (error) throw new Error(error.message);
  return data as { result: string };
}
