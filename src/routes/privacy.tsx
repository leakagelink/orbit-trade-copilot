import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, legalHead, COMPANY } from "@/components/legal-page";

export const Route = createFileRoute("/privacy")({
  head: () => legalHead("Privacy Policy", "What data AlgoVirt collects, how exchange keys are protected and your privacy choices."),
  component: () => (
    <LegalPage title="Privacy Policy">
      <h2>What we collect</h2>
      <ul><li>Account details: email, display name, preferences.</li><li>Trading data: strategies, bots, orders, trades, journal entries and demo wallet activity.</li><li>Exchange API keys you add — stored encrypted and never shown back in the browser.</li><li>Security records: sign-in activity and workspace sessions.</li><li>Support messages you send.</li></ul>
      <h2>How we use it</h2>
      <p>To run the features you use, keep your account secure, answer support requests and improve reliability. AI features send the relevant market context and your prompt to our AI provider to generate a response.</p>
      <h2>Sharing</h2>
      <p>We do not sell your data. Your name and demo results appear on the leaderboard only if you opt in, and a strategy appears in the marketplace only if you publish it.</p>
      <h2>Your choices</h2>
      <p>You can edit your profile, turn off leaderboard visibility, unpublish strategies, delete exchange connections, or ask us to delete your account via {COMPANY.contact}.</p>
      <h2>Security</h2>
      <p>Data is protected with per-user access rules, encryption for exchange keys and optional two-step verification.</p>
    </LegalPage>
  ),
});
