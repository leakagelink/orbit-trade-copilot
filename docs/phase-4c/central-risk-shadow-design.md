# Central Risk Shadow — Phase 4C design

## Status
DESIGN ONLY

**Designed but not implemented:** Phase 4C proposes a future observation boundary, not an execution gate. A hypothetical ACCEPT is a diagnostic result — never a trading recommendation or authorization. Nothing in this workstream changed code.

Companion documents: `shadow-input-contract.md` (field-level contract and source-to-field matrix), `shadow-safety-invariants.md` (invariants and the tests that enforce them).

## Architecture (future, observe-only)

```text
Existing Futures trade ticket (futuresTicket, src/lib/futures.ts:2-8)
    |
Existing order path makes its own decision, independently and unchanged
    |
    +---- existing response / execution behaviour remains unchanged
    |
    `---- FUTURE detached, bounded observation; never awaited by the order path   <-- NOT IMPLEMENTED
              |
              ticketToProposal              (src/lib/central-risk-shadow.ts:35-47)
              |
              buildFuturesRiskContext       (src/lib/central-risk-context.server.ts:44-102)
              SELECT-only db handle + approved read ports
              |
              evaluateProposal              (src/lib/central-risk.ts:56-150)
              |
              buildShadowRecord             (src/lib/central-risk-shadow.ts:110-133)
              |
              frozen ShadowRecord, owner-scoped memory only (no persistence)
```

| Classification | Boundary | Evidence / design requirement |
|---|---|---|
| Implemented and tested | Offline adapter, context builder, evaluator and record exist | `src/lib/central-risk-shadow.ts:35-47,89-133`; `src/lib/central-risk-shadow.server.ts:44-82` |
| Implemented and tested | Ticket margin/leverage never enter the proposal (engine sizes independently, compared afterwards) | `src/lib/central-risk-shadow.ts:30-45`; `src/test/central-risk-shadow.test.ts:193-201` |
| Implemented and tested | No application source outside the shadow modules imports them | `src/test/central-risk-shadow.test.ts:236-242` |
| Designed but not implemented | Observe-only hook runs after the existing path has made its own decision | Detached; never awaited; never mutates the ticket or response; cannot throw into the order path |
| Requires separate owner approval | Any future observation connection, including Live observe-only | Existing isolation tests deliberately prohibit it; approval must precede a reviewed implementation and an explicit test-policy change |
| Designed but not implemented | Cloudflare Worker lifecycle | Bounded lifetime, cancellation and resource limits without an endpoint, scheduler or order-path dependency |

The evaluator already converts ordinary read/evaluation failures into non-authorizing INSUFFICIENT_DATA records (`src/lib/central-risk-shadow.server.ts:44-82`). That does not prove non-interference for a future caller: the detached invocation itself must contain synchronous and asynchronous failures.

## Correlation with Futures tickets (without exposing credentials or exchange identifiers)

| Classification | Contract |
|---|---|
| Implemented and tested | `correlationId = futures:<requestId>`; `accountId` = internal connection UUID (`src/lib/central-risk-shadow.ts:120-130`) |
| Implemented and tested | The same convention as the existing order claim: `orders.idempotency_key = futures:<requestId>` (`src/lib/central-risk-context.server.ts:60`) |
| Designed but not implemented | Correlate by `correlationId` + internal connection UUID only. Neither is an exchange account identifier |
| Designed but not implemented | Records, provenance and errors never contain API keys/secrets, exchange UID, broker account id or exchange order ids |
| Requires separate owner approval | Before any record leaves owner scope, replace the connection UUID with an owner-scoped keyed hash (key lifecycle + retention approval) |
| Implemented and tested | `contextSnapshotHash` hashes the RiskContext only — not the ticket or identity envelope (`src/lib/central-risk-shadow.ts:130`; `src/test/central-risk-shadow.test.ts:187-191`) |
| Designed but not implemented | Errors/provenance use bounded safe codes; current exception-message capture (`src/lib/central-risk-shadow.server.ts:68`) is not a comprehensive secret-redaction guarantee |

## Unresolved data dependencies

All rows are **Blocked by missing data** unless stated otherwise.

| Dependency | Current boundary |
|---|---|
| Strategy budget | Table only in draft 0045 (not applied); proposed successor 0046 (draft, not applied) in `docs/proposed-migrations/`. Builder reads `max_loss` (`src/lib/central-risk-context.server.ts:56,98`) |
| Strategy loss attribution | Real orders/positions/trades carry no immutable strategy identity; port returns null (`src/lib/central-risk-shadow.server.ts:31`; matrix `src/lib/central-risk-shadow.ts:59`). See `strategy-attribution-design.md` |
| Maintenance margin | Needs signed `GET /fapi/v1/leverageBracket`, absent from the exact allowlist (`src/lib/binance-futures-env.ts:42-49`) |
| Available margin | `/fapi/v3/account` is already GET-allowlisted for the order path, but the shadow path has no credential decryption and is forbidden from importing it (`src/lib/binance-futures-env.ts:45`; `src/lib/central-risk-shadow.server.ts:30`) |
| Testnet mark and lot/minNotional | Null by design; production prices are never substituted (`src/lib/central-risk-shadow.server.ts:28-29`) |
| Testnet-only emergency stop | Needs draft 0042; builder uses the shared account stop for both environments (`src/lib/central-risk-context.server.ts:95-96`) |
| Policy values — Requires separate owner approval | `liquidationBufferPct=2`, `maxDataAgeMs=5000`, `maxProposalAgeMs=60000`, `roundTripCostPct=0.13` are NOT APPROVED (`src/lib/central-risk-context.server.ts:14-15,91`) |

## Post-decision observation caveat

**Designed but not implemented:** an observation taken after the order path claims its intent sees its own order as a duplicate (`idempotency_key`) and as an unresolved order (`src/lib/central-risk-context.server.ts:59-60`); the evaluator then REJECTs (`src/lib/central-risk.ts:73-75`). The future design must record observation timing explicitly; it must never silently exclude the order, and a diagnostic REJECT is never an instruction to cancel anything. Alternative snapshot semantics (e.g. evaluate on a pre-claim snapshot) need owner review.

## Future integration approval checklist

Every item is **Requires separate owner approval**.

- [ ] Exact observe-only hook location and timing (after the existing decision, never awaited).
- [ ] Detached lifecycle, timeout, cancellation and resource limits.
- [ ] Change to the import-isolation policy — no blanket exemption.
- [ ] Each policy value individually (buffer, data age, proposal age, cost).
- [ ] Successor 0046 separately; verify deployment before relying on its table.
- [ ] Attribution migration + order-path tagging separately.
- [ ] Any signed endpoint / allowlist change separately.
- [ ] Credential decryption in a narrowly scoped read-only port separately.
- [ ] Testnet market sourcing and Testnet-only stop semantics separately.
- [ ] Privacy, retention and any future persistence (shadow ledger migration) separately.
- [ ] Failure, environment and non-interference tests pass before enabling; order responses proven unchanged.

No migrations were applied. No orders were placed. Nothing in this document is connected to any order path.
