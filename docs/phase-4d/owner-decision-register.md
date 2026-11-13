# Owner decision register — Phase 4D

> **Superseded (13 Nov 2026) by `docs/phase-4e/owner-decision-register.md`.** Kept unchanged below for history.

Nothing here is decided. Every value below is **NOT APPROVED** and is not enforced on any real or Testnet order. The
engine, drafts and tests take these as inputs; none is hard-coded as policy except where the existing code already used
the Phase 4A proposal (noted).

## 1. Unapproved policy values

| Policy | Proposed | Status | Where it would apply | Options and trade-offs | Depends on | Tests needed before approval |
|---|---:|---|---|---|---|---|
| Liquidation buffer | 2% of entry | NOT APPROVED | Central Risk sizing (Futures) | Higher = smaller leverage, fewer liquidations; lower = more size, stop may sit near liquidation. Per-strategy values possible. | Maintenance-margin source (signed leverageBracket — not on the allowlist) | Sizing at buffer edges; leverage step-down; refusal at 1×. |
| Maximum mark age | 5 s | NOT APPROVED | Shadow/live context staleness (shadow already uses the Phase 4A proposal to classify stale → INSUFFICIENT_DATA). Paper uses the candle's own mark open (age 0, structural, not this policy). | Shorter = more INSUFFICIENT_DATA on slow feeds; longer = decisions on older prices. | Public mark feed latency measurement | Stale/fresh boundary; clock-skew (future-dated) refusal. |
| Maximum proposal age | 60 s | NOT APPROVED | Risk Engine freshness check | Shorter blocks slow pipelines; longer admits outdated signals. | Engine B latency budget | Boundary tests at age = limit ± 1 ms. |
| Estimated round-trip cost | 0.13% | NOT APPROVED | Sizing and reserved risk (paper fill risk = qty × stop distance + qty × entry × cost) | Must cover fees + spread + slippage both ways; too low under-reserves budget. | Measured fills (none — no live/Testnet orders authorized) | Budget reservation reconciliation engine ↔ 0046. |

## 2. Budget semantics (draft 0046 is unchanged; owner confirmation required)

| Definition | What counts | Wins net losses? | Resets | Current use |
|---|---|---|---|---|
| Daily loss budget | Today's (UTC, by candle) realized cash + negative unrealized at the marks | Yes (cash flows net within the day) | 00:00 UTC | Account limit in engine and 0046 commit |
| **Cumulative closed-trade loss budget** (proposed) | Σ over closed proposals of max(0, −net) | **No** — each losing trade counts; wins never refill | Never (until the owner raises it) | Strategy budget in engine (`strategyLoss`) and 0046 |
| Net P&L budget | Σ net over all trades | Yes | Configurable | Not implemented |
| Gross loss budget | Σ losing-trade gross loss excluding costs | No | Configurable | Not implemented |
| Reserved open risk | Open qty × stop distance + open qty × entry × cost | n/a | Released on close | Added to the strategy budget at fill (0046 and Phase 4D engine) |

Documented mismatch (kept, not silently changed): at **acceptance** the Risk Engine sees budget − closed losses only;
at **fill** (engine Phase 4D and 0046) reserved open risk and this fill's risk are added. A second position of the same
strategy can therefore be accepted and then refused at fill. Options: (a) keep (safe: refusal cancels deterministically),
(b) feed reserved risk into acceptance as well (changes sizing; needs approval).

## 3. Retention (no records deleted or altered)

One commit record per account per candle, plus its events. At 1 m candles: 1,440 commits/day/account (~525,600/year);
5 m: 288/day; 15 m: 96/day. Events per candle are usually 0–3. Rough storage per account-year at 1 m: commits ≈ 60–80 MB
with indexes, events depend on activity. Options: keep everything (simplest audit, grows linearly); archive commits older
than N days to an export file while keeping events (events are the ledger); partition by month. Deletion would conflict
with the append-only triggers and needs its own reviewed migration. **Decision needed: timeframe allowed, archive age,
whether archives must be restorable.**

## 4. Other open decisions

| # | Decision | Status |
|---|---|---|
| 1 | Fresh database export for real restore verification of 0046 (and 0047) | BLOCKED — owner action |
| 2 | Final migration numbers / order of drafts 0040–0047 | Owner |
| 3 | Approve 0046 + the Phase 4D engine together (the engine now matches 0046's fill checks) | Owner |
| 4 | Approve 0047 and, separately, an order-path change that calls `claim_futures_order_strategy_identity` inside the claim transaction | Owner (two approvals) |
| 5 | Allow reading maintenance-margin brackets and available margin (signed reads; allowlist change) | Owner — NOT requested here |
| 6 | Post-claim shadow observation semantics (classifier drafted, not wired) | Owner review |
| 7 | Reconnect AI Prime Tech in the new workspace (AI calls remain disabled by standing rule) | Owner skipped the card on 13 Nov |
