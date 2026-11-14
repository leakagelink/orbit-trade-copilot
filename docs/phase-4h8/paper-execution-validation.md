# Phase 4H.8 — Paper execution validation

Module: `src/lib/live-paper-exec.ts` (`PaperBook`). Every fill is labelled PAPER; nothing is sent to an exchange.

## Behaviour
| Feature | Rule |
|---|---|
| Market orders | Walk the visible live book within a price band; size-weighted price; taker fee; slippage recorded vs best price; unfilled remainder cancelled (IOC). |
| Limit orders | Post-only (crossing limit rejected); queue ahead = displayed quantity at the price; a trade AT the price consumes the queue first; a trade THROUGH the price fills (maker fee); buyer-initiated prints never fill a resting buy. Touch ≠ fill. |
| Rejections | No book, no exchange filters, lot size, below min notional, insufficient margin, stop on wrong side, existing position/order. |
| Protection | Stop and take-profit trigger on the MARK price; exit walks the opposite side of the book; with no usable book the exit stays pending (no invented price). |
| Funding | Charged once after each funding time on open positions. |
| Liquidation | Isolated: at the estimated liquidation price; loss capped at the position margin. |
| Dedupe | Proposal IDs, trade IDs and mark timestamps applied once (also after restart). |
| Recovery | Versioned, checksummed save in browser storage per verified user; corrupted/truncated saves are refused and a fresh ledger starts. No save at all if the signed-in user cannot be confirmed. |
| Reconciliation | Wallet = start + realized − fees + funding; fee/realized totals equal fills; position quantity equals its fills. |

## Tests — `src/test/phase4h8-paper.test.ts` 19/19 PASS
Real exchange filters from recorded `exchangeInfo`; synthetic books and trades for each case (partial fills, queue, expiry, funding, liquidation, restart replay, tampering).

## Live run (REAL public data, simulated fill)
One hand-crafted ETHUSDT test proposal (NOT a strategy signal) passed Central Risk: qty 0.6, notional ≈ 1,143.63 USDT, margin ≈ 190.61 USDT, leverage 6, risk ≤ 5 USDT. The simulator filled 0.6 @ 1,905.92 against the live book in one fill; reconciliation OK.

## Result: PASS as a simulator. Limitations
- Paper fills assume our order does not move the market and that displayed queue is real (hidden orders, cancellations ahead of us and latency are not modelled). Real fills will differ.
- Liquidation uses the generic 2.5 % maintenance rate, not the account bracket.
- Browser storage is not an audit record: it can be cleared or edited by the device owner (the checksum detects accidental damage, not deliberate rewriting). It is not shared across devices.
- A rejected proposal id cannot be retried (by design: one attempt per proposal).
