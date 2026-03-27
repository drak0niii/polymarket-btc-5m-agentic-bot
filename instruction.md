# instruction.md

## Objective

Upgrade this repository from a **runtime-safe experimental bot** into a **measurably trustworthy capital-growth bot** for live BTC 5-minute Polymarket trading.

The target is **8+/10 trustworthiness** only after:

- net edge is proven **after fees, slippage, and adverse selection**
- live execution quality is measured and fed back into decisions
- regime selection is explicit and allowed to say **no trade**
- capital sizing is constrained by **evidence quality**, not just model confidence
- live canary promotion is gated by hard statistical and operational criteria

This manual is **repo-specific**. It uses the files that already exist in this codebase and tells you exactly what to add, what to modify, and in what order.

---

## Non-negotiable rules

1. **Do not weaken existing runtime and safety controls.**
2. **Do not remove reconciliation-first behavior.**
3. **Do not let live learning rewrite strategy logic broadly.**
4. **Do not scale capital based on backtests or simulated replays alone.**
5. **Every new score that affects trading must leave structured evidence.**
6. **Every new live feature must be testable in paper/canary mode first.**
7. **No change goes straight to scaled live.**

---

## What already exists and must be reused

Do **not** rebuild parallel systems for these. Extend them.

### Worker / runtime
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/reconcileFills.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/runtime/learning-state-store.ts`
- `apps/worker/src/runtime/strategy-deployment-registry.ts`
- `apps/worker/src/runtime/strategy-rollout-controller.ts`
- `apps/worker/src/runtime/runtime-state-machine.ts`
- `apps/worker/src/runtime/startup-gate.service.ts`
- `apps/worker/src/runtime/venue-open-order-heartbeat.service.ts`
- `apps/worker/src/runtime/user-websocket-state.service.ts`

### Signal / edge / calibration
- `packages/signal-engine/src/net-edge-estimator.ts`
- `packages/signal-engine/src/executable-ev-model.ts`
- `packages/signal-engine/src/live-calibration-store.ts`
- `packages/signal-engine/src/live-calibration-updater.ts`
- `packages/signal-engine/src/regime-classifier.ts`
- `packages/signal-engine/src/regime-conditioned-edge-model.ts`
- `packages/signal-engine/src/no-trade-zone-policy.ts`
- `packages/signal-engine/src/trade-admission-gate.ts`
- `packages/signal-engine/src/benchmarks/*`
- `packages/signal-engine/src/champion-challenger-manager.ts`
- `packages/signal-engine/src/promotion-decision-engine.ts`
- `packages/signal-engine/src/strategy-quarantine-policy.ts`

### Execution
- `packages/execution-engine/src/fill-probability-estimator.ts`
- `packages/execution-engine/src/slippage-estimator.ts`
- `packages/execution-engine/src/realized-cost-model.ts`
- `packages/execution-engine/src/execution-cost-calibrator.ts`
- `packages/execution-engine/src/order-planner.ts`
- `packages/execution-engine/src/marketable-limit.ts`
- `packages/execution-engine/src/fill-state-service.ts`
- `packages/execution-engine/src/execution-diagnostics.ts`
- `packages/execution-engine/src/fee-accounting-service.ts`
- `packages/execution-engine/src/queue-position-estimator.ts`

### Risk / capital / kill-switches
- `packages/risk-engine/src/live-trade-guard.ts`
- `packages/risk-engine/src/live-sizing-feedback-policy.ts`
- `packages/risk-engine/src/regime-capital-policy.ts`
- `packages/risk-engine/src/regime-local-sizing.ts`
- `packages/risk-engine/src/execution-quality-kill-switches.ts`
- `packages/risk-engine/src/expected-vs-realized-ev-guard.ts` *(add if missing in index wiring; see below)*
- `packages/risk-engine/src/consecutive-loss-kill-switch.ts`
- `packages/risk-engine/src/capital-ramp-policy-service.ts`
- `packages/risk-engine/src/trade-quality-history-store.ts`
- `packages/risk-engine/src/portfolio-kill-switch-service.ts`

---

## Critical preliminary fix before all other work

### Priority 0 — secure the repository and stop leaking production secrets

The zip contains `.env`, `.env.smoke`, and local artifacts. Treat all live credentials as **compromised** until rotated.

### Required actions
1. Rotate all Polymarket API credentials and wallet-related secrets.
2. Remove real secrets from tracked files.
3. Ensure `.env`, `.env.smoke`, `artifacts/learning/*.json`, runtime logs, and any local snapshots stay out of version control.
4. Replace local real values with placeholders in `.env.example` only.

### Files to modify
- `.gitignore`
- `.env.example`
- `apps/worker/src/config/secret-provider.ts`
- `apps/worker/src/config/env.ts`

### Changes
- Add/confirm ignore rules for:
  - `.env`
  - `.env.*`
  - `!*.example`
  - `artifacts/**/latest.json`
  - `artifacts/learning/*.json`
  - `*.log`
- In `secret-provider.ts`, fail hard in production if secrets come from unapproved local files.
- In `env.ts`, add a stricter production check requiring non-empty API credentials when `BOT_LIVE_EXECUTION_ENABLED=true` and deployment tier is not `paper`.

### Acceptance
- No real credentials remain in the repo.
- Paper mode still boots without live trading credentials if execution is disabled.
- Canary/live modes fail fast when secrets are missing.

---

## Priority order summary

### P0 — mandatory before live trust upgrade
1. Secret hygiene and environment hardening
2. Canonical live fill ledger and trade outcome evidence
3. Net-edge-after-costs truth path
4. Live-calibrated fill/execution realism
5. Regime-aware trade admission with explicit no-trade mode

### P1 — mandatory before 8/10 is realistic
6. Evidence-quality-based capital scaling
7. Promotion/demotion gates tied to real live outcomes
8. Microstructure and execution kill-switch tightening
9. Daily decision-quality pack
10. Canary ladder and production readiness gates

### P2 — useful but only after P0/P1
11. Better dashboards/CLI review commands
12. Secondary model improvements
13. More advanced benchmark families

---

# Phase 1 — Canonical post-trade evidence layer

## Goal
Create a single resolved-trade record that becomes the source of truth for:
- realized edge
- realized costs
- fill quality
- regime outcome
- attribution
- promotion/demotion evidence
- capital allocation evidence

## Files to add
- `packages/domain/src/resolved-trade.ts`
- `apps/worker/src/runtime/resolved-trade-ledger.ts`

## Files to modify
- `packages/domain/src/index.ts`
- `apps/worker/src/jobs/reconcileFills.job.ts`
- `apps/worker/src/jobs/refreshPortfolio.job.ts`
- `apps/worker/src/runtime/learning-state-store.ts`

## Exact implementation

### 1. Add `packages/domain/src/resolved-trade.ts`
Define canonical types:
- `ResolvedTradeRecord`
- `ResolvedTradeLifecycleState`
- `ResolvedTradeAttribution`
- `ResolvedTradeExecutionQuality`
- `ResolvedTradeNetOutcome`

Required fields:
- `tradeId`
- `orderId`
- `venueOrderId`
- `marketId`
- `tokenId`
- `strategyVariantId`
- `strategyVersion`
- `regime`
- `archetype`
- `decisionTimestamp`
- `submissionTimestamp`
- `firstFillTimestamp`
- `finalizedTimestamp`
- `side`
- `intendedPrice`
- `averageFillPrice`
- `size`
- `notional`
- `estimatedFeeAtDecision`
- `realizedFee`
- `estimatedSlippageBps`
- `realizedSlippageBps`
- `queueDelayMs`
- `fillFraction`
- `expectedNetEdgeBps`
- `realizedNetEdgeBps`
- `maxFavorableExcursionBps`
- `maxAdverseExcursionBps`
- `toxicityScoreAtDecision`
- `benchmarkContext`
- `lossAttributionCategory`
- `executionAttributionCategory`
- `lifecycleState`

### 2. Export it from `packages/domain/src/index.ts`
Add `export * from './resolved-trade';`

### 3. Add `apps/worker/src/runtime/resolved-trade-ledger.ts`
Responsibilities:
- append/read resolved trades from `artifacts/learning/resolved-trades.jsonl`
- maintain daily partition snapshots if file grows too large
- expose methods:
  - `append(record)`
  - `findByOrderId(orderId)`
  - `loadWindow({ start, end })`
  - `loadRecent(limit)`

Implementation rules:
- use JSONL, not one giant mutable JSON file
- make writes append-only and durable
- avoid coupling this ledger to the learning-state snapshot file

### 4. Update `apps/worker/src/jobs/reconcileFills.job.ts`
After a trade becomes economically resolved enough:
- build a `ResolvedTradeRecord`
- write it to the ledger
- emit audit event `trade.resolved`

Use existing:
- `ExecutionDiagnostics`
- `FillStateService`
- `TradeAttributionService`

Add logic to distinguish:
- partially filled but still open
- matched but not final
- final enough for realized evidence

### 5. Update `apps/worker/src/jobs/refreshPortfolio.job.ts`
After portfolio refresh:
- backfill any missing finalization details for recently resolved trades
- attach realized PnL once final portfolio truth is available

### 6. Update `apps/worker/src/runtime/learning-state-store.ts`
Do **not** merge resolved trade history into `learning-state.json`.
Only add a pointer block like:
- `resolvedTradeLedgerPath`
- `lastResolvedTradeAt`
- `lastResolvedTradeId`

## Acceptance
- every filled trade produces exactly one canonical resolved-trade record
- unresolved orders do not create fake final trades
- realized fee/slippage fields are present
- replay and daily review can read resolved-trade records without scraping order/fill tables again

---

# Phase 2 — Net-edge truth path

## Goal
Make the system trade only when expected edge remains positive **after realistic execution costs**.

## Files to add
- `packages/signal-engine/src/net-realism-context.ts`
- `packages/execution-engine/src/realized-vs-expected-edge-store.ts`

## Files to modify
- `packages/signal-engine/src/net-edge-estimator.ts`
- `packages/signal-engine/src/executable-ev-model.ts`
- `packages/execution-engine/src/realized-cost-model.ts`
- `packages/execution-engine/src/execution-cost-calibrator.ts`
- `packages/execution-engine/src/fee-accounting-service.ts`
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/commands/print-net-edge-state.command.ts`

## Exact implementation

### 1. Add `packages/signal-engine/src/net-realism-context.ts`
Define a structure passed into net-edge estimation with:
- spread at decision
- book depth at intended price
- expected fill fraction
- expected queue delay
- expected partial-fill penalty
- expected cancel/replace penalty
- venue uncertainty label
- fee schedule label

### 2. Update `packages/signal-engine/src/net-edge-estimator.ts`
Refactor estimator so it returns a decomposition, not just a final score.

Required output:
- `grossEdgeBps`
- `feeBps`
- `slippageBps`
- `adverseSelectionPenaltyBps`
- `queuePenaltyBps`
- `uncertaintyPenaltyBps`
- `netEdgeBps`

### 3. Update `packages/signal-engine/src/executable-ev-model.ts`
Use live-calibrated execution assumptions from Phase 3 instead of static or overly optimistic assumptions.

### 4. Update `packages/execution-engine/src/realized-cost-model.ts`
Ensure it can compute realized components matching the estimator breakdown:
- realized fee bps
- realized slippage bps
- realized adverse selection bps
- realized queue-delay cost bps

### 5. Update `packages/execution-engine/src/execution-cost-calibrator.ts`
Calibrate expected cost by context bucket:
- regime
- spread bucket
- liquidity bucket
- urgency
- execution style
- venue mode

### 6. Update `packages/execution-engine/src/fee-accounting-service.ts`
Make fee modeling explicit and auditable.
Return:
- fee rate used
- fee schedule source
- fee notional
- maker/taker assumption if relevant

### 7. Update `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
Change approval logic so signals can only pass if:
- `netEdgeBps > threshold`
- threshold is dynamic by regime, execution style, venue uncertainty, and evidence quality

Persist the full decomposition in decision log metadata.

### 8. Update `apps/worker/src/commands/print-net-edge-state.command.ts`
Show last 20 decisions with full decomposition.

## Acceptance
- every approved trade has a stored net-edge decomposition
- every rejected trade can explain which cost component killed it
- realized-vs-expected edge comparison can be computed from stored records

---

# Phase 3 — Live-calibrated fill realism

## Goal
Replace hopeful execution assumptions with venue-specific live evidence.

## Files to add
- `packages/execution-engine/src/fill-realism-store.ts`
- `packages/execution-engine/src/post-fill-toxicity-store.ts`

## Files to modify
- `packages/execution-engine/src/fill-probability-estimator.ts`
- `packages/execution-engine/src/queue-position-estimator.ts`
- `packages/execution-engine/src/slippage-estimator.ts`
- `packages/execution-engine/src/order-planner.ts`
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/reconcileFills.job.ts`

## Exact implementation

### 1. Add `packages/execution-engine/src/fill-realism-store.ts`
Persist empirical stats by bucket:
- spread bucket
- liquidity bucket
- order urgency
- regime
- execution style
- venue uncertainty label

Store:
- fill probability within 1s / 3s / 5s / 10s
- average fill fraction
- average queue delay
- cancel success latency
- average slippage bps

### 2. Add `packages/execution-engine/src/post-fill-toxicity-store.ts`
Track short-horizon drift after fills:
- 1 second
- 3 seconds
- 10 seconds
- 30 seconds

This becomes the empirical adverse-selection penalty input.

### 3. Update `packages/execution-engine/src/fill-probability-estimator.ts`
Change from generic estimate to empirical bucket-based estimate using `fill-realism-store`.

### 4. Update `packages/execution-engine/src/queue-position-estimator.ts`
Add support for confidence bands instead of single-point estimate.

### 5. Update `packages/execution-engine/src/slippage-estimator.ts`
Calibrate slippage from actual recent fills, not just book geometry.

### 6. Update `packages/execution-engine/src/order-planner.ts`
Require planner output to include:
- expected fill probability
- expected fill fraction
- expected queue delay
- expected realized cost bps
- expected adverse-selection penalty
- recommended order style rationale

### 7. Update `apps/worker/src/jobs/executeOrders.job.ts`
Before submission, write planner assumptions to order metadata so later reconciliation can compare expectation vs reality.

### 8. Update `apps/worker/src/jobs/reconcileFills.job.ts`
After each resolved trade, feed actual execution quality back into fill realism stores.

## Acceptance
- planner outputs empirical execution expectations
- reconciliation updates empirical fill buckets
- net-edge estimator uses those buckets in future decisions

---

# Phase 4 — Regime-first trading and no-trade authority

## Goal
The bot must be able to say: **this is not a tradable condition**.

## Files to add
- `packages/signal-engine/src/no-trade/no-trade-classifier.ts`
- `packages/signal-engine/src/no-trade/no-trade-reason-store.ts`

## Files to modify
- `packages/signal-engine/src/regime-classifier.ts`
- `packages/signal-engine/src/regime-conditioned-edge-model.ts`
- `packages/signal-engine/src/no-trade-zone-policy.ts`
- `packages/signal-engine/src/trade-admission-gate.ts`
- `packages/signal-engine/src/benchmarks/no-regime-baseline.ts`
- `apps/worker/src/jobs/buildSignals.job.ts`
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`

## Exact implementation

### 1. Add `no-trade-classifier.ts`
It must emit:
- `allowTrade`
- `reasonCodes`
- `confidence`
- `conditions`

Reasons should include:
- spread too wide
- orderbook stale
- low depth
- high toxicity
- venue uncertainty elevated
- regime unstable
- edge too marginal after costs
- event window too noisy

### 2. Update `regime-classifier.ts`
Return both:
- `regimeLabel`
- `regimeConfidence`
- `regimeTransitionRisk`

### 3. Update `regime-conditioned-edge-model.ts`
Require model outputs by regime family; do not allow one generic edge model to pass through every regime.

### 4. Update `no-trade-zone-policy.ts`
Merge static filters with empirical no-trade evidence.

### 5. Update `trade-admission-gate.ts`
The gate should reject when:
- no-trade classifier blocks
- regime confidence is too low
- regime-specific live evidence is below threshold

### 6. Update `buildSignals.job.ts`
Attach regime/no-trade context to each candidate signal.

### 7. Update `evaluateTradeOpportunities.job.ts`
Require that regime/no-trade evidence be written into decision log metadata.

## Acceptance
- every rejected trade due to market conditions gives explicit no-trade reason codes
- regime confidence materially changes approval behavior
- no-trade behavior is visible in logs and review commands

---

# Phase 5 — Evidence-weighted capital sizing

## Goal
Size must depend on **live proof quality**, not just forecast conviction.

## Files to add
- `packages/risk-engine/src/evidence-quality-sizer.ts`
- `packages/risk-engine/src/live-trust-score.ts`

## Files to modify
- `packages/risk-engine/src/live-sizing-feedback-policy.ts`
- `packages/risk-engine/src/regime-capital-policy.ts`
- `packages/risk-engine/src/regime-local-sizing.ts`
- `packages/risk-engine/src/capital-ramp-policy-service.ts`
- `packages/risk-engine/src/bet-sizing.ts`
- `packages/risk-engine/src/benchmark-relative-sizing.ts`
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/commands/print-capital-growth-metrics.command.ts`

## Exact implementation

### 1. Add `live-trust-score.ts`
Compute a trust score per strategy variant and regime from:
- number of live trades
- net expectancy after costs
- drawdown stability
- execution variance
- reconciliation cleanliness
- benchmark outperformance

Return a bounded score `0.0 to 1.0`.

### 2. Add `evidence-quality-sizer.ts`
Convert trust score into a size multiplier band, e.g.:
- `<0.25` => 0x or shadow-only
- `0.25–0.45` => 0.25x
- `0.45–0.65` => 0.50x
- `0.65–0.80` => 0.75x
- `>0.80` => 1.00x subject to deployment tier cap

### 3. Update `live-sizing-feedback-policy.ts`
Blend execution-quality feedback with trust-score multiplier.

### 4. Update `regime-capital-policy.ts`
Add caps by regime trust, not just regime label.

### 5. Update `regime-local-sizing.ts`
Use local live performance for micro-adjustments, but never exceed evidence cap.

### 6. Update `capital-ramp-policy-service.ts`
Require minimum live evidence thresholds before tier promotion.

### 7. Update `bet-sizing.ts`
Final size should be:
`baseRisk * edgeFactor * regimeFactor * evidenceFactor * deploymentTierFactor * killSwitchFactor`

### 8. Update `benchmark-relative-sizing.ts`
If a strategy is not beating simple baselines after costs, clamp size aggressively.

### 9. Update `evaluateTradeOpportunities.job.ts`
Persist the full size decomposition in audit metadata.

## Acceptance
- every approved order shows exact sizing decomposition
- no policy can scale on confidence alone
- insufficient live evidence directly caps order size

---

# Phase 6 — Promotion, demotion, quarantine from live truth

## Goal
Only promote what truly beats costs, baselines, and operational quality thresholds.

## Files to add
- `packages/signal-engine/src/live-promotion-gate.ts`
- `packages/signal-engine/src/live-demotion-gate.ts`

## Files to modify
- `packages/signal-engine/src/champion-challenger-manager.ts`
- `packages/signal-engine/src/promotion-decision-engine.ts`
- `packages/signal-engine/src/strategy-quarantine-policy.ts`
- `apps/worker/src/runtime/strategy-deployment-registry.ts`
- `apps/worker/src/runtime/strategy-rollout-controller.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/commands/print-promotion-decision.command.ts`

## Exact implementation

### 1. Add `live-promotion-gate.ts`
Promotion requires all of:
- minimum live trade count
- positive net edge after realized costs
- benchmark outperformance
- acceptable drawdown
- acceptable execution variance
- no unresolved reconciliation anomalies

### 2. Add `live-demotion-gate.ts`
Demote/quarantine on:
- large realized-vs-expected edge gap
- repeated execution underperformance
- benchmark underperformance
- high regime instability
- repeated adverse-selection spikes

### 3. Update `champion-challenger-manager.ts`
Make challenger promotion dependent on live gate, not just offline score.

### 4. Update `promotion-decision-engine.ts`
Persist evidence packet for every promotion/demotion decision.

### 5. Update `strategy-quarantine-policy.ts`
Add temporary probation states rather than binary quarantine only.

### 6. Update `strategy-deployment-registry.ts`
Track fields:
- `liveTrustScore`
- `evidenceWindowStart`
- `evidenceWindowEnd`
- `promotionReasonCodes`
- `demotionReasonCodes`
- `quarantineUntil`

### 7. Update `strategy-rollout-controller.ts`
Enforce slow rollout ladder:
- shadow
- paper
- canary
- cautious_live
- scaled_live

### 8. Update `dailyReview.job.ts`
Produce promotion packets from resolved-trade ledger instead of heuristic-only state.

## Acceptance
- strategy status changes only through explicit gates
- every promotion/demotion is auditable
- rollout cannot skip tiers

---

# Phase 7 — Execution-state truth and kill-switch hardening

## Goal
Treat venue/order lifecycle truth as first-class risk input.

## Files to add
- `packages/risk-engine/src/execution-state-anomaly-detector.ts`
- `apps/worker/src/runtime/execution-state-watchdog.ts`

## Files to modify
- `packages/execution-engine/src/fill-state-service.ts`
- `packages/risk-engine/src/execution-quality-kill-switches.ts`
- `packages/risk-engine/src/portfolio-kill-switch-service.ts`
- `apps/worker/src/runtime/user-websocket-state.service.ts`
- `apps/worker/src/runtime/venue-open-order-heartbeat.service.ts`
- `apps/worker/src/runtime/runtime-state-machine.ts`
- `apps/worker/src/jobs/manageOpenOrders.job.ts`
- `apps/worker/src/jobs/reconcileFills.job.ts`
- `apps/worker/src/smoke/production-readiness.ts`

## Exact implementation

### 1. Add `execution-state-anomaly-detector.ts`
Detect:
- user stream stale while orders are live
- venue open orders disagree with local view
- repeated retry/fail states
- cancel acknowledgments missing too long
- ghost exposure after reconnect
- filled locally but absent from venue truth long enough

### 2. Add `execution-state-watchdog.ts`
Continuously evaluate anomalies and request runtime transitions.

### 3. Update `fill-state-service.ts`
Support more granular lifecycle mapping so not every matched event is treated as final truth.

### 4. Update `execution-quality-kill-switches.ts`
Add new triggers:
- abnormal cancel latency
- repeated partial-fill toxicity
- fill quality drift
- realized-vs-expected cost blowout

### 5. Update `portfolio-kill-switch-service.ts`
Escalate to:
- `reconciliation_only`
- `cancel_only`
- `halted_hard`

based on anomaly severity.

### 6. Update `runtime-state-machine.ts`
Document allowed transitions for execution anomalies explicitly.

### 7. Update `manageOpenOrders.job.ts`
When watchdog says degraded execution quality, become less aggressive and reduce order persistence.

### 8. Update `production-readiness.ts`
Add checks that simulate watchdog-triggered degradations.

## Acceptance
- stale user/order truth can stop new order submission automatically
- runtime downgrades are deterministic and auditable
- kill-switches do not wait for daily review

---

# Phase 8 — Daily decision-quality pack

## Goal
Produce a daily report that tells you **why** the bot made or lost money.

## Files to add
- `apps/worker/src/validation/daily-decision-quality-report.ts`
- `apps/worker/src/commands/print-daily-decision-quality.command.ts`

## Files to modify
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/jobs/capitalGrowthReview.job.ts`
- `apps/worker/src/jobs/capitalLeakReview.job.ts`
- `apps/worker/src/validation/live-proof-scorecard.ts`
- `apps/worker/src/worker.module.ts`

## Exact implementation

### 1. Add `daily-decision-quality-report.ts`
Compute by day and by regime:
- trade count
- win rate
- gross pnl
- net pnl after fees
- expected edge sum
- realized edge sum
- realized-vs-expected gap
- average slippage bps
- average adverse selection bps
- benchmark-relative pnl
- top reason codes for rejected trades
- top reason codes for losses

### 2. Add `print-daily-decision-quality.command.ts`
Readable CLI output for last N days.

### 3. Update `dailyReview.job.ts`
Generate and persist daily report artifact to:
- `artifacts/learning/daily-decision-quality.latest.json`

### 4. Update `capitalGrowthReview.job.ts`
Use daily report inputs for true capital efficiency rather than raw pnl only.

### 5. Update `capitalLeakReview.job.ts`
Split leaks into:
- alpha wrong
- execution wrong
- size too large
- regime wrong
- adverse selection
- fee/slippage underestimation

### 6. Update `live-proof-scorecard.ts`
Include daily report metrics in promotion readiness.

## Acceptance
- each day has an explainable decision-quality report
- you can identify whether losses came from forecast or execution
- promotion logic can consume the report automatically

---

# Phase 9 — Environment, deployment-tier, and live rollout enforcement

## Goal
Make it mechanically difficult to trade live before the repo is ready.

## Files to modify
- `apps/worker/src/config/env.ts`
- `apps/worker/src/smoke/polymarket-auth-smoke.ts`
- `apps/worker/src/smoke/production-readiness.ts`
- `apps/worker/src/runtime/startup-gate.service.ts`
- `apps/worker/src/runtime/startup-runbook.ts`
- `apps/worker/src/runtime/start-stop-manager.ts`
- `scripts/run-production-readiness.sh`
- `scripts/run-live-bot.sh`
- `scripts/stop-live-bot.sh`
- `.env.example`

## Exact implementation

### 1. Add new env flags in `env.ts`
Add:
- `BOT_MIN_LIVE_TRADES_FOR_CANARY`
- `BOT_MIN_LIVE_TRADES_FOR_CAUTIOUS_LIVE`
- `BOT_MIN_LIVE_TRADES_FOR_SCALED_LIVE`
- `BOT_MAX_ALLOWED_REALIZED_EXPECTED_EDGE_GAP_BPS`
- `BOT_MAX_ALLOWED_RECONCILIATION_DEFECT_RATE`
- `BOT_ENABLE_SHADOW_DECISION_LOGGING`
- `BOT_REQUIRE_PRODUCTION_READINESS_PASS`

### 2. Update `polymarket-auth-smoke.ts`
Require explicit success evidence for:
- authenticated open orders read
- trades read
- cancel path
- user stream auth

### 3. Update `production-readiness.ts`
Fail readiness when:
- evidence thresholds are missing
- recent reconciliation defect rate is too high
- execution-state watchdog is unhealthy
- no recent daily-decision-quality report exists

### 4. Update `startup-gate.service.ts`
Do not enter live-executable states unless all hard gates pass.

### 5. Update `startup-runbook.ts`
Add gates for:
- live trust score minimum by tier
- recent readiness pass timestamp
- recent smoke test timestamp

### 6. Update run scripts
- `run-live-bot.sh` must refuse `cautious_live` or `scaled_live` if readiness artifacts are absent.

## Acceptance
- starting the system live without readiness evidence is hard-blocked
- deployment tiers map to real evidence requirements

---

# Phase 10 — Test suite expansion for the new truth path

## Goal
The new behavior must be provable in code before capital is at risk.

## Files to add
- `apps/worker/src/tests/resolved-trade-ledger.integration.test.ts`
- `apps/worker/src/tests/net-edge-realism.integration.test.ts`
- `apps/worker/src/tests/fill-realism-feedback.integration.test.ts`
- `apps/worker/src/tests/no-trade-classifier.integration.test.ts`
- `apps/worker/src/tests/evidence-quality-sizing.integration.test.ts`
- `apps/worker/src/tests/live-promotion-gate.integration.test.ts`
- `apps/worker/src/tests/execution-watchdog.integration.test.ts`
- `apps/worker/src/tests/daily-decision-quality.integration.test.ts`

## Files to modify
- `apps/worker/src/tests/integration-runner.ts`
- `apps/worker/src/tests/phase6-live-proof.integration.test.ts`
- `apps/worker/src/tests/phase7-live-path-wiring.integration.test.ts`

## Exact implementation

### Required new test coverage
1. resolved trade written once and only once
2. expected vs realized edge decomposition matches ledger
3. live execution realism updates future planner output
4. no-trade classifier blocks marginal/high-toxicity setups
5. evidence-quality sizing caps a profitable but under-sampled strategy
6. promotion gate rejects strategies that beat raw pnl but fail benchmark-relative net pnl
7. watchdog moves runtime to degraded/reconciliation_only/cancel_only correctly
8. daily report attributes losses to correct bucket

### Required integration-runner update
Ensure these tests can be run in one command group without depending on real venue access.

## Acceptance
- new capability has matching integration tests
- no feature merges without test coverage

---

# Required package export updates

After adding new files, update these package indices so imports remain clean.

## `packages/domain/src/index.ts`
Add exports for:
- `resolved-trade.ts`

## `packages/execution-engine/src/index.ts`
Add exports for:
- `fill-realism-store.ts`
- `post-fill-toxicity-store.ts`
- `realized-vs-expected-edge-store.ts`

## `packages/signal-engine/src/index.ts`
Add exports for:
- `net-realism-context.ts`
- `no-trade/no-trade-classifier.ts`
- `no-trade/no-trade-reason-store.ts`
- `live-promotion-gate.ts`
- `live-demotion-gate.ts`

## `packages/risk-engine/src/index.ts`
Add exports for:
- `evidence-quality-sizer.ts`
- `live-trust-score.ts`
- `execution-state-anomaly-detector.ts`
- `expected-vs-realized-ev-guard.ts` *(if file exists but is not exported or used consistently)*

---

# File-by-file implementation checklist

## Worker runtime
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
  - integrate net-edge decomposition
  - integrate regime/no-trade block
  - integrate evidence-quality sizing
  - persist decomposition + size factors to decision log

- `apps/worker/src/jobs/executeOrders.job.ts`
  - persist planner execution assumptions to order metadata
  - record order-style rationale and expected fill realism

- `apps/worker/src/jobs/reconcileFills.job.ts`
  - write canonical resolved-trade record
  - update fill realism + post-fill toxicity stores
  - compute realized-vs-expected edge gap

- `apps/worker/src/jobs/refreshPortfolio.job.ts`
  - finalize resolved-trade pnl fields after external truth refresh

- `apps/worker/src/jobs/dailyReview.job.ts`
  - read resolved-trade ledger
  - build daily-decision-quality report
  - feed promotion/demotion gates

- `apps/worker/src/runtime/learning-state-store.ts`
  - keep snapshot state lean
  - store pointers only, not bulky resolved-trade history

- `apps/worker/src/runtime/startup-gate.service.ts`
  - enforce live readiness requirements by tier

- `apps/worker/src/runtime/runtime-state-machine.ts`
  - include deterministic transitions for execution anomalies

## Signal package
- `packages/signal-engine/src/net-edge-estimator.ts`
  - return cost decomposition
- `packages/signal-engine/src/executable-ev-model.ts`
  - consume empirical fill realism
- `packages/signal-engine/src/regime-classifier.ts`
  - return confidence + transition risk
- `packages/signal-engine/src/trade-admission-gate.ts`
  - require regime/no-trade and evidence checks
- `packages/signal-engine/src/champion-challenger-manager.ts`
  - live promotion gate only

## Execution package
- `packages/execution-engine/src/order-planner.ts`
  - output expected fill/queue/slippage/adverse-selection assumptions
- `packages/execution-engine/src/fill-probability-estimator.ts`
  - empirical bucket model
- `packages/execution-engine/src/slippage-estimator.ts`
  - realized fill-calibrated model
- `packages/execution-engine/src/realized-cost-model.ts`
  - full realized cost breakdown
- `packages/execution-engine/src/fill-state-service.ts`
  - more precise execution lifecycle mapping

## Risk package
- `packages/risk-engine/src/live-sizing-feedback-policy.ts`
  - blend execution feedback with evidence quality
- `packages/risk-engine/src/regime-capital-policy.ts`
  - regime trust-based caps
- `packages/risk-engine/src/capital-ramp-policy-service.ts`
  - evidence thresholds by deployment tier
- `packages/risk-engine/src/execution-quality-kill-switches.ts`
  - add realized-vs-expected and lifecycle anomaly triggers
- `packages/risk-engine/src/portfolio-kill-switch-service.ts`
  - escalate runtime state transitions

---

# Suggested implementation sequence by week block

## Block A — do first
- Priority 0 security cleanup
- Phase 1 resolved-trade ledger
- Phase 2 net-edge truth path

## Block B — do second
- Phase 3 fill realism
- Phase 4 regime/no-trade authority

## Block C — do third
- Phase 5 evidence-weighted sizing
- Phase 6 promotion/demotion from live truth

## Block D — do fourth
- Phase 7 kill-switch hardening
- Phase 8 daily decision-quality report
- Phase 9 readiness enforcement
- Phase 10 tests

---

# Commands to run after each block

## Typecheck
```bash
corepack pnpm -r typecheck
```

## Worker tests
```bash
corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
```

## Production readiness
```bash
./scripts/run-production-readiness.sh
```

## Auth smoke
```bash
./scripts/run-polymarket-auth-smoke.sh
```

## P2/P3 validations
```bash
./scripts/run-p23-validations.sh
```

---

# Hard go/no-go criteria before real capital scale-up

Do **not** move beyond canary unless all are true:

1. resolved-trade ledger is complete and consistent
2. net edge stays positive after realized costs over a meaningful live window
3. strategy beats simple baselines after costs
4. realized-vs-expected edge gap is within configured tolerance
5. reconciliation defect rate is below configured threshold
6. no unresolved execution-state anomalies are present
7. daily decision-quality report exists and is green for recent sessions
8. deployment-tier readiness passes mechanically

---

# Final note

This repo does **not** become an 8+/10 capital-growth bot because its models become more complicated.

It gets there only if:
- expected edge becomes honest
- execution becomes empirical
- capital scaling becomes evidence-bound
- runtime truth controls become harder than optimism
- live performance earns promotion slowly

Implement the phases in this file exactly in order.
Do not skip Phase 1–5 and jump to model tuning.
That would make the system look smarter without making it safer or more profitable.
