import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, legalHead, COMPANY } from "@/components/legal-page";

export const Route = createFileRoute("/terms")({
  head: () => legalHead("Terms of Service", "The rules for using AlgoVirt's trading tools, demo wallet, AI features and subscriptions.", "/terms"),
  component: () => (
    <LegalPage title="Terms of Service">
      <p>By creating an account or using {COMPANY.name} at {COMPANY.website}, you agree to these terms.</p>
      <h2>1. The service</h2>
      <p>{COMPANY.name} provides software for charting, manual trading, strategy building, backtesting, automated bots, scalping and arbitrage tools. We are not a broker, exchange, bank or investment adviser and we never hold your money. Real trades are placed on exchange or broker accounts you connect and control.</p>
      <h2>2. Demo wallet</h2>
      <p>The wallet uses virtual demo money only. Demo balances have no cash value and cannot be withdrawn as real money.</p>
      <h2>3. Your account</h2>
      <ul><li>You must be of legal age to trade in your country.</li><li>Keep your password and exchange API keys secure; enable two-step verification.</li><li>Only connect accounts you own, with withdrawal permissions disabled.</li></ul>
      <h2>4. No advice, no guarantees</h2>
      <p>AI output, strategies, leaderboards, marketplace strategies and backtests are information only, not financial advice. Past or simulated results do not predict future results. You are responsible for every trade and bot you start.</p>
      <h2>5. Subscriptions</h2>
      <p>Paid plans unlock features as described on the Plans page and renew each billing period until cancelled. See the Refund Policy for refunds.</p>
      <h2>6. Acceptable use</h2>
      <p>No abuse, market manipulation, attempts to bypass plan limits or security, or publishing misleading strategies. We may suspend accounts that break these rules.</p>
      <h2>7. Liability</h2>
      <p>To the extent allowed by law, {COMPANY.name} is not liable for trading losses, exchange outages, missed or delayed orders, or data provider errors.</p>
      <h2>8. Contact</h2>
      <p>Questions: contact us through {COMPANY.contact}.</p>
    </LegalPage>
  ),
});
