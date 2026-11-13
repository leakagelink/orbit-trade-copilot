# Owner decision register — Phase 4E (supersedes `docs/phase-4d/owner-decision-register.md`)

Nothing here is decided. Every item is **NOT APPROVED** until the owner approves it explicitly. No value below is
hard-coded as approved policy: the Central Risk shadow keeps reading the Phase 4A proposal object
(`CENTRAL_RISK_POLICY_PROPOSAL`, labelled as a proposal) only to classify shadow records, and the paper engine takes
every value as caller input. Nothing is enforced on any real or Testnet order.

## 1. Policy values

| Policy | Proposed | Status | Options | Consequences |
|---|---:|---|---|---|
| Liquidation buffer (stop must sit at least this far from estimated liquidation) | 2% of entry | **NOT APPROVED** | (a) 2%; (b) higher, e.g. 3–5%; (c) per strategy; (d) leave unset (Futures sizing stays INSUFFICIENT_DATA) | Higher → lower leverage, fewer liquidations, smaller size. Lower → more size, stop closer to liquidation. (d) keeps every Futures shadow/paper sizing at INSUFFICIENT_DATA. Needs the maintenance-margin source (signed read, not on the allowlist). |
| Maximum mark age | 5 s | **NOT APPROVED** | (a) 5 s; (b) 2 s; (c) 15–30 s; (d) per data source | Shorter → more INSUFFICIENT_DATA on slow public feeds; longer → decisions on older prices. Paper fills use the candle's own mark open (age 0, structural). |
| Maximum proposal age | 60 s | **NOT APPROVED** | (a) 60 s; (b) 10–30 s for Engine B; (c) per engine | Shorter blocks slow pipelines (higher-timeframe research); longer admits stale signals. |
| Round-trip cost assumption | 0.13% | **NOT APPROVED** | (a) 0.13%; (b) measured from fills (none exist — no orders authorized); (c) per symbol/venue tier | Too low under-reserves the strategy budget and over-sizes; too high under-sizes. Also see finding C6: the cost used for reserved risk is caller-supplied today. |

## 2. Budget semantics

| Decision | Options | Consequences | Current draft behaviour |
|---|---|---|---|
| Strategy budget definition | (a) **Cumulative closed-trade loss** (each losing trade counts, wins never refill); (b) net P&L (wins refill); (c) gross loss excluding costs; (d) rolling window (e.g. 30 days) | (a) safest, budget only shrinks until raised; (b) allows continued trading after a drawdown recovers; (c) understates true cost; (d) needs a window decision | (a) in engine and 0046 — **NOT APPROVED** |
| Reserved open risk | (a) qty × stop distance + qty × entry × cost; (b) margin at risk; (c) none | (a) conservative; (c) allows over-commitment while positions are open | (a) at fill; **not** at acceptance (finding C1) |
| Acceptance vs fill | (a) keep: acceptance ignores reserved risk, fill refuses deterministically; (b) apply fill definitions at acceptance | (a) more accepted-then-cancelled entries; (b) changes sizing | (a) |
| Scope | (a) per owner across all paper accounts (0046); (b) per account; (c) per environment and owner | (a) one strategy cannot escape its budget by opening more accounts | (a) |
| Budget source | (a) table `strategy_risk_budgets` only; (b) account config | Two sources can disagree (finding C5) | both exist today |
| Daily loss day | (a) UTC day of the candle open (both sides today); (b) UTC day of the event time; (c) owner's local day | (a) simplest and consistent; exits at 00:00 count on the earlier day | (a) — **NOT APPROVED** |

## 3. Data retention and archival

| Decision | Options | Consequences |
|---|---|---|
| Paper ledger growth | (a) keep everything; (b) archive commit records older than N days to an export file, keep events; (c) monthly partitions | 1 m candles: ~1,440 commits/day/account (~525,600/year, roughly 60–80 MB/account-year with indexes); 5 m: 288/day; 15 m: 96/day. Deleting conflicts with the append-only triggers and needs its own reviewed migration. |
| Allowed timeframes | 1 m / 5 m / 15 m / 1 h | Drives growth and request volume (worker design §3). |
| Archive restorability | (a) restorable and tested; (b) evidence-only | (a) needs a restore test like the one in this phase. |
| Attribution ledger | (a) keep forever (financial lineage); (b) archive with trades | Small (a few rows per order). |
| Database export cadence | daily automatic backups exist (~14 days, no point-in-time recovery); manual export ≤ 1 per 24 h | Every migration approval should follow a fresh export + local restore verification (done for 13 Nov 2026). |

**Status: NOT APPROVED** (all of §3).

## 4. Other open decisions

| # | Decision | Status |
|---|---|---|
| 1 | Approve draft 0046 + Phase 4D engine, or first ask for a 0046 successor fixing C6 (database recomputes reserved risk) and C7 (fills require an accepted order) | Owner — recommended: successor first |
| 2 | Approve 0048 (supersedes 0047; never both) and, separately, the order-path change that captures identity in the claim transaction | Owner (two approvals) |
| 3 | Final migration numbering for unapplied drafts 0040–0048 | Owner |
| 4 | Two-phase candle ordering (C9) and missing-mark refusal at acceptance (C3) | Owner — behaviour changes |
| 5 | Read maintenance-margin brackets / available margin (signed reads; allowlist change) | Owner — NOT requested |
| 6 | Paper worker implementation (design only so far) and, separately, activation/scheduling | Owner (two approvals) |
| 7 | AI Prime Tech connection in this workspace | Not part of this phase; AI calls remain disabled by the standing rule |
