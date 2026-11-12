# Phase 3 — Forward Paper Trading: implementation plan (PROPOSED, not authorized)

Status 12 Nov 2026: plan only. Paper automation stays **off**. Based on a read-only audit of `engine.server.ts`,
`bots.server.ts`, `manual.server.ts`, `wallet-math.ts`, `trade-accounting.ts`, `risk-limits.server.ts`,
`research-paper*.ts`, recovery modules and their tests.

## 1. Gap report — existing paper infrastructure
| Item | Today | Gap |
|---|---|---|
| Automatic entries/exits | Bot paper engine on the cron tick: completed-bar signals, account risk check, idempotency claim, simulated fill | No integration test of the bot paper lifecycle. Research proposals do **not** create paper orders (confirmed) |
| Position accounting | One position per entry; whole-position close | No scale-in averaging, no partial closes |
| Stop-loss / take-profit | Bots and manual: latest close/sampled price only. Research paper: completed daily OHLC, stop-first, gap-through at worse open | Bot path misses intrabar touches; no bot gap tests |
| Fees and slippage | 0.1% fee + 0.05% adverse slippage per side (bots); wallet math matches | No full cash/ledger reconciliation; wallet floors at zero while reported loss is uncapped |
| Open positions | `is_open`, current price and gross unrealised P&L updated each tick | Unrealised excludes costs; manual-only users get no snapshots |
| Trade history | Closes write trades with gross, fees, funding, net | Order/position/trade writes are separate statements; a failure can leave them out of step |
| Daily P&L | Three definitions (dashboard rolling 24 h net; bot stop UTC gross−fees; account risk UTC net + negative unrealised) | Inconsistent; paper and live not separated in some callers |
| Drawdown | Peak-to-trough on snapshots | Mixed equity basis, snapshot gaps |
| Strategy performance | Per-strategy net, win rate, profit factor | Strategy recorded at close, not frozen at entry; 5,000-trade cap |
| Restart / recovery | Unique idempotency keys per user; unresolved intents block new entries; emergency recovery verified | No tick-wide lease; non-atomic multi-table writes; manual debit happens before order creation |

## 2. Design
1. Proposal → owner review → explicit **PAPER** approval of a frozen proposal, cost assumptions, risk policy and expiry.
   Later automation requires a separate, revocable, bounded approval. Agent consensus never authorises anything.
2. Position size comes only from a pure deterministic Risk Engine sizer: min(stop-risk budget, available paper cash
   after costs, symbol/exposure caps, position-count limit), rounded down. LLM size/leverage is ignored.
3. Paper-only ledger (draft migration): paper accounts, immutable approvals, intents, fills, events, lots, daily
   equity, settlement cursors. One service-only RPC locks the account, re-checks approval and risk, then writes fill,
   position, cash, history and cursor in one transaction. No exchange connection or order-capable module is imported.
4. Settlement extends `research-paper.ts`: first eligible bar after approval, completed OHLC only, adverse slippage,
   stop before target, gapped stop at the worse open, frozen bars and provider.
5. UTC daily equity = cash + marked inventory; daily P&L = equity change minus deposits/withdrawals; high-water drawdown;
   attribution to frozen strategy version, proposal, run and agent evidence.

## 3. Tests that must pass before automation is enabled
- Missing/expired/revoked approval, halt or ownership failure → 0 fills.
- Research import graph reaches no exchange executor (existing test extended to the new modules).
- 20 concurrent retries of one approval → exactly 1 intent and 1 fill.
- Injected crash at every settlement step → all-or-nothing state; replay gives identical results.
- Buy 2 @ 100 + 1 @ 110 → average 103.333333; close 1 @ 120 leaves 2, gross +16.666667, fees allocated once.
- Bar touches stop and target → stop fills. Long stop 85, bar opens at 80, 0.05% slippage → exit 80 × 0.9995 = 79.96; shorts mirror.
- Incomplete or pre-approval bars never fill.
- Cash + inventory conserved; available cash never negative; UTC rollover correct; paper/live isolated.
- Equity 1000 → 1200 → 960 → max drawdown 20%; a deposit is not profit; accounts and strategies never leak P&L.
- Real-Postgres transaction, RLS and concurrency tests plus an end-to-end paper-only run.
