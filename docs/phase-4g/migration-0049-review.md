# Draft 0049 — independent review (Phase 4G, 13 Nov 2026)

Scope: `docs/proposed-migrations/0049_futures_paper_ledger_v3.sql` (SHA-256 `fe4dd56c…abcd35`, unchanged) and its rollback
(`e5931321…fb5fb`, unchanged), read line by line against the Phase 4F engine layer and worker. 0049 was **not applied**
anywhere. The hosted database has no 0045, 0046 or 0049 object (read-only catalog check, 13 Nov 11:45 UTC): no
`futures_paper*`, `*risk_budget*` table and no `fp2_*`/`fp3_*`/`futures_paper*` function; 40 applied migrations, the latest
hash equal to `drizzle/migrations/0039_…sql`. 0049 itself refuses to install over 0045/0046 (same object names; tested
in Phase 4E on the real export).

**Verdict: sound for its stated scope, with two findings that matter before any activation (G1, G2) and one that
matters for any hosted caller (G3).** G1, G3, G4, G5 and G6 are addressed by the separate draft 0050 (below), so 0049
stays byte-identical. G2 remains open.

| ID | Severity | Area | Finding | Evidence | Resolution |
|---|---|---|---|---|---|
| G1 | High | Freshness / look-ahead | An approval's time must equal the candle close, so the 0049 price-age check (`v_t - close > max age`) is always 0. A lagging worker could approve entries from candles that closed long ago, with later prices already known. | `futures-paper-worker-gateway.test.ts` "G1" (40-minute-old candle, 5 s limit) | **0050** refuses `order_accepted` when the database clock says the candle closed longer ago than the account's max data age; the hosted connection withholds intents in that case. Exits and bookkeeping continue. |
| G2 | High (integrity of evidence) | Completeness | 0049 validates every event a worker submits, but does not require the events the recorded candle implies: a recorded stop crossing or liquidation-level mark with no exit, or a recorded funding entry with no funding cash, is accepted. The exit *reason* is not checkable (take-profit and maximum hold are not stored). Exit prices are bounded by the recorded candle range only. | `migration-0049-review.test.ts` (3 characterization tests; the control shows out-of-range exits are refused) | **Open — owner decision (register G-3).** The Phase 4F engine always produced these events (zero refusals over 3,264 replayed candles), so the risk is a faulty or altered worker. Closing it needs a 0049 successor that evaluates stops/liquidation/funding itself. |
| G3 | Medium | Concurrency | Budget serialization relies on READ COMMITTED: after waiting for the owner's budget row lock, each statement sees the other transaction's approvals. A caller at REPEATABLE READ computes usage from its first snapshot. | Real PostgreSQL: budget 12 → usage **19.9988** at REPEATABLE READ; refused (usage 9.9994) at READ COMMITTED (3/3 runs) | **0050**: the only commit path refuses any isolation other than READ COMMITTED, and direct EXECUTE on the 0049 commit is revoked from `service_role`. |
| G4 | Medium | Locking | 0049 has no lease. Session advisory locks (used by the Phase 4F tests) do not survive the hosted Data API, where every request is its own transaction. | Design | **0050**: lease rows with a fencing token, checked and renewed inside the commit transaction. |
| G5 | Medium | Provenance | Candle prices are recorded, but not their source, fetch time or payload fingerprint. Two accounts can record different prices for the same public candle. | Design | **0050**: append-only provenance row per candle (source, timeframe, open/close, fetch time, worker-reported raw SHA-256, database hash of the recorded values, `independently_verified` forced false); conflicting public OHLC across accounts is refused. |
| G6 | Medium | Audit | Status and halt changes (pause, resume, stop, halted) by `service_role` leave no trace; a review hold can be lifted silently. | Design | **0050**: append-only audit row per change with a bounded code and actor. |
| G7 | Low | Idempotency | `order_rejected` events are not linked to an approval and do not mark a proposal as evaluated; the same proposal id could be proposed again later (it would be re-checked in full). | Code reading | Accepted; documented. |
| G8 | Low | Validation | `entry_cancelled` does not compare the side with its approval. | Code reading | Accepted (no cash effect). |
| G9 | Low | Privileged bypass | Any non-API database role (e.g. the database owner) can set the transaction flag and edit ledger tables directly. | Code reading | Accepted: operator-level only; the commit table keeps payload hashes. |
| G10 | Operational / data loss | Rollback | The 0049 rollback drops all paper history; with 0050 present it now fails as a whole (dependency), so 0050 must be rolled back first. | `futures-paper-worker-gateway.test.ts` rollback tests; real-export restore | Documented in both rollback headers; export first. |
| G11 | Info | Isolation | Owner always derived from the account row; owner-only, MFA-aware reads; proposal ids unique per owner; production tables unreachable. | Phase 4E/4F tests, unchanged | Pass. |
| G12 | Info | Prices | All prices are worker-supplied public data; nothing in 0049 or 0050 can verify them independently. | — | Stated in every provenance record. |

Transaction boundaries: one function call per candle; any refusal rolls back everything for that candle, including
recorded candles (tested on real PostgreSQL in Phase 4F and again here through the gateway). Identical replays return
the committed sequence without writing.
