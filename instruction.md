# instruction.md

## Objective

Upgrade this repository in an execution-tight way to improve:

1. alpha model quality
2. alpha-vs-execution attribution
3. empirical validation quality
4. toxicity-aware decisioning
5. live sizing feedback quality
6. baseline benchmarking

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
- audit, lineage, and diagnostics scaffolding
- daily review and learning scaffolding

This repository is currently weaker in:

- raw alpha sophistication
- explicit alpha-vs-execution attribution
- toxicity-aware actionability
- benchmark discipline against simpler alternatives
- evidence clarity on where edge is real and where it is fragile

All work must preserve the strong parts and improve the weaker parts.

---

## Ground rules

### Preserve current core behavior
You must preserve the existing:

- runtime lifecycle
- startup gates
- safety-state and runtime-state gating
- signal/evaluate/execute/reconcile/refresh pipeline
- reconciliation and external truth checks
- daily review / learning flow
- decision log / lineage / diagnostics behavior

### Prefer additive changes
Add new modules and integrate them.
Only refactor existing modules where necessary for clarity, canonicalization, or reuse.

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

### Do not weaken controls
Do not bypass or weaken:

- safety-state controls
- runtime-state permissions
- external portfolio truth checks
- reconciliation freshness checks
- execution viability checks
- lineage and diagnostics emission

### Do not change product class
Do not convert this repository into:

- a symmetric market maker
- a copy-trader
- an opaque LLM-driven live trading bot

It remains a deterministic, execution-aware, directional BTC 5-minute Polymarket trading platform.

---

## Existing files and surfaces that matter most

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

### Runtime and evidence files
- `apps/worker/src/runtime/decision-log.service.ts`
- `apps/worker/src/runtime/version-lineage-registry.ts`
- `apps/worker/src/runtime/learning-state-store.ts`

### Supporting execution/risk files
- `packages/risk-engine/*`
- `packages/execution-engine/*`
- `packages/polymarket-adapter/*`

---

## Non-goals

Unless explicitly required, do not:

- redesign the runtime architecture
- rewrite the entire signal engine from scratch
- replace deterministic logic with black-box live decisioning
- remove current diagnostics, lineage, or learning state
- touch API/UI files
- touch startup/crash recovery flows
- touch unrelated adapter internals
- introduce hidden coupling between unrelated jobs

---

## Execution plan

Implementation must follow these phases in order.

Do not start a later phase until the current phase passes its acceptance checks.

---

# Phase 1 — Canonical alpha attribution foundation

## Goal
Create a canonical representation of:

- raw forecast edge
- paper edge
- expected executable edge
- realized retained edge

## Files to add
- `packages/signal-engine/src/edge/alpha-attribution.ts`

## Required exports
Create explicit interfaces such as:

- `AlphaAttributionInput`
- `AlphaAttributionOutput`
- `ExpectedExecutionCostBreakdown`
- `RealizedExecutionCostBreakdown`

## Required output fields
At minimum:

- `rawForecastProbability`
- `marketImpliedProbability`
- `rawForecastEdge`
- `confidenceAdjustedEdge`
- `paperEdge`
- `expectedExecutionCost`
- `expectedNetEdge`
- `realizedExecutionCost`
- `realizedNetEdge`
- `retentionRatio`
- `capturedAt`

## Integration targets
- `apps/worker/src/jobs/buildSignals.job.ts`
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`

## Required evidence changes
- decision logs include attribution payloads where relevant
- lineage payloads include attribution references where relevant
- execution diagnostics or related evidence include expected vs realized net edge where appropriate

## Definition of done
- canonical module exists
- jobs consume it where relevant
- no current functionality is removed
- decision evidence is extended, not replaced
- tests cover core logic

## Tests required
Add unit tests for:
- positive edge
- negative edge
- zero or near-zero edge
- cost-dominant scenarios
- retention ratio edge cases

## Phase 1 acceptance gate
Before moving to Phase 2, all of the following must be true:

- repo typechecks
- relevant tests pass
- buildSignals, evaluateTradeOpportunities, executeOrders, and dailyReview still compile cleanly
- attribution module is actually used, not just added
- no existing safety behavior is degraded

---

# Phase 2 — Alpha feature enrichment

## Goal
Strengthen the predictive layer with richer market and flow context.

## Files to add
- `packages/signal-engine/src/alpha/flow-features.ts`
- `packages/signal-engine/src/alpha/btc-polymarket-linkage.ts`
- `packages/signal-engine/src/alpha/market-state-transition.ts`
- `packages/signal-engine/src/alpha/edge-decay-profile.ts`
- `packages/signal-engine/src/alpha/market-archetype-classifier.ts`

## Files to update
- `packages/signal-engine/src/feature-builder.ts`
- `packages/signal-engine/src/prior/prior-model.ts`
- `packages/signal-engine/src/posterior/posterior-update.ts`
- `packages/signal-engine/src/regime-classifier.ts`
- `apps/worker/src/jobs/buildSignals.job.ts`

## Required new feature categories
At minimum implement feature families for:

- recent trade or flow imbalance proxy
- book instability or update stress
- BTC move transmission to market-implied probability
- signal-age decay pressure
- market archetype classification

## Requirements for `feature-builder.ts`
Extend the feature type only with fields that are actually consumed downstream.

Do not add dead fields.

## Requirements for `prior-model.ts`
Refactor to use richer structured inputs.
Keep it inspectable.
Support component-level reasoning in diagnostics.

## Requirements for `posterior-update.ts`
Use:
- new flow features
- archetype signals
- decay penalties
- toxicity penalties if available
- confidence-aware adjustments

## Requirements for `buildSignals.job.ts`
Persist or log the new context in admitted and rejected signal evidence.

## Definition of done
- new feature modules exist
- feature builder returns enriched features
- prior/posterior consume them
- signal job records them
- tests cover feature computation and posterior/prior behavior

## Tests required
- unit tests for each feature module
- regression tests for `feature-builder.ts`
- integration tests showing new features affect signal decisions

## Phase 2 acceptance gate
Before moving to Phase 3:

- all Phase 1 checks still pass
- new feature modules are integrated, not dead
- p23 validation still runs
- no regression in basic signal-path compilation or tests
- evidence outputs are richer, not poorer

---

# Phase 3 — Toxicity-aware flow layer

## Goal
Detect and act on toxic flow or unstable microstructure.

## Files to add
- `packages/signal-engine/src/toxicity/flow-toxicity-score.ts`
- `packages/signal-engine/src/toxicity/adverse-selection-risk.ts`
- `packages/signal-engine/src/toxicity/book-instability-score.ts`
- `packages/signal-engine/src/toxicity/toxicity-policy.ts`

## Files to update
- `packages/signal-engine/src/regime-classifier.ts`
- `apps/worker/src/jobs/buildSignals.job.ts`
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`

## Required toxicity outputs
At minimum:
- `toxicityScore`
- `bookInstabilityScore`
- `adverseSelectionRisk`
- `toxicityState`
- `recommendedAction`

## Allowed actions
Support at least:
- no change
- widen threshold
- reduce size
- disable aggressive execution
- temporarily block regime

## Integration requirements

### Build signals
Attach toxicity context to signal evidence.

### Evaluate trades
Use toxicity state to:
- tighten admission
- widen thresholds
- shrink size
- block certain regimes where justified

### Execute orders
Use toxicity state to:
- reduce aggression
- prefer safer execution mode
- potentially reject if execution risk becomes too high

### Daily review
Track toxicity-conditioned performance.

## Definition of done
- toxicity modules exist
- toxicity influences decisions in evaluation and/or execution
- toxicity appears in diagnostics and lineage
- daily review reports toxicity-conditioned outcomes

## Tests required
- unit tests for toxicity calculators
- policy tests for each toxicity action branch
- integration tests showing size/aggression changes under toxicity

## Phase 3 acceptance gate
Before moving to Phase 4:

- all prior phase checks still pass
- toxicity is actionable, not just logged
- toxicity does not bypass safety-state rules
- execution remains deterministic and bounded
- diagnostics clearly show toxicity influence

---

# Phase 4 — Live sizing feedback policy

## Goal
Make recent performance and degradation influence live sizing and permissions more directly.

## Files to add
- `packages/risk-engine/src/live-sizing-feedback-policy.ts`

## Files to update
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`

## Inputs required
At minimum the policy should consume:
- retention ratio
- calibration health
- execution drift
- regime degradation
- toxicity state
- venue uncertainty
- recent realized-vs-expected performance

## Outputs required
At minimum:
- `sizeMultiplier`
- `aggressionCap`
- `thresholdAdjustment`
- `regimePermissionOverride`
- `reasonCodes`

## Integration requirements

### Evaluate trades
Apply the size multiplier and threshold adjustment.

### Execute orders
Respect aggression cap and execution-style restrictions.

### Daily review
Persist summary evidence that can feed future cycles.

## Definition of done
- policy exists
- evaluation uses it
- execution uses it
- evidence is persisted
- tests cover shrink, hold, and scale-up cases

## Tests required
- unit tests for policy under healthy/degraded/toxic cases
- integration tests showing live size changes when retention collapses

## Phase 4 acceptance gate
Before moving to Phase 5:

- all prior phase checks still pass
- live sizing changes are evidence-driven
- sizing does not bypass existing capital/safety protections
- execution behavior remains compatible with current runtime controls

---

# Phase 5 — Baseline benchmarking framework

## Goal
Require the strategy to beat simpler alternatives.

## Files to add
- `packages/signal-engine/src/benchmarks/btc-follow-baseline.ts`
- `packages/signal-engine/src/benchmarks/momentum-baseline.ts`
- `packages/signal-engine/src/benchmarks/reversion-baseline.ts`
- `packages/signal-engine/src/benchmarks/no-regime-baseline.ts`
- `apps/worker/src/validation/baseline-comparison.ts`

## Files to update
- `apps/worker/src/validation/p23-validation.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/jobs/capitalGrowthReview.job.ts`

## Required benchmark outputs
At minimum for each baseline:
- sample count
- expected EV
- realized EV
- realized-vs-expected
- trade count
- opportunity-class distribution if relevant
- regime breakdown if relevant

## Definition of done
- benchmark modules exist
- p23 validation compares main strategy vs baselines
- daily review stores benchmark comparison summaries
- capital growth review can reference benchmark outperformance or failure

## Tests required
- unit tests for baseline generators
- validation tests showing comparison outputs are produced

## Phase 5 acceptance gate
Before moving to Phase 6:

- all prior phase checks still pass
- p23 validation still runs end to end
- baseline comparisons are replayable and explicit
- no benchmark depends on opaque external assumptions without documentation

---

# Phase 6 — Validation and evidence expansion

## Goal
Strengthen empirical proof and make output actionable.

## Files to add
- `apps/worker/src/validation/live-proof-scorecard.ts`
- `apps/worker/src/validation/retention-report.ts`
- `apps/worker/src/validation/regime-performance-report.ts`

## Files to update
- `apps/worker/src/validation/p23-validation.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/jobs/capitalGrowthReview.job.ts`
- `apps/worker/src/runtime/decision-log.service.ts`
- `apps/worker/src/runtime/version-lineage-registry.ts`

## Required report outputs
At minimum:
- per-regime expected vs realized EV
- per-regime retention ratio
- per-regime calibration gaps
- toxicity-conditioned results
- benchmark comparison summary
- live proof scorecard summary

## Definition of done
- reports exist
- p23 validation writes stronger evidence artifacts
- daily review includes summaries of retention and benchmark results
- lineage references the relevant evidence where appropriate

## Tests required
- report generation tests
- p23 validation regression tests
- persistence/logging tests where applicable

## Phase 6 acceptance gate
Before moving to Phase 7:

- all prior phase checks still pass
- evidence outputs are materially richer
- synthetic-only evidence is not treated as promotion proof
- benchmark and retention outputs are visible in review artifacts

---

# Phase 7 — Job integration hardening

## Goal
Ensure new modules are actually wired into live paths correctly.

## Files to update
- `apps/worker/src/jobs/buildSignals.job.ts`
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`

## Required integration behavior

### `buildSignals.job.ts`
Must:
- consume enriched features
- compute and persist alpha attribution
- attach archetype and toxicity context
- preserve admitted vs rejected evidence

### `evaluateTradeOpportunities.job.ts`
Must:
- consume alpha attribution
- apply live sizing feedback policy
- apply toxicity-aware admission logic
- preserve reason codes and evidence

### `executeOrders.job.ts`
Must:
- consume retained-edge expectations
- react to toxicity and aggression caps
- produce realized retention diagnostics

### `dailyReview.job.ts`
Must:
- summarize retention and benchmark evidence
- feed live sizing inputs
- preserve review outputs in learning state

## Definition of done
- no new modules remain unused
- all new policy outputs influence a live or validation path
- integration tests confirm end-to-end behavior changes

## Tests required
- integration tests across modified jobs
- evidence regression checks where feasible

## Final acceptance gate
The full upgrade is only complete if:

- all earlier phase gates pass
- no dead modules remain
- no current functionality was silently removed
- tests and validation commands run successfully
- diagnostics, lineage, and review outputs are richer than before
- the repository can more clearly answer:
  - where forecast edge comes from
  - whether it survives execution
  - which regimes actually work
  - which baselines are being beaten
  - whether toxicity should force defense
  - whether live size should shrink or hold

---

## Required schemas

### Learning state additions
Extend learning state only as needed, but define explicit fields for:
- latest retention summary
- latest benchmark summary
- latest toxicity summary
- latest live sizing evidence summary

Do not store redundant or massive raw blobs unless necessary.

### Diagnostics additions
Execution diagnostics or associated evidence should include:
- expected net edge
- realized net edge
- retention ratio
- toxicity state
- archetype or regime context

### Decision log additions
Decision logs should be extended to include:
- alpha attribution
- toxicity context
- live sizing feedback result
- benchmark or review references when relevant

---

## Do-not-touch list unless necessary

Avoid editing these unless there is a clear integration requirement:
- runtime startup and crash recovery files
- API/UI files
- unrelated adapter internals
- broad domain schemas beyond what is needed for evidence

If you must touch them, keep changes minimal and compatibility-safe.

---

## Test policy

Every phase must include tests.

### Required test classes
- unit tests for pure calculators/policies
- integration tests for changed jobs
- validation tests for report/benchmark generation

### Minimum test expectations
- all new modules have at least one direct unit test
- each modified major job has at least one integration coverage change
- p23 validation remains runnable and more informative than before

### Preferred test placement
Follow existing repository conventions.
New pure modules should get direct unit tests near their package test conventions.
Changed worker jobs should receive integration coverage under existing worker test patterns.

---

## Validation commands

Use existing repo commands where possible rather than inventing replacements.

At minimum, contributors should preserve or extend support for commands equivalent to:

- `pnpm test`
- `pnpm typecheck`
- `pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:p23`
- `pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:dataset-quality`

If exact scripts differ, update scripts in a compatibility-safe way and document them.

Do not remove current useful commands without replacing them.

---

## Rollback and failure handling

If a phase causes:
- failing typecheck
- failing tests
- broken validation
- degraded evidence quality
- broken runtime integration

stop and repair before proceeding.

Do not continue stacking phases on a broken base.

If a new module adds complexity without measurable value, either simplify it or remove it before moving on.

---

## Success criteria

This upgrade is successful only if the repository can more clearly answer:

- Where does forecast edge come from?
- Does forecast edge survive execution?
- Which regimes really work?
- Which baselines are being beaten?
- Is current underperformance alpha-driven or execution-driven?
- Is toxicity currently high enough to force defense?
- Should live size shrink or hold based on recent evidence?

And only if:
- existing core functionality still works
- risk and runtime protections remain intact
- evidence quality improves materially

---

## Short checklist for contributors

Before considering work complete, verify:

- [ ] Existing runtime and safety behavior preserved
- [ ] Alpha attribution module added and integrated
- [ ] Feature enrichment added and integrated
- [ ] Toxicity module added and actionable
- [ ] Live sizing feedback policy added and used
- [ ] Baselines added and compared
- [ ] Validation outputs expanded
- [ ] Decision log / lineage updated where needed
- [ ] Tests added
- [ ] No dead modules left unintegrated
- [ ] Existing commands still work or were safely replaced

---

## Final implementation intent

Do not treat this as a request for cosmetic refactoring.

Treat it as a focused upgrade program to move the system from:

- strong execution-and-control platform with moderate alpha

to:

- strong execution-and-control platform with better alpha
- better proof
- better attribution
- better toxicity handling
- better evidence-driven capital deployment