# Phase 4H.8 — Live execution gate review

Modules: `src/lib/scalp-execution.ts` (pure plan/gate/reconciliation), `scalp-execution.server.ts` (server gate), `scalp-execution.functions.ts` (authenticated functions).

## State: DISABLED
- `LIVE_ORDER_EXECUTION_ENABLED = false as const` — a code constant. No environment variable, setting, request field or UI can change it (tests stub an env var and send enable fields: still refused).
- No transport: these modules contain no `fetch`, no exchange adapter import, no credential decryption and no database write (static test).
- No page or component calls the order request function; the Command Center only reads gate status (static test).

## What the prepared adapter does (pure, never sent)
- Builds an order plan only from a same-environment proposal with a Central Risk ACCEPT; a paper proposal can never become a live or Testnet plan (no conversion path).
- Deterministic client order ids (≤ 36 chars, Binance charset) tagged by environment and leg (entry/stop/take-profit).
- Protection as reduce-only close-position STOP_MARKET / TAKE_PROFIT_MARKET on the mark price. **The parameter mapping was not checked against Binance's current conditional-order API** (Binance has moved conditional orders to a separate algo endpoint); it must be re-verified on Testnet before any use.
- Endpoints limited to the shared USD-M allowlist; no withdrawal/wallet/transfer endpoint.
- Uncertain submits are settled by lookup only; resubmission is never allowed; "not found" counts only after a cooling period.
- Protection verification and exchange reconciliation report missing/wrong-side/mismatched stops, unverifiable state (→ contain reduce-only), and position/fill/balance mismatches.

## Gate conditions (all required, each reported separately)
code flag, environment (live/testnet only), credentials in the same environment (no fallback), live opt-in, emergency stop off (unknown ≠ off), certification PASS, Central Risk ACCEPT, decision fresh, no unresolved orders, protection verifiable.

## Server gate
Strict input (only proposal id, environment, symbol). Anything else — enable flags, quantities, leverage, unknown environments, other symbols, non-objects — is refused before the gate. Valid requests are refused with `LIVE_ORDER_EXECUTION_DISABLED` and an audit line with a correlation id; credential-looking values are never logged. Audit lines go to platform logs only (retention NOT VERIFIED).

## Tests — `src/test/phase4h8-gate.test.ts` 19/19 PASS

## Result: PASS (disabled and unbypassable in code). Real exchange behaviour: NOT VERIFIED (no Testnet or real orders were placed, by instruction).
