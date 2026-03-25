# instruction.md

## Objective

Upgrade this repository from approximately **8.8/10** toward **9.2/10** by improving the following areas:

1. better attribution
2. better toxicity awareness
3. better live sizing discipline
4. better benchmark rigor
5. better evidence
6. better alpha sophistication

This upgrade must build on top of the current architecture.
Do not remove core runtime, risk, execution, reconciliation, validation, or learning functionality.

---

## Repository context

This repository is already strong in:

- runtime lifecycle and orchestration
- startup gates and crash recovery
- risk/safety gating
- order execution discipline
- reconciliation and external truth checks
- audit, lineage, diagnostics, validation, and review scaffolding

This repository still needs improvement in:

- stronger predictive alpha
- decision-grade attribution
- forward-looking toxicity logic
- live capital discipline
- benchmark rigor
- evidence-to-action coupling

All work must preserve strong areas and strengthen weak ones.

---

## Global rules

### Preserve current core behavior
You must preserve the existing:

- runtime lifecycle
- startup gates
- safety-state and runtime-state gating
- signal/evaluate/execute/reconcile/refresh pipeline
- reconciliation and external truth checks
- daily review / learning flow
- decision log / lineage / diagnostics behavior
- validation/report generation behavior

### Prefer additive changes
Add new modules and integrate them.
Refactor existing modules only where necessary for clarity, canonicalization, or reuse.

### Keep logic inspectable
New logic should be:

- deterministic where feasible
- bounded
- explicit
- replayable
- diagnosable

### Every new decision input must produce evidence
If a new module influences:
- posterior
- regime
- admission
- sizing
- execution style
- capital allocation
it must leave structured evidence.

### No dead modules
No module should be added without being integrated into:
- live paths
- review paths
- validation paths
or some combination of these.

### No weakening of controls
Do not weaken:
- safety gates
- runtime-state permissions
- external portfolio truth checks
- reconciliation freshness checks
- execution viability checks
- lineage and diagnostics emission

---

## Existing files that matter most

### Primary upgrade surfaces
- `apps/worker/src/jobs/buildSignals.job.ts`
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/validation/p23-validation.ts`

### Core signal files
- `packages/signal-engine/src/feature-builder.ts`
- `packages/signal-engine/src/prior/prior-model.ts`
- `packages/signal-engine/src/posterior/posterior-update.ts`
- `packages/signal-engine/src/regime-classifier.ts`
- `packages/signal-engine/src/edge/*`
- `packages/signal-engine/src/ev/*`
- `packages/signal-engine/src/walk-forward-validator.ts`

### Runtime/evidence files
- `apps/worker/src/runtime/decision-log.service.ts`
- `apps/worker/src/runtime/version-lineage-registry.ts`
- `apps/worker/src/runtime/learning-state-store.ts`

### Supporting execution/risk files
- `packages/risk-engine/*`
- `packages/execution-engine/*`
- `packages/polymarket-adapter/*`

---

## High-impact implementation list

These are the concrete implementations to execute one at a time.

1. loss attribution classifier
2. retention by regime/archetype/toxicity
3. toxicity momentum / shock / persistence
4. passive-only / aggression lockout under toxic flow
5. fast-down / slow-up live sizing policy
6. regime-local size multipliers
7. benchmark-relative size penalties
8. rolling benchmark scorecards
9. regime-specific benchmark gating
10. BTC-to-Polymarket transmission features
11. flow persistence / reversal features
12. calibration drift alerts by regime and archetype

Each item must be implemented, tested, and reviewed independently before moving to the next.

---

# Item 1 — Loss attribution classifier

## Goal
Classify retained-edge loss into actionable buckets.

## Files to add
- `packages/signal-engine/src/edge/loss-attribution-classifier.ts`

## Files to update
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/runtime/decision-log.service.ts`
- `apps/worker/src/runtime/version-lineage-registry.ts`

## Required outputs
At minimum:
- `lossCategory`
- `lossReasonCodes`
- `forecastQualityAssessment`
- `executionQualityAssessment`
- `primaryLeakageDriver`
- `secondaryLeakageDrivers`

## Required categories
Support at least:
- alpha_wrong
- slippage_excess
- fill_quality_failure
- latency_decay
- toxicity_damage
- over_sizing
- regime_drift
- mixed

## Integration requirements
- execution must classify post-trade outcomes
- daily review must aggregate categories
- evidence/logging must include the classification

## Definition of done
- classifier exists
- execution emits loss attribution
- daily review summarizes loss buckets
- tests cover category assignment edge cases

---

# Item 2 — Retention by regime/archetype/toxicity

## Goal
Make retention observable by context.

## Files to add
- `apps/worker/src/validation/retention-context-report.ts`

## Files to update
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/validation/p23-validation.ts`
- `apps/worker/src/runtime/learning-state-store.ts`

## Required outputs
At minimum:
- retention by regime
- retention by archetype
- retention by toxicity state
- top degrading contexts
- top improving contexts

## Integration requirements
- daily review stores these summaries
- validation artifacts include them
- learning state stores lightweight summaries only

## Definition of done
- report exists
- daily review uses it
- p23 validation can emit it
- tests cover grouping and summary logic

---

# Item 3 — Toxicity momentum / shock / persistence

## Goal
Make toxicity forward-looking, not only point-in-time.

## Files to add
- `packages/signal-engine/src/toxicity/toxicity-trend.ts`

## Files to update
- `packages/signal-engine/src/toxicity/toxicity-policy.ts`
- `apps/worker/src/jobs/buildSignals.job.ts`
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`

## Required outputs
At minimum:
- `toxicityMomentum`
- `toxicityShock`
- `toxicityPersistence`

## Integration requirements
- buildSignals attaches these to signal evidence
- evaluation uses them to tighten thresholds or shrink size
- daily review tracks how persistent toxicity affects retention

## Definition of done
- trend module exists
- toxicity policy consumes it
- evaluation behavior changes under rising or persistent toxicity
- tests cover rising/falling/shock/persistent cases

---

# Item 4 — Passive-only / aggression lockout under toxic flow

## Goal
Force defensive execution behavior when toxicity is high.

## Files to update
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- existing toxicity policy files as needed

## Required outputs
At minimum:
- `executionAggressionLock`
- `passiveOnly`
- `aggressionReasonCodes`

## Integration requirements
- evaluation can reject or downgrade aggression
- execution must respect lockouts
- diagnostics must show when and why aggression was reduced

## Definition of done
- toxic conditions can enforce passive-only behavior
- execution respects the restriction
- tests cover lockout behavior

---

# Item 5 — Fast-down / slow-up live sizing policy

## Goal
Shrink size quickly under degradation and restore slowly under recovery.

## Files to add or update
- `packages/risk-engine/src/live-sizing-feedback-policy.ts`

## Files to update
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`

## Required behavior
- size down aggressively under retention failure or high toxicity
- size up only after stable evidence over multiple windows
- do not let one good window restore full size immediately

## Required outputs
At minimum:
- `downshiftMultiplier`
- `upshiftEligibility`
- `recoveryProbationState`
- `sizingReasonCodes`

## Definition of done
- policy supports asymmetric response
- evaluation uses it
- tests cover fast-down / slow-up scenarios

---

# Item 6 — Regime-local size multipliers

## Goal
Allow size to differ by regime and archetype, not only globally.

## Files to add
- `packages/risk-engine/src/regime-local-sizing.ts`

## Files to update
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/runtime/learning-state-store.ts`

## Required outputs
At minimum:
- `regimeSizeMultiplier`
- `archetypeSizeMultiplier`
- `regimeSizingReasonCodes`

## Integration requirements
- evaluation applies regime-local sizing
- daily review updates regime-local sizing evidence

## Definition of done
- regime-local size logic exists
- evaluation consumes it
- tests cover different regime states

---

# Item 7 — Benchmark-relative size penalties

## Goal
Reduce size when the strategy is not outperforming simple baselines in a context.

## Files to add
- `packages/risk-engine/src/benchmark-relative-sizing.ts`

## Files to update
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`
- benchmark report files as needed

## Required outputs
At minimum:
- `baselinePenaltyMultiplier`
- `benchmarkComparisonState`
- `benchmarkPenaltyReasonCodes`

## Integration requirements
- daily review computes relevant benchmark status
- evaluation can shrink size when strategy underperforms baseline in a context

## Definition of done
- benchmark-relative penalty exists
- evaluation uses it
- tests cover outperform / underperform cases

---

# Item 8 — Rolling benchmark scorecards

## Goal
Track benchmark superiority across rolling windows.

## Files to add
- `apps/worker/src/validation/rolling-benchmark-scorecard.ts`

## Files to update
- `apps/worker/src/validation/p23-validation.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/jobs/capitalGrowthReview.job.ts`

## Required windows
At minimum:
- 1 day
- 3 day
- 7 day
- 30 day or best available equivalent in historical context

## Required outputs
At minimum:
- outperformance by window
- retained-edge vs benchmark by window
- stability of outperformance

## Definition of done
- rolling scorecard exists
- daily review and validation can emit it
- tests cover rolling aggregation logic

---

# Item 9 — Regime-specific benchmark gating

## Goal
Do not scale up regimes that fail against simple baselines.

## Files to update
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- benchmark comparison modules as needed

## Required outputs
At minimum:
- `regimeBenchmarkGateState`
- `promotionBlockedByBenchmark`
- `regimeBenchmarkReasonCodes`

## Integration requirements
- daily review computes benchmark gate states by regime
- evaluation respects benchmark-based restrictions
- capital scale-up is blocked where strategy underperforms simple baselines

## Definition of done
- gate exists
- review produces it
- evaluation uses it
- tests cover pass/fail regimes

---

# Item 10 — BTC-to-Polymarket transmission features

## Goal
Improve alpha sophistication through better modeling of how BTC moves translate into market probability moves.

## Files to add
- `packages/signal-engine/src/alpha/btc-polymarket-transmission-v2.ts`

## Files to update
- `packages/signal-engine/src/feature-builder.ts`
- `packages/signal-engine/src/prior/prior-model.ts`
- `packages/signal-engine/src/posterior/posterior-update.ts`
- `apps/worker/src/jobs/buildSignals.job.ts`

## Required features
At minimum:
- lagged BTC move transmission
- nonlinear BTC move sensitivity
- divergence between BTC path and market probability response
- recent transmission consistency or inconsistency

## Definition of done
- features exist
- prior/posterior consume them
- signal evidence includes them
- tests cover feature computation and model usage

---

# Item 11 — Flow persistence / reversal features

## Goal
Improve alpha sophistication through richer short-horizon flow behavior.

## Files to add
- `packages/signal-engine/src/alpha/flow-persistence-reversal.ts`

## Files to update
- `packages/signal-engine/src/feature-builder.ts`
- `packages/signal-engine/src/prior/prior-model.ts`
- `packages/signal-engine/src/posterior/posterior-update.ts`
- `apps/worker/src/jobs/buildSignals.job.ts`

## Required features
At minimum:
- imbalance persistence
- imbalance reversal probability
- quote instability before move
- depth depletion asymmetry

## Definition of done
- features exist
- models consume them
- signal job persists them
- tests cover persistence and reversal logic

---

# Item 12 — Calibration drift alerts by regime and archetype

## Goal
Detect when calibration is breaking in specific contexts.

## Files to add
- `apps/worker/src/validation/calibration-drift-alerts.ts`

## Files to update
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/validation/p23-validation.ts`
- `apps/worker/src/runtime/learning-state-store.ts`

## Required outputs
At minimum:
- `calibrationDriftState`
- `regimeCalibrationAlert`
- `archetypeCalibrationAlert`
- `driftReasonCodes`

## Integration requirements
- daily review emits alerts
- learning state stores lightweight alert summaries
- evaluation and/or sizing can consume drift state later if needed

## Definition of done
- alerts exist
- review emits them
- validation can surface them
- tests cover alert threshold behavior

---

## Work policy

Implement these items **one at a time**.

For each item, the workflow must be:

1. Audit current relevant files.
2. List exact files to add or update.
3. Implement the item only.
4. Add unit tests for pure modules.
5. Add or update integration tests where needed.
6. Run relevant tests and typecheck.
7. Stop and report results before moving to the next item.

Do not stack multiple items in one change unless explicitly instructed.

---

## Test policy

Every item must include tests.

### Required test classes
- unit tests for pure calculators/policies
- integration tests for changed job logic
- validation/report tests where applicable

### Minimum expectations
- all new modules have direct unit coverage
- each modified major job has integration coverage adjusted where needed
- validation commands remain runnable and more informative than before

---

## Validation commands

Prefer existing repo commands.
Preserve or extend support for commands equivalent to:

- `pnpm test`
- `pnpm typecheck`
- `pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:p23`
- `pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:dataset-quality`

If exact scripts differ, update safely and document them.

---

## Rollback and failure handling

If an item causes:
- failed typecheck
- failed tests
- broken validation
- degraded evidence quality
- broken runtime integration

stop and repair before proceeding.

Do not continue on a broken base.

---

## Success criteria

This program is successful only if the repository can more clearly answer:

- Where does forecast edge come from?
- Does forecast edge survive execution?
- What causes retained-edge loss?
- Which regimes and archetypes really work?
- Which toxicity states damage retention?
- Which baselines are being beaten?
- When should live size shrink, hold, or recover?
- When should aggression be restricted?
- Which regimes should be gated, penalized, or scaled up?

And only if:
- existing core functionality still works
- risk and runtime protections remain intact
- evidence quality improves materially

---

## Short checklist for contributors

Before considering any item complete, verify:

- [ ] Existing runtime and safety behavior preserved
- [ ] New module added and integrated
- [ ] Evidence emitted where relevant
- [ ] Tests added
- [ ] Existing commands still work or were safely extended
- [ ] No dead modules left unintegrated

---

## Final implementation intent

Do not treat this as cosmetic refactoring.

Treat it as a focused upgrade program to move the system from:

- strong execution-and-control platform with improved evidence

to:

- strong execution-and-control platform with sharper alpha
- stronger attribution
- more actionable toxicity
- smarter capital discipline
- harder benchmark proof
- stronger evidence-driven live behavior