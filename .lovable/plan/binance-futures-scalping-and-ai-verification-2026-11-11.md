# Binance Futures scalping and AI verification

## What will be built
- Add a distinct **Binance USD-M Futures** choice on Scalping, alongside Spot. Support Long and Short with explicit margin, leverage, stop loss, target and time limit.
- Verify Futures account access independently of the existing Spot balance check. Show read access, trading permission, account mode and testnet/live status separately; “Active” alone must not imply order execution was tested.
- Add Futures-specific open/close records, broker-held stop/target protection, reduce-only exits, fee/funding accounting, and recovery for missing, partial or ambiguous fills.
- Extend emergency stop and risk exposure checks to Futures. Never silently change account-wide hedge mode, cross/isolated settings or existing positions.
- Let AI inspect Futures markets and propose scalps; expose entry tools only after separate Futures live opt-in and saved risk limits. Keep withdrawals, API keys and admin actions unavailable.
- Keep strategy scores evidence-based. Existing scoring, governance and strategy-rule tests passed **40/40**; test fixtures are not live qualification.

## Verification and real money
1. Test calculations and safety rules, then verify read-only Futures access on the owner's connected account.
2. Exercise a full testnet lifecycle: entry, protection, close, history reload, fees, disconnect and emergency recovery. Testnet credentials are required if the current account is production-only.
3. Reconnect AI Prime Tech in this workspace and test actual AI analysis/tool use without real-money orders first. The current workspace has no linked AI connection.
4. A real-money test remains a separate confirmed action after the above checks. AI may select a candidate, but cannot invent the owner's allowed margin, maximum leverage or maximum loss. No real trade is included in approving this implementation plan.

## Technical approach
- Use Binance's official USD-M REST contracts, with Worker-safe fetch/Web Crypto signatures and separate production/testnet hosts. Inspect the current conditional-order API before implementing protective orders.
- Keep Futures lifecycle and accounting separate from the existing Spot manual path; use additive schema fields/tables with owner-scoped reads and server-only trading writes.
- Durably claim each entry/exit intent before submission; look up uncertain outcomes instead of retrying orders. Do not mark an entry fully protected until broker protection is confirmed.
- Route UI and strict Autopilot tools through the same authenticated Futures server functions and risk checks. Keep the existing live-bot promotion block until independent evidence is available.
- Preserve native app upgrades: the original TradingAgents/Freqtrade/Hummingbot Python engines are not installed and will not be claimed as installed.

## Completion criteria
Futures controls and automated exits work on testnet, protection and reconciliation tests pass, records reload accurately, and the AI connection is verified. Any unavailable credentials, insufficient funds, provider restrictions or missing owner risk authorization will be reported as blockers—not a successful live test.