import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, legalHead, COMPANY } from "@/components/legal-page";

export const Route = createFileRoute("/refunds")({
  head: () => legalHead("Refund Policy", "How cancellations and refunds work for AlgoVirt Pro and Elite subscriptions.", "/refunds"),
  component: () => (
    <LegalPage title="Refund Policy">
      <h2>Cancelling</h2><p>You can cancel a paid plan at any time. You keep access until the end of the period you paid for, then the account returns to Free. Open positions can still be managed and closed after a downgrade.</p>
      <h2>Refunds</h2><p>First-time subscribers may request a refund within 7 days of their first payment. Renewals and partially used periods are not refunded unless required by law.</p>
      <h2>Trading losses</h2><p>Subscription refunds never cover trading losses, fees charged by exchanges or brokers, or demo wallet balances.</p>
      <h2>How to request</h2><p>Send a request through {COMPANY.contact} with the email on your account.</p>
    </LegalPage>
  ),
});
