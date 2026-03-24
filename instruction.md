# instruction.md

# Phase 12 — Capital Growth and Trading Effectiveness

## Objective

Implement Phase 12 to improve net capital growth, trading effectiveness, and capital efficiency.

The system must become better at:
- rejecting weak trades
- estimating net tradable edge honestly
- identifying capital leakage
- ranking regimes economically
- controlling overtrading
- sizing by uncertainty and liquidity reality
- promoting only economically stable variants

Do not optimize for raw trade count.
Do not optimize for gross PnL.
Do not add complexity that does not clearly improve net expectancy or capital efficiency.

---

# WAVE 1 — Net-edge realism

## Goal
Gate trades on realistic net edge, not raw forecast edge.
This is the highest-priority wave.

## Create
- `packages/domain/src/net-edge.ts`
- `packages/signal-engine/src/net-edge-estimator.ts`
- `packages/signal-engine/src/net-edge-threshold-policy.ts`
- `packages/signal-engine/src/no-trade-zone-policy.ts`

## Modify
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`

## Required behavior

### `packages/domain/src/net-edge.ts`
Define canonical types for:
- `NetEdgeInput`
- `CostEstimateBreakdown`
- `UncertaintyPenalty`
- `NetEdgeBreakdown`
- `NetEdgeDecision`

### `packages/signal-engine/src/net-edge-estimator.ts`
Implement a typed estimator that computes:
- gross forecast edge
- fee cost
- slippage cost
- adverse selection cost
- uncertainty penalty
- venue penalty if relevant
- final net edge

It must produce an explicit breakdown and a final recommendation.

### `packages/signal-engine/src/net-edge-threshold-policy.ts`
Implement threshold logic that:
- enforces minimum net edge
- raises threshold in degraded regimes
- raises threshold under venue instability
- rejects low-margin opportunities

### `packages/signal-engine/src/no-trade-zone-policy.ts`
Implement explicit no-trade conditions such as:
- weak net edge
- high uncertainty
- poor calibration
- poor regime health
- poor execution context
- venue instability

### `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
Integrate Wave 1 logic so opportunity evaluation is driven by realistic net edge and no-trade rules.
Do not rely mainly on raw signal strength after this change.

## Rules
- keep all logic typed and explainable
- keep all decisions compatible with replayability
- do not bypass Phase 11 state / lineage / guardrails
- prefer no-trade over marginal trade

## Verification commands
Run:

```bash
pnpm -r typecheck
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
rg "net-edge-estimator|net-edge-threshold-policy|no-trade-zone-policy|evaluateTradeOpportunities" apps packages
```

## Wave 1 acceptance criteria
Wave 1 is complete only if:
- raw edge can be reduced to net edge through explicit cost adjustments
- low-margin trades are rejectable after cost and uncertainty adjustment
- evaluateTradeOpportunities integrates the new net-edge path
- no-trade logic exists explicitly and is inspectable

---

# WAVE 2 — Capital leak attribution and trade quality

## Goal
Make the system explain where capital is leaking and how individual trades should be scored economically.

## Create
- `packages/risk-engine/src/capital-leak-attribution.ts`
- `packages/risk-engine/src/capital-leak-report.ts`
- `apps/worker/src/jobs/capitalLeakReview.job.ts`
- `packages/domain/src/trade-quality.ts`
- `packages/risk-engine/src/trade-quality-scorer.ts`
- `packages/risk-engine/src/trade-quality-history-store.ts`

## Required behavior

### `capital-leak-attribution.ts`
Attribute capital leakage to categories such as:
- false positive forecast
- calibration error
- slippage
- adverse selection
- missed fills
- overtrading
- poor sizing
- trading in degraded regimes
- venue degradation

### `capital-leak-report.ts`
Summarize leak categories by:
- strategy variant
- regime
- market context
- execution style
- time window

### `capitalLeakReview.job.ts`
Run a periodic review that:
- computes leak attribution
- stores or emits diagnostic summaries
- flags dominant leak categories

### `trade-quality.ts`
Define canonical types for:
- `TradeQualityScore`
- `TradeQualityBreakdown`
- `TradeQualityLabel`

### `trade-quality-scorer.ts`
Score trades on:
- forecast quality
- calibration quality
- execution quality
- timing quality
- policy compliance
- realized outcome quality

### `trade-quality-history-store.ts`
Persist trade-quality results for later review and integration into policy decisions.

## Rules
- trade quality must be explainable, not a black-box score only
- capital-leak categories must be explicit and machine-readable

## Verification commands
Run:

```bash
pnpm -r typecheck
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
rg "capital-leak-attribution|capital-leak-report|capitalLeakReview|trade-quality-scorer|trade-quality-history-store" apps packages
```

## Wave 2 acceptance criteria
Wave 2 is complete only if:
- the system can explain major loss sources in explicit categories
- trade quality is scored structurally and persisted
- leak review runs as a real job, not only as a utility file

---

# WAVE 3 — Regime economics and anti-overtrading

## Goal
Allocate less or zero capital to destructive regimes and reduce low-quality activity.

## Create
- `packages/risk-engine/src/regime-profitability-ranker.ts`
- `packages/risk-engine/src/regime-capital-policy.ts`
- `packages/risk-engine/src/regime-disable-policy.ts`
- `packages/risk-engine/src/trade-frequency-governor.ts`
- `packages/risk-engine/src/marginal-edge-cooldown-policy.ts`
- `packages/risk-engine/src/opportunity-saturation-detector.ts`

## Modify
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- optionally `apps/worker/src/jobs/executeOrders.job.ts` if frequency gating needs downstream enforcement

## Required behavior

### `regime-profitability-ranker.ts`
Rank regimes economically using:
- net EV
- realized EV retention
- drawdown behavior
- calibration health
- execution quality
- sample sufficiency

### `regime-capital-policy.ts`
Map regime ranking into capital treatment.
Examples:
- strong → normal or elevated capital
- tradable → normal capital
- marginal → reduced capital
- avoid → no-trade or near-zero capital

### `regime-disable-policy.ts`
Disable persistently destructive regimes.

### `trade-frequency-governor.ts`
Control trade frequency by:
- regime
- opportunity class
- recent trade quality
- recent capital leakage
- recent drawdown state

### `marginal-edge-cooldown-policy.ts`
Impose cooldown after repeated weak or marginal opportunities.

### `opportunity-saturation-detector.ts`
Detect when the system is forcing activity instead of waiting for strong edge.

## Rules
- overtrading is a bug
- do not let low-quality market conditions keep generating activity unchecked
- integrate with existing Phase 11 guardrails, not around them

## Verification commands
Run:

```bash
pnpm -r typecheck
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
rg "regime-profitability-ranker|regime-capital-policy|regime-disable-policy|trade-frequency-governor|marginal-edge-cooldown-policy|opportunity-saturation-detector" apps packages
```

## Wave 3 acceptance criteria
Wave 3 is complete only if:
- regimes can be ranked economically
- bad regimes can be reduced or disabled
- low-quality trade frequency can be suppressed explicitly
- opportunity evaluation respects these new controls

---

# WAVE 4 — Execution-cost realism and uncertainty-weighted sizing

## Goal
Retain more edge after execution and size smaller when conditions are uncertain or liquidity is weak.

## Create
- `packages/execution-engine/src/realized-cost-model.ts`
- `packages/execution-engine/src/execution-cost-calibrator.ts`
- `packages/execution-engine/src/size-vs-liquidity-policy.ts`
- `packages/execution-engine/src/entry-timing-efficiency-scorer.ts`
- `packages/risk-engine/src/uncertainty-weighted-sizing.ts`
- `packages/risk-engine/src/size-penalty-engine.ts`
- `packages/risk-engine/src/max-loss-per-opportunity-policy.ts`

## Required behavior

### `realized-cost-model.ts`
Model realized trading cost including:
- fees
- slippage
- adverse selection
- fill decay
- cancel/replace overhead
- missed opportunity cost if relevant

### `execution-cost-calibrator.ts`
Update cost assumptions from realized trades/fills.

### `size-vs-liquidity-policy.ts`
Limit trade size based on liquidity and execution conditions.

### `entry-timing-efficiency-scorer.ts`
Measure whether trade entry timing is efficient or consistently poor.

### `uncertainty-weighted-sizing.ts`
Size positions based on:
- net edge
- calibration health
- execution health
- regime health
- venue health
- drawdown state
- sample sufficiency

### `size-penalty-engine.ts`
Apply size penalties for:
- weak calibration
- poor execution quality
- poor regime health
- venue instability
- concentration risk

### `max-loss-per-opportunity-policy.ts`
Prevent one opportunity from consuming too much capital budget.

## Rules
- size must fall when uncertainty rises
- do not allow static sizing to dominate in poor conditions
- keep outputs typed and explainable

## Verification commands
Run:

```bash
pnpm -r typecheck
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
rg "realized-cost-model|execution-cost-calibrator|size-vs-liquidity-policy|entry-timing-efficiency-scorer|uncertainty-weighted-sizing|size-penalty-engine|max-loss-per-opportunity-policy" apps packages
```

## Wave 4 acceptance criteria
Wave 4 is complete only if:
- realized execution costs are modeled explicitly
- size can be reduced by uncertainty and liquidity conditions
- the system has a typed path from poor conditions to smaller exposure

---

# WAVE 5 — Promotion economics, growth metrics, commands, and tests

## Goal
Promote only economically stable behavior and make capital-growth quality inspectable and proven.

## Create
- `packages/signal-engine/src/capital-growth-promotion-gate.ts`
- `packages/signal-engine/src/promotion-stability-check.ts`
- modify `packages/signal-engine/src/promotion-decision-engine.ts`
- `packages/risk-engine/src/capital-growth-metrics.ts`
- `packages/risk-engine/src/compounding-efficiency-score.ts`
- `apps/worker/src/jobs/capitalGrowthReview.job.ts`
- `apps/worker/src/commands/print-net-edge-state.command.ts`
- `apps/worker/src/commands/print-capital-leak-report.command.ts`
- `apps/worker/src/commands/print-regime-profitability.command.ts`
- `apps/worker/src/commands/print-capital-growth-metrics.command.ts`
- `apps/worker/src/tests/net-edge-gating.integration.test.ts`
- `apps/worker/src/tests/regime-profitability.integration.test.ts`
- `apps/worker/src/tests/uncertainty-sizing.integration.test.ts`
- `apps/worker/src/tests/anti-overtrading.integration.test.ts`
- `apps/worker/src/tests/capital-leak-attribution.integration.test.ts`

## Required behavior

### `capital-growth-promotion-gate.ts`
Promotion must require:
- net edge quality
- acceptable drawdown
- healthy calibration
- healthy execution retention
- acceptable capital leakage
- stable regime profitability

### `promotion-stability-check.ts`
Reject profitable-but-unstable challengers.
Examples:
- luck concentrated in one narrow context
- poor EV consistency
- high variance without stable retention
- fragile regime dependence

### `capital-growth-metrics.ts`
Compute capital-growth-focused metrics such as:
- net return
- drawdown-adjusted growth
- EV retention
- cost leakage ratio
- profit factor after costs
- regime-adjusted expectancy
- stability-adjusted capital growth score

### `compounding-efficiency-score.ts`
Produce a composite score answering how efficiently the system converts risk into growth.

### `capitalGrowthReview.job.ts`
Review:
- what compounds efficiently
- what is profitable but unstable
- what should be scaled
- what should be reduced

### Commands
Provide inspectable operator outputs for:
- net-edge state
- capital leak report
- regime profitability
- capital growth metrics

### Integration tests
Must prove:
- raw edge can be rejected after cost adjustment
- destructive regimes are down-ranked
- uncertainty reduces size
- anti-overtrading controls trigger correctly
- capital leak attribution distinguishes different loss sources

## Rules
- do not promote on recent profits alone
- metrics must focus on capital growth quality, not vanity performance
- tests must verify economic logic, not only existence of files

## Verification commands
Run:

```bash
pnpm -r typecheck
pnpm test
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
rg "capital-growth-promotion-gate|promotion-stability-check|capital-growth-metrics|compounding-efficiency-score|capitalGrowthReview|print-net-edge-state|print-capital-leak-report|print-regime-profitability|print-capital-growth-metrics|net-edge-gating.integration|regime-profitability.integration|uncertainty-sizing.integration|anti-overtrading.integration|capital-leak-attribution.integration" apps packages
```

## Wave 5 acceptance criteria
Wave 5 is complete only if:
- promotions are gated by capital-growth quality
- capital-growth metrics exist and are inspectable
- operator commands expose economic state clearly
- integration tests prove the economic controls work

---

# Final Phase 12 verification gate

Run all of the following before calling Phase 12 complete:

```bash
pnpm -r typecheck
pnpm test
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
```

Then verify all required Phase 12 modules exist and are referenced.

Suggested search:

```bash
rg "net-edge-estimator|no-trade-zone-policy|capital-leak-attribution|trade-quality-scorer|regime-profitability-ranker|trade-frequency-governor|realized-cost-model|uncertainty-weighted-sizing|capital-growth-promotion-gate|capital-growth-metrics|print-net-edge-state|print-capital-growth-metrics" apps packages
```

---

# Definition of done

Phase 12 is complete only if the repository can demonstrate all of the following:
- weak raw edge can be rejected after realistic cost adjustment
- destructive regimes receive less or zero capital
- capital leakage can be attributed explicitly
- trade quality is scored and persisted
- overtrading can be suppressed
- position size falls when uncertainty rises
- liquidity constraints reduce exposure explicitly
- strategy promotion depends on capital-growth quality
- economic operator commands expose the relevant state clearly
- integration tests verify the most important economic controls

If any of the above is missing, Phase 12 is not complete.
