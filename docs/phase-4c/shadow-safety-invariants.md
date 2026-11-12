# Shadow safety invariants

## Status
DESIGN ONLY

ACCEPT is not execution authorization or a trading recommendation.

| Classification | Invariant | Enforcement today | Test evidence / gap |
|---|---|---|---|
| Implemented and tested | `executionAuthorized=false`, `affectsOrderPath=false`, `shadowOnly=true` | Literal record values `src/lib/central-risk-shadow.ts:131`; fallback `src/lib/central-risk-shadow.server.ts:78` | `src/test/central-risk-shadow.test.ts:60-80` |
| Implemented and tested | Ticket size/leverage never become sizing authority | Adapter projection `src/lib/central-risk-shadow.ts:40-45` | `src/test/central-risk-shadow.test.ts:193-197` |
| Implemented and tested | Shadow cannot reach execution, broker/exchange, credential, wallet, order, authorization, Autopilot or AI modules | Transitive import-graph exclusion | `src/test/central-risk-shadow.test.ts:230-234` |
| Implemented and tested | Those modules do not import shadow | All non-test importers excluded; order roots checked transitively | `src/test/central-risk-shadow.test.ts:236-242` |
| Implemented and tested | Database access is SELECT-only | Narrowed handle `src/lib/central-risk-context.server.ts:18-25` | Write/RPC spies + source assertions `src/test/central-risk-shadow.test.ts:155-160` |
| Implemented and tested | No signed exchange requests from shadow ports | Public GET only; margin/attribution ports return null (`src/lib/central-risk-shadow.server.ts:24-31`) | `src/test/central-risk-shadow.test.ts:162-170` |
| Implemented and tested | Testnet never uses production market data | Testnet market ports return null | `src/test/central-risk-shadow.test.ts:138-146` |
| Implemented and tested | Missing critical inputs never produce sizing | Null propagation + evaluator checks | `src/test/central-risk-shadow.test.ts:76-101` |
| Implemented and tested | Ordinary injected failures resolve non-authorizing | Catch/fallback `src/lib/central-risk-shadow.server.ts:44-82` | Clock/db/port failures `src/test/central-risk-shadow.test.ts:173-185` |
| Implemented and tested | Normal records are deeply frozen | `src/lib/central-risk-shadow.ts:102,133` | `src/test/central-risk-shadow.test.ts:67` |
| Designed but not implemented | Every fallback record is deeply frozen | Last-resort fallback uses shallow `Object.freeze` (`src/lib/central-risk-shadow.server.ts:71-80`) | NOT ENFORCED BY TEST (nested fallback immutability) |
| Implemented and tested | Context hash is deterministic and context-only | `src/lib/central-risk-shadow.ts:130` | `src/test/central-risk-shadow.test.ts:187-191` |
| Designed but not implemented | No credentials or exchange identifiers in any error/provenance | Record shape has no credential fields, but exception text is copied (`src/lib/central-risk-shadow.server.ts:68`) | Fixture serialization check `src/test/central-risk-shadow.test.ts:68`; comprehensive redaction NOT ENFORCED BY TEST |
| Implemented and tested (Phase 4C) | No order/exchange/credential/route/migration file changed during Phase 4C; no new route file | SHA-256 manifest taken before any edit: `docs/phase-4c/protected-files.sha256` | `src/test/phase4c-isolation.test.ts` |
| Implemented and tested (Phase 4C) | New Phase 4C modules (`ema-forward-research.ts`, `risk-data-contracts.ts`) reach no order/exchange/credential/db module and nothing imports them | Import graph | `src/test/phase4c-isolation.test.ts` |
| Implemented and tested | No Live observe-only connection exists | Importer ban | `src/test/central-risk-shadow.test.ts:236-242` |
| Designed but not implemented | No persistence in this workstream | In-memory log only (`src/lib/central-risk-shadow.ts:139-152`) | DB writes tested; filesystem/external persistence ban NOT ENFORCED BY TEST |
| Requires separate owner approval | A future hook cannot block, resize, authorize or throw into the order path | No hook exists | NOT ENFORCED BY TEST; needs detached-call, timeout, cancellation and response-equivalence tests |
| Requires separate owner approval | No allowlist expansion or credential decryption | Port/import boundaries prohibit these today | Any relaxation is a separate owner decision, not implied by Phase 4C |

## Future approval gates

All items are **Requires separate owner approval**.

- [ ] Hook location after the existing decision, never awaited.
- [ ] Failure containment and resource/lifecycle limits.
- [ ] Exact source contracts and policy values.
- [ ] Any source migration, credential capability or adapter change, each separately.
- [ ] Privacy/retention and any later persistence.
- [ ] Review of import-test changes with equivalent capability isolation.
- [ ] Missing/stale, environment mismatch, secret-redaction and fallback-freeze tests.
- [ ] Proof that existing order responses and submission behaviour are unchanged.

No migrations were applied. No orders were placed. Nothing in this document is connected to any order path.
