# AlgoVirt — Safety and Trading Intelligence Audit

## Decision summary

The existing application should be extended, not replaced. Research, paper trading, backtesting and native exchange execution code exist. Independent scoring, reward-hacking detection and controlled strategy promotion do not yet exist.

**Do not approve autonomous or expanded live trading yet.** Execution authorization and recovery gaps must be resolved before performance scoring can be trusted.

This audit made no application, database, integration or hosting changes and placed no trades. The existing suite was rerun: **120 tests passed**. Current preview logs say **build OK**. These results do not establish production live-trading safety.

## 1. Existing architecture

TanStack Start/React application with authenticated server functions, owner-scoped Lovable Cloud storage, exchange adapters and scheduled trading routines. The current research workflow is a TypeScript adaptation of multi-agent concepts, not an installed TradingAgents Python service.

The control plane and execution code currently share the application's server environment. There is no verified persistent Python execution service.

## 2. Actual module status

| Module | Classification | Evidence/limit |
|---|---|---|
| Research analysts, debate, trader, risk opinions, portfolio synthesis | Implemented and verified for one signed-in BTC run | Five decision reports and one historical proposal saved; reload/download and desktop/mobile checked |
| Historical proposals | Implemented and verified | Execution disabled; sizing/confidence unavailable; levels exclude fees/slippage |
| Social sentiment/on-chain intelligence | Not implemented | Authorized social feed absent; unavailable explicitly reported |
| Paper/manual trading, bots, backtests | Partially verified | Code and regression tests exist; full failure/venue matrix not verified |
| Live crypto/OANDA execution | Partially implemented | Code exists; no approved exchange-confirmed live audit performed |
| Scalping/arbitrage | Partially implemented | Native code, not Hummingbot; live/recovery limits remain |
| Account risk/kill switch | Partially implemented | Significant authorization, race and recovery gaps below |
| Independent scorecards, integrity detector, quarantine/appeals | Not implemented | AI risk opinions are not independently verified risk scores |
| Walk-forward/isolated holdout promotion | Not implemented | Backtest success is not live qualification |
| Research-to-paper workflow and research quotas | Not implemented | Usage rows exist; no complete reservation/quota workflow |
| Indian NSE/BSE live trading | Requires approval and legal/compliance review | Yahoo research is not a licensed execution/data integration |
| Market making, crypto futures governance | Not implemented | Do not infer support from exchange names |

## 3. Existing database

Read-only database inventory found **42 public tables**, all with row-level security enabled. Policy presence is not proof that every permission is correct.

Reuse: strategies/versions, bots/configurations/logs, exchange and broker connections, encrypted credentials, orders, positions, trades, portfolio snapshots, backtests/results, risk settings, audit logs, wallets, subscriptions/payments, support and notifications.

Research already has runs, analyst outputs, reports, decisions, usage and proposals. `connection_credentials` has no user policy, consistent with service-only access. Owner/MFA-scoped research reads were confirmed. Avoid parallel duplicate trade or strategy stores.

## 4. Existing integrations

- NOWPayments is currently linked and accessible in this workspace; this audit did not create an invoice or recheck payment execution.
- AI Gateway SDK and Yahoo research/data calls are present. The earlier real research run verifies that path, not every provider.
- Binance, Bybit, OKX, KuCoin and OANDA adapters exist; actual account permissions and every venue's execution behavior remain unverified.
- Two active minute schedules are registered: engine tick and price alerts. Registration does not establish delivery reliability, hosted timeout behavior or non-overlap.
- No installed TradingAgents, Freqtrade, Hummingbot, Hummingbot API or day-trader-skill integration was located in this checkout.

## 5–8. Repository compatibility

| Repository | Verified license | Compatibility decision |
|---|---|---|
| TradingAgents | Apache-2.0 | Python ≥3.11/LangGraph research. Reuse concepts in existing TypeScript workflow; exact Python package needs separate compatible runtime evaluation |
| Freqtrade | GPL-3.0-only | Python ≥3.12 crypto engine with REST API and persistent process; requires external runtime and license/distribution review if adopted |
| Hummingbot | Apache-2.0 | Python/Cython continuous exchange execution; external runtime for full engine |
| Hummingbot API | MIT | FastAPI control service; standard deployment includes PostgreSQL, EMQX and privileged Docker management; do not expose Docker control to app users |
| day-trader-skill | MIT | Claude workflow definitions and Python helpers, not a plug-in executable by Lovable AI; adapt audited logic only |

Pin exact commits and audit dependency notices before adoption. Repository licenses do not grant financial-data redistribution rights or trading permission.

## 9. Runtime feasibility

The current Lovable application runtime supports its TypeScript/fetch-based server functions and scheduled endpoints. It does not provide a demonstrated host for these persistent Python/Docker trading engines. Cloudflare has a separate Python Workers capability, but that does **not** establish compatibility with this project's runtime or these complete dependencies.

Native TypeScript scoring and bounded jobs can stay in the existing application. Continuous multi-venue engines may need an isolated external execution service with authenticated narrow APIs, durable state and approved networking. No new infrastructure should be deployed without a separate approval. Exact hosted execution/resource limits and sustained reliability are unverified; do not assume HFT suitability.

## 10. Security and reward-hacking findings

### Critical: protect execution authority first

1. **Direct bot state writes:** deployed policies allow eligible owners to write bot rows. The live-confirmation function alone does not enforce the exclusive live-promotion boundary. Static risk confirmed by database policies; no exploit/trade attempted.
2. **Connection trust:** owners can update connection rows, while engine lookup lacks an explicit owner match. Existing connection foreign keys do not bind both row owners. Verification status and cross-owner references need server-enforced protection.
3. **Ambiguous executions:** bot order timeouts are treated as rejection; exit exception handling can free an idempotency key for retry. Exchange acceptance may already have occurred. Unknown outcomes must lock and reconcile, not resubmit blindly.

### High priority

- Account risk reads can fail open; entry checks and reservations are not atomic. Daily loss uses realized results, allowing open losses to be omitted from that limit.
- Paused/stopped bots fall outside normal tick selection; failed emergency exits may lose scheduled recovery. Current kill switch does not prove cancellation, reconciliation or fencing of in-flight entries.
- Audit events and strategy versions accept user-originated inserts. No verified tamper-evident retention; bot logs can disappear with bot deletion. Users are not granted authority to edit trades through a permissive write policy, but authoritative evidence needs stronger provenance.
- Live bot accounting can omit entry fees.
- Backtests use same-bar close fills and simplified gap handling; costs can be zero. Stored evidence truncates trades and downsamples equity. Dataset/config/code manifests and isolated holdouts are absent.
- Proposal JSON CHECK permits missing keys through SQL NULL semantics; tighten presence/types as defense in depth. Current application validation still disables execution.

These are auditable implementation findings, not proof of an exploited incident. Existing passing tests do not cover every adversarial scenario in the new document.

## 11. Proposed scoring and evidence

Use the document's versioned initial weights, **not a claim of optimality**:

| Component | Weight | Verified measurements |
|---|---:|---|
| Net risk-adjusted performance | 20% | Net excess return, Sharpe/Sortino, expectancy, profit factor, drawdown; all costs included |
| Risk management | 20% | Drawdown, expected shortfall, loss/exposure utilization, stop discipline and policy compliance |
| Out-of-sample robustness | 15% | Frozen holdout, walk-forward consistency, parameter/cost sensitivity |
| Execution quality | 15% | Confirmed fills, shortfall, spread, rejection/partial-fill rates, latency and reconciliation |
| Prediction/calibration | 10% | Timestamped forecasts, actual horizon outcomes, Brier skill against baseline, calibration and directional diagnostics |
| Regime adaptability | 10% | Point-in-time regime labels, supported-regime and worst-regime outcomes |
| Integrity/compliance | 10% | Provenance, immutable experiment history, permissions and reconciliation evidence |

Normalize each metric with predeclared unacceptable/target anchors: `utility = 100 × clamp((metric − unacceptable)/(target − unacceptable), 0, 1)`, reversed for lower-is-better metrics. Anchors and subweights must be approved and frozen before holdout evaluation.

Composite: `0.20P + 0.20R + 0.15B + 0.15E + 0.10Q + 0.10G + 0.10I`.

**Hard rejection overrides every score** for material leakage, fabricated evidence, unauthorized action or critical risk breach. Missing required evidence or inadequate independent samples produces `INSUFFICIENT_DATA`, not a perfect score or redistributed weights. Set sample/duration gates from precision requirements, not arbitrary promises.

Show raw metrics and dependence-aware confidence intervals; proposed initial reporting convention is 95%, subject to approval. Nonprobabilistic strategies must not receive fabricated calibration scores. Portfolio concentration, covariance, liquidity and marginal risk get a separate assessment, not an average of strategy scores.

## 12–13. Additive storage and UI changes

Add only missing equivalents: agent permissions/messages, evaluation runs, scoring-model versions/components, evidence manifests, risk decisions/reservations, integrity events, quarantine/review/appeals, promotion approvals and allocation recommendations.

Strengthen existing strategy versions, audit retention, fills/reconciliation and mode-separated records. Protect score rules from agent edits.

Extend existing screens with score breakdown/evidence, integrity alerts, comparable strategy results, regime coverage, backtest/paper/live comparison, risk recovery and allocation review. Label verified, simulated, estimated and AI-opinion data distinctly. No cosmetic replacement of working modules.

## 14. Proposed implementation sequence

1. **Authority and recovery:** protect bot/connection transitions and owner references; fail-closed atomic risk reservations; unknown-fill reconciliation; durable emergency handling.
2. **Evidence foundation:** complete net-cost ledger, server-authenticated audit trail, frozen strategy/dataset manifests and reproducible next-bar/gap-aware backtests.
3. **Independent evaluation:** versioned components, sufficiency/uncertainty, leakage and integrity detectors; no LLM self-scoring.
4. **Governance:** quarantine/review/appeals and backtest → holdout → paper → risk review → explicit restricted-live approval.
5. **Dashboard and recommendations:** explainable comparable scorecards and allocation proposals; no automatic live capital increases.
6. **Optional integrations:** paper-only evaluation of approved external engines; separate Indian market compliance and infrastructure decision.

Add tests for hidden losses, fabricated fills, unauthorized tools/data, mutated experiments, risk races, unknown/partial fills, halted entries and audit integrity. Do not use real live orders during development/testing.

## 15. Cost estimate method

Audit added no hosting/integrations. Native scoring mainly adds storage and compute; LLM grading is not required for numeric scoring.

Reliable pricing requires workload and current quotations: monthly cost = compute + storage/backups + network + data/broker subscriptions + LLM tokens + monitoring. Research costs use recorded input/output tokens per run; continuous engines require persistent uptime and recovery capacity. Hummingbot API additionally requires its API, database, broker and bot services. No defensible fixed monthly quote is available yet; earlier $5–20 estimates are not a production reliability budget.

Compare low/base/high workloads and dated provider quotes before external approval. Include broker fees, slippage, funding/borrow, data rights and operating effort separately.

## 16. Blockers and approvals

- Approval of the implementation sequence, scoring configuration and evidence gates is required before code changes.
- External execution hosting, broker integrations and live activation each require separate approval; none is implied by approving this plan.
- Indian live algo trading requires current SEBI/exchange requirements, broker-approved API pathway, applicable static-IP/order-tagging requirements and qualified compliance review. Research-only Yahoo symbols do not satisfy these requirements.
- Authorized social data, production feed entitlements, workload/cost budget and isolated venue testing remain dependencies.

## Technical evidence and sources

Local: `src/lib/bots.functions.ts`, `engine.server.ts`, `backtest.ts`, `backtests.functions.ts`, `research.functions.ts`, `research.server.ts`, `research-proposal.ts`; migrations `0000`, `0003`, `0019–0021`. Read-only deployed catalogs confirmed table RLS, bot/connection policies, owner-unbound connection FK, research persistence, connector linkage and schedule registration.

Upstream licenses/runtime reviewed at pinned snapshots:
- [TradingAgents](https://github.com/TauricResearch/TradingAgents/tree/9fa1196fffbcfd9de5146d2dd2869df84ab99838)
- [Freqtrade](https://github.com/freqtrade/freqtrade/tree/4f836e63ec62b2248163492c08f89d87b51267e3)
- [Hummingbot](https://github.com/hummingbot/hummingbot/tree/9af100d6822da7d2d0291a906c730ef172284ee2)
- [Hummingbot API](https://github.com/hummingbot/hummingbot-api/tree/7ae108f11bf20651682dbdff639a8717068c5883)
- [day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill/tree/3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd)
- [Python Workers package limits](https://developers.cloudflare.com/workers/languages/python/packages/)
- [NSE algo/API implementation standards](https://nsearchives.nseindia.com/content/circulars/INVG67858.pdf)
- [NSE current algo application information](https://www.nseindia.com/static/trade/platform-services-non-neat-decision-support-tools-algorithm-trading)

**Stop here for approval.** No migration, dependency installation, integration change, deployment or live activation is authorized by this audit.