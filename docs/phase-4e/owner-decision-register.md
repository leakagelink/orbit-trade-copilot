# Owner decision register — Phase 4E (supersedes `docs/phase-4d/owner-decision-register.md`)

**Update 13 Nov 2026 (owner decisions, Phase 4E follow-up).** The owner set PROPOSED paper-only values (§1), chose the
budget structure (§2), proposed retention periods (§3), rejected 0046 and approved 0048 for the next review/validation
stage (§4). Proposed values remain **NOT APPROVED for execution** until validation and explicit approval.

Nothing here is decided. Every item is **NOT APPROVED** until the owner approves it explicitly. No value below is
hard-coded as approved policy: the Central Risk shadow keeps reading the Phase 4A proposal object
(`CENTRAL_RISK_POLICY_PROPOSAL`, labelled as a proposal) only to classify shadow records, and the paper engine takes
every value as caller input. Nothing is enforced on any real or Testnet order.

## 1. Policy values (owner proposals of 13 Nov 2026 — paper only)

| Policy | Owner proposal (paper only) | Status | Where it is used | Validation still needed |
|---|---:|---|---|---|
| Liquidation buffer (stop at least this far from estimated liquidation, % of entry) | **5%** (replaces the earlier 2% proposal) | **PROPOSED — NOT APPROVED for execution** | Paper account config `limits.liquidationBufferPct`; draft 0049 re-checks it at approval | Maintenance-margin source is still the first bracket from config (signed bracket read not on the allowlist); replay impact on trade count |
| Maximum price age | **5 s** | **PROPOSED — NOT APPROVED for execution** | `limits.maxDataAgeMs`; 0049 checks approval and fill price age (candle prices are age 0 by construction) | Public-feed latency measurement before any live use |
| Risk proposal expiry | **60 s** | **PROPOSED — NOT APPROVED for execution** | `limits.maxProposalAgeMs`; 0049: proposal age at approval ≤ 60 s and approval expires 60 s after it is granted | With 1 m candles a partial remainder may fill on at most the next candle; with 5 m/15 m only at the first open (see §5 item E1) |
| Estimated trading cost (round trip) | **0.13%**, configurable per instrument/strategy | **PROPOSED — NOT APPROVED for execution** | Account default `limits.roundTripCostPct`; overrides in `futures_paper_cost_assumptions` (exact → strategy → symbol → default), frozen on each approval | No measured fills exist (no orders authorized); overrides carry `validation_status = unvalidated` |

No value is hard-coded as approved policy: the paper engine and 0049 take every value as frozen account configuration.

## 2. Budget semantics

**Owner decision (13 Nov 2026): account-level budgeting with separate Research and Scalping sub-budgets; open AND pending
exposure in shared checks; strategy budgets may never add up past the central account budget.** Implemented as code and
draft only (`src/lib/account-risk-budget.ts`, draft 0049); not connected to any order path.

| Decision | Current draft behaviour | Status |
|---|---|---|
| Structure | One account budget per owner (paper); Research and Scalping sub-budgets; each strategy in exactly one sub-budget | **Owner decided** (structure) — amounts are configuration, none approved |
| Static nesting | Σ sub-budgets ≤ account budget (table CHECK); Σ strategy budgets of a sub-budget ≤ that sub-budget (guard, serialized on the account budget row) | Implemented in draft 0049 + pure module |
| Usage definition | Cumulative closed-trade losses (wins never refill) + reserved risk of open positions + risk of pending approval remainders | Closed-loss definition (a) still **NOT APPROVED**; open + pending inclusion is the owner's decision |
| Checks | Every approval and fill: strategy ≤ strategy budget, sub-budget usage ≤ sub-budget, account usage ≤ account budget | Implemented (draft) |
| Exposure / positions / margin | Open positions + pending remainders at the current candle's marks | Implemented (draft) — resolves finding C2 for the database |
| Scope | Per owner across all paper accounts | Unchanged |
| Single budget source (C5) | Database tables are authoritative in 0049; the engine still reads `cfg.strategyBudgets` | Engine alignment needs approval (§5 E2) |
| Daily loss day | UTC day of the candle open | **NOT APPROVED** |

## 3. Data retention and archival

**Owner proposal (13 Nov 2026), configurable — PROPOSED, NOT APPROVED, NOT ENFORCED** (details:
`retention-and-deletion-policy.md`; contract: `src/lib/retention-policy.ts`).

| Category | Proposed period | On expiry | On account deletion |
|---|---:|---|---|
| Orders, fills, risk approvals, attribution, audit records | 2 years (730 days) | Archive to a restorable export, then delete | Anonymize (one-way tombstone owner ID, personal free text redacted) and keep until expiry |
| Raw AI prompts and provider outputs | 90 days | Delete | Delete |
| Temporary debug logs | 30 days | Delete | Delete |

Legal hold overrides everything. Still open: table mappings marked "confirm", legal review (India DPDP Act 2023 / US),
paper-ledger growth (1 m candles ≈ 525,600 commits and up to 1.05 M candle rows per account-year), archive restore test.

## 4. Other open decisions

| # | Decision | Status |
|---|---|---|
| 1 | Draft 0046 | **NOT APPROVED (owner, 13 Nov 2026)** — never apply. Replacement draft **0049** written (database recomputes risk; fills need a valid matching unexpired approval); awaiting owner review |
| 2 | Draft 0048 (supersedes 0047; never both) | **Approved for the next review and validation stage (owner, 13 Nov 2026) — NOT to be applied yet.** 0047 permanently superseded. The order-path change that captures identity needs its own approval |
| 3 | Final migration numbering for unapplied drafts 0040–0049 | Owner |
| 4 | Two-phase candle ordering (C9) and missing-mark refusal at acceptance (C3) | Owner — behaviour changes |
| 5 | Read maintenance-margin brackets / available margin (signed reads; allowlist change) | Owner — NOT requested |
| 6 | Paper worker implementation and, separately, activation/scheduling | Owner (two approvals) — nothing built or scheduled |
| 7 | AI Prime Tech connection in this workspace | Not part of this phase; AI calls remain disabled by the standing rule |

## 5. Engine alignment needed before any 0049 worker (each changes paper-engine behaviour → owner approval)

| # | Item | Why |
|---|---|---|
| E1 | Engine cancels a pending remainder when its approval expires (today: after `entryTtlBars`) | Otherwise 0049 refuses the fill and the refusal planner halts for review |
| E2 | Engine reads strategy, sub-budget and account budgets from the database and sizes acceptance with `riskEngineStrategyBudget` (closed + open + pending) | Resolves C1/C5; today 0049 can refuse an approval the engine accepted, which the planner cannot classify (halt for review) |
| E3 | Planner classification for approval-time refusals (`approval refused: …`) | Today they are UNCLASSIFIED → halt for review (safe, but stops the account) |
| E4 | Per-instrument/strategy cost used by the engine at acceptance | A higher database cost than the engine's makes 0049 refuse (tested) |
