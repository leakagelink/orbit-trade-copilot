import { describe, expect, it } from "vitest";
import { checkoutBlockedReason, planPrice } from "@/lib/billing";
import { sortKeys, verifyIpnSignature } from "@/lib/nowpayments.server";

describe("plan prices (USD)", () => {
  it("Pro is $249 monthly and $1999 yearly", () => {
    expect(planPrice("pro", "monthly")).toBe(249);
    expect(planPrice("pro", "yearly")).toBe(1999);
  });
  it("Elite is $449 monthly and $3899 yearly", () => {
    expect(planPrice("elite", "monthly")).toBe(449);
    expect(planPrice("elite", "yearly")).toBe(3899);
  });
});

describe("checkout eligibility", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  it("blocks buying Pro while Elite is active", () => {
    expect(checkoutBlockedReason({ plan: "elite", status: "active", periodEnd: future }, "pro")).not.toBeNull();
  });
  it("allows extending the same plan and upgrading", () => {
    expect(checkoutBlockedReason({ plan: "pro", status: "active", periodEnd: future }, "pro")).toBeNull();
    expect(checkoutBlockedReason({ plan: "pro", status: "active", periodEnd: future }, "elite")).toBeNull();
  });
  it("allows Pro once Elite has expired", () => {
    expect(checkoutBlockedReason({ plan: "elite", status: "active", periodEnd: past }, "pro")).toBeNull();
  });
});

describe("NOWPayments callback signature", () => {
  it("sorts keys at every level", () => {
    expect(JSON.stringify(sortKeys({ b: 1, a: { d: 2, c: 3 } }))).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it("accepts the correct signature and rejects a tampered body", async () => {
    const secret = "test-secret";
    const body = { payment_status: "finished", payment_id: 5, order_id: "x" };
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(sortKeys(body)))));
    const sig = Array.from(mac, b => b.toString(16).padStart(2, "0")).join("");
    expect(await verifyIpnSignature(body, sig, secret)).toBe(true);
    expect(await verifyIpnSignature({ ...body, payment_status: "failed" }, sig, secret)).toBe(false);
    expect(await verifyIpnSignature(body, null, secret)).toBe(false);
  });
});
