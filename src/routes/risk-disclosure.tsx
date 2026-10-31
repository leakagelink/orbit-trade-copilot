import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, legalHead } from "@/components/legal-page";

export const Route = createFileRoute("/risk-disclosure")({
  head: () => legalHead("Risk Disclosure", "Important risks of trading crypto, forex and commodities, and of using bots, AI, scalping and arbitrage."),
  component: () => (
    <LegalPage title="Risk Disclosure">
      <p>Trading crypto, forex and commodities carries a high risk of loss. Only trade money you can afford to lose.</p>
      <h2>Market risk</h2><p>Prices can move sharply and gap past your stop loss. Stops and targets are not guaranteed to fill at your price.</p>
      <h2>Leverage</h2><p>Leveraged products such as forex and CFDs can lose more than your initial deposit, depending on your broker.</p>
      <h2>Automated trading</h2><p>Bots follow rules mechanically and can lose money quickly in changing markets. Connection outages or exchange errors can delay or prevent orders.</p>
      <h2>Scalping and arbitrage</h2><p>Fees, slippage and delays can turn small expected gains into losses. Cross-exchange orders are not atomic: one side may fill while the other does not.</p>
      <h2>AI and simulations</h2><p>AI suggestions can be wrong. Backtests, paper trading, demo leaderboards and marketplace results are simulations and do not predict real results.</p>
      <h2>No advice</h2><p>Nothing on this platform is investment advice. Consider speaking to a licensed adviser.</p>
    </LegalPage>
  ),
});
