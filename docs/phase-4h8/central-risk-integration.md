# Phase 4H.8 — Central Risk Engine integration

Path: live signal → `signalToProposal` → `buildPaperRiskContext` → `evaluateProposal` (existing `central-risk.ts`, unchanged) → only on ACCEPT, a PAPER market order sized exactly by the decision (`live-scalp-pipeline.ts` `act`).

## Guarantees (tested, `src/test/phase4h8-risk.test.ts` 14/14 PASS)
- Only LONG/SHORT become proposals; environment is always `paper`; the proposal has no size or leverage fields.
- Injected quantity/leverage/`executionAuthorized` (e.g. from an AI or a forged object) is refused by the strict schema; extra fields on a signal never change sizing.
- No limits entered → INSUFFICIENT_DATA, nothing sized. Limits are empty by default.
- Stale mark → REJECT; missing mark → INSUFFICIENT_DATA; emergency stop ON → REJECT; stop status unknown → INSUFFICIENT_DATA; expired signal → not evaluated; old proposal → REJECT; daily loss, strategy budget, position count and duplicate proposal → REJECT.
- The owner's Testnet limits cannot size a BTCUSDT trade above the real 50 USDT minimum → REJECT (min_notional).
- ACCEPT → paper position with exactly the engine's qty and leverage; same correlation id on decision and fill; second identical proposal → REJECT (duplicate). ACCEPT is never an execution authorization (`executionAuthorized: false`).

## Values shown on the page
- Owner-proposed paper values (5 % liquidation buffer, 5 s price age, 60 s proposal expiry, 0.13 % round-trip cost) are offered as a preset and labelled NOT APPROVED.
- The owner's fixed Testnet limits (5 USDT margin, 2 USDT loss/trade, 2 USDT daily, 10 USDT exposure, 1 position, ≤ 10×) are offered as a separate preset.
- The paper decision uses the paper emergency-stop switch OR the account's own emergency stop (read-only); if the account stop can't be read, entries return INSUFFICIENT_DATA.

## Result: PASS (paper). Not verified
Account-level limits are not read from `risk_settings` into paper sizing (paper has its own entered limits); paper results never affect real risk records.
