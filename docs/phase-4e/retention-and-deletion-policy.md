# Retention, account deletion, anonymization and audit preservation — PROPOSED, NOT APPROVED, NOT ENFORCED

Owner proposal of 13 Nov 2026. Nothing here deletes, archives or anonymizes anything today: no migration, job or schedule
exists. The executable contract (periods, actions, validation, legal hold) is `src/lib/retention-policy.ts`, tested in
`src/test/retention-policy.test.ts`. It extends — and for the categories below replaces — the earlier research-only draft
`docs/research/research-data-retention-policy.md`. Not legal advice; a short legal review (India DPDP Act 2023, US
seller obligations, any tax/billing rules) is recommended before approval.

## 1. Configurable periods

| Category | Default (proposal) | Allowed range | On expiry | On account deletion |
|---|---:|---|---|---|
| `trading_audit` — orders, fills, risk approvals, attribution, audit records | 730 days (2 years) | 1–3650 days | archive to a restorable export, then delete | anonymize and keep until expiry |
| `ai_raw` — raw AI prompts and provider outputs | 90 days | 1–3650 days, never longer than `trading_audit` | delete | delete |
| `debug_logs` — temporary debug logs | 30 days | 1–3650 days, never longer than `trading_audit` | delete | delete |

Validation refuses a configuration that would delete audit records with an account, delete expired audit records without
archiving, keep raw AI text or debug logs after account deletion, or keep them longer than audit records. An invalid
configuration removes nothing.

## 2. Proposed table mapping (`RETENTION_TABLE_MAP`; "confirm" = owner must confirm)

- **trading_audit:** orders, trades, positions, futures_broker_events, order_recovery_observations,
  futures_certifications, futures_verifications, trading_safety_events, audit_logs, wallet_transactions (demo),
  arbitrage_runs, autopilot_runs, strategy_integrity_events, ai_research_decisions (confirm), ai_trade_proposals
  (confirm); drafts: futures_paper_events, futures_paper_risk_approvals, futures_paper_commits, futures_paper_candles
  (confirm — public prices, could be shorter), futures_order_strategy_identity, futures_strategy_attribution_events.
- **ai_raw:** ai_sessions, ai_agent_outputs, ai_strategy_generations, ai_research_reports (confirm), ai_research_runs
  (confirm — mixes AI text with run status and evidence).
- **debug_logs:** bot_logs (confirm — may be operational history). Hosting/server logs are kept by the platform under
  its own retention and are not configurable from the app.
- **Not covered (unchanged):** profiles, user_roles, subscriptions, billing_events, crypto_payments (financial/tax rules
  apply), connection_credentials, exchange/broker connections, support mailbox, notifications, watchlists, alerts,
  journal, strategies/versions, backtests, settings.

## 3. Account deletion rules (design)

1. **Legal hold first.** A record under legal hold is kept unchanged, whatever its age or account state.
2. **Credentials and connections** follow the existing disconnect/deletion behaviour (not changed here).
3. **ai_raw and debug_logs** of the account are deleted in the same erasure transaction.
4. **trading_audit** records are kept until their own expiry and anonymized: `user_id` is replaced by a one-way
   tombstone ID (keyed hash of the user ID with a server-only secret, so the same person maps to one tombstone and
   cannot be reversed from the data); personal free text (notes, journal-like reasons, email addresses) is redacted;
   amounts, prices, quantities, timestamps, sequence numbers, proposal/strategy IDs and refusal codes stay so the audit
   trail still reconciles.
5. **Audit preservation:** before redaction, an append-only erasure event records the tombstone, time, tables, row
   counts and the SHA-256 of each record; the redacted record stores its new SHA-256 next to the original. An auditor can
   prove a record was redacted and matched its original fingerprint, without seeing the person.
6. If the erasure step fails, the sign-in account deletion stops and is reported (never a half-erased account).

## 4. Expiry (design)

A service-only database function is the only path past the append-only triggers (transaction-local flag set only by
that function, like the paper ledger's commit flag). For `trading_audit` it first writes a restorable archive (export
file + SHA-256, practice-restored like the database exports), records the archive identity in the erasure/expiry log, and
only then deletes. Deletion in the Futures paper ledger must keep each account's sequence chain verifiable (archive whole
account-days, never single rows).

## 5. Not built — needs separate approval

A reviewed migration (erasure/expiry function, erasure log, trigger changes) with PGlite and real-PostgreSQL tests and a
real-export practice restore; a scheduled job (separate approval); the user-facing export before deletion.
