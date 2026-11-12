# Research data retention and account deletion — DRAFT FOR OWNER APPROVAL

Status: **proposal only.** Nothing here is implemented. No data has been deleted, anonymized or moved. Retention
periods below are placeholders for the owner (and, where needed, legal advice) to decide; they are not legal advice.

## 1. What is stored today (facts from the code and database, 12 Nov 2026)

| Data | Table(s) | Personal or account data inside | Integrity after draft 0043 |
|---|---|---|---|
| Research runs | `ai_research_runs` | `user_id`, symbol, status, error text, market snapshot, evidence, provisional decision record (before 0043) | Frozen once finished; never deletable |
| Agent outputs / research reports | `ai_agent_outputs`, `ai_research_reports`, `ai_research_decisions` | `user_id`; AI text about public market symbols | Append-only |
| Trade proposals (advisory) | `ai_trade_proposals` | `user_id`; historical reference levels | Append-only |
| AI decision records | `ai_decision_records` (0043) | `userId`, **account risk limits, open exposure, daily P&L-derived budget** inside the risk preview, provider message IDs | Append-only, database SHA-256 |
| Risk evaluations | `ai_risk_evaluations` (0043) | `user_id`, **account exposure, available risk budget** | Append-only |
| Provider usage / timing | `ai_research_usage`, `ai_research_stage_metrics` | `user_id`, token counts, durations | Append-only |
| Spending reservations | `ai_research_budget_reservations` (0043) | `user_id`, worker ID, token counts, reported cost | Settled once, never deletable |
| Spending-limit audit history | `ai_research_budget_events` (0043) | Admin `changed_by` ID, limit values | Append-only |
| Cancel requests | `audit_logs` (`ai_research_cancel_requested`) | `user_id`, run ID | Existing audit log rules |
| Paper research | `ai_research_paper`, `ai_research_paper_observations` | `user_id`, confirmed quantities and cost assumptions | Existing protections |

Account deletion today (`adminDeleteUser`) deletes the sign-in account only. Research tables have **no** link to the
sign-in table, so research rows stay behind with the deleted user's ID (orphaned, still readable by the backend). After
0043 they also cannot be deleted at all, because the append-only triggers block every DELETE and TRUNCATE.

## 2. Proposed classification

| Class | Data | Proposal |
|---|---|---|
| A — keep as audit evidence, pseudonymize the person | Decision records, risk evaluations, agent outputs, reports, proposals, runs | Keep for **[owner decides, e.g. 24 months]** after the run; on account deletion replace the owner ID with a one-way tombstone ID and redact account figures (risk limits, exposure, budget) |
| B — keep aggregated for cost control | Provider usage, stage metrics, spending reservations | Keep for **[owner decides, e.g. 13 months]** for spending reconciliation; on account deletion pseudonymize the owner ID only (token counts are not personal) |
| C — keep while the platform operates | Spending-limit change history | Keep; if an admin account is deleted, pseudonymize `changed_by` |
| D — delete with the account | Cancel-request audit events, provisional records kept on runs before 0043 | Delete or pseudonymize with the account (owner decides) |

What can be anonymized: owner IDs everywhere; account figures inside records (exposure, risk limits, budget, daily
result). What must stay to keep the audit meaningful: run IDs, timestamps, agent outputs about public symbols, model and
prompt versions, token counts, outcomes and the fact that an evaluation was NOT_EXECUTABLE.

## 3. How deletion could work without breaking audit integrity (design, not built)

1. One service-only database function, e.g. `erase_ai_research_account(_user)`, is the **only** path allowed past the
   append-only triggers (the triggers would check a transaction-local flag that only this function sets).
2. It writes an append-only **erasure event** first: tombstone ID, time, tables touched, row counts, and the SHA-256 of
   every record before redaction.
3. It replaces `user_id` with the tombstone ID and redacts the account fields inside decision records and risk
   evaluations, then stores the new SHA-256 next to the original. An auditor can see a record was redacted, when, and
   that it matched its original fingerprint at that time — without seeing the person or their account figures.
4. Scheduled expiry (after the approved retention periods) uses the same function and logs the same events; rows past
   expiry are deleted only through it.
5. The sign-in account deletion calls this function first; if it fails, the account deletion stops and is reported.

## 4. Decisions needed from the owner

1. Retention period for each class (A, B, C, D) — or "keep indefinitely".
2. On account deletion: pseudonymize (recommended above) or fully delete research history?
3. Must account figures inside decision records and risk evaluations be redacted on deletion?
4. Which jurisdiction(s) and data-protection obligations apply (the business is described as a US seller; users may be
   in India and elsewhere). Legal review is recommended before choosing periods.
5. Should users be able to download their full research history before deleting their account?
6. Should existing orphaned rows from already-deleted accounts be pseudonymized once this is approved?

Nothing above is implemented until these are answered and the implementation is separately approved.

## 5. Recommendations for the owner (12 Nov 2026 review — still not implemented)

Not legal advice. Users may be in India (Digital Personal Data Protection Act 2023) and the business is a US seller;
a short legal review is advised before these become final.

| Class | Recommended retention | On account deletion |
|---|---|---|
| A — runs, agent outputs, reports, proposals, decision records, risk evaluations | 24 months after the run while the account exists | Within 30 days: replace owner ID with a tombstone ID; redact account figures (risk limits, open exposure, available budget, daily result) and keep the original SHA-256 next to the redacted copy. Keep the pseudonymized research (public-symbol analysis, model/prompt versions, outcomes, NOT_EXECUTABLE flag) for up to 5 years for model evaluation, then delete through the erasure function |
| B — usage, stage timings, spending reservations | 13 months (one full annual billing cycle), then roll up to monthly totals and delete rows | Pseudonymize the owner ID only |
| C — spending-limit change history | For the life of the platform | Pseudonymize `changed_by` if an admin account is deleted |
| D — cancel requests; provisional records kept on pre-0043 runs | Treat provisional records as Class A once 0043 is applied | Delete cancel-request events; provisional records follow Class A |

- **Redaction of account-specific risk figures:** yes, always on deletion (they describe the person's account, not
  the market).
- **Historical records from deleted accounts:** currently **0** research runs belong to a missing account (checked by
  counts only: 2 accounts have research history, all still present). Apply the same pseudonymization to any future
  orphans in the first erasure run.
- **User research-history export:** yes. Offer an owner-only, paginated JSON download of all their runs, decision
  records and risk evaluations (same rules as the existing exports), and show it before account deletion. Each run
  already has a single-record "Download record" button.
- **Append-only protections stay intact:** the only path past them is the single service-only erasure function, which
  first writes its own append-only erasure event. No deletion or anonymization is built until the owner approves this
  section and the implementation separately.
