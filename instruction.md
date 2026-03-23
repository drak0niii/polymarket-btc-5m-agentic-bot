# instruction.md

# Phase 11 Implementation Instructions for Codex
## Governed Self-Improvement Layer

Implement Phase 11 as a safety-first, evidence-driven, replayable adaptation layer for the Polymarket trading system.

You must execute the work in strict sequence.
Do not skip ahead.
Do not widen scope.
Do not drift into unrelated refactors.

---

# Primary objective

Add the missing closed loop:

**observe → attribute → evaluate → propose change → validate → approve/promote → deploy under guardrails → monitor → rollback if needed**

The resulting system must be able to:
- learn from realized live outcomes
- reduce aggressiveness when evidence degrades
- compare incumbents and challengers safely
- promote only with explicit evidence
- quarantine degraded slices precisely
- adapt execution from realized venue behavior
- reallocate capital only after validated improvement
- preserve exact lineage and replayability for every learning-driven change

---

# Mandatory constraints

## Constraint 1 — no uncontrolled self-modification
Do not add any mechanism that silently changes live trading behavior inside the signal, evaluation, or execution path.
All learned changes must pass through:
- stored learning state
- learning-cycle orchestration
- typed decision outputs
- deployment registry
- rollout / rollback controls
- version lineage

## Constraint 2 — no duplicate domain vocabularies
When you create canonical files for domain types, import from them everywhere else.
Do not redefine equivalent types in downstream modules.

## Constraint 3 — no fake completion
Do not report a step as complete if:
- files were created but not wired
- typecheck passes but runtime integration is missing
- tests are mock-only and do not validate state transitions
- outputs exist but are not persisted
- decisions are made but not logged

## Constraint 4 — safety beats aggressiveness
When evidence is weak or conflicting, the system must prefer:
- confidence shrinkage
- smaller sizing
- stricter thresholds
- restricted rollout
- precise quarantine
- rollback

## Constraint 5 — exact sequencing is mandatory
You must complete Phase 11 in waves, in order.
Do not begin Wave 2 until Wave 1 acceptance criteria are met.
Do not begin Wave 3 until Wave 2 acceptance criteria are met.

---

# WAVE 1 — Minimum viable self-improvement

## Goal
Deliver a real daily learning cycle that persists state, attributes edge by regime/context, updates calibration from realized outcomes, emits learning events, and safely reduces aggressiveness when evidence degrades.

## Implement exactly these files first
1. `packages/domain/src/learning-state.ts`
2. `apps/worker/src/runtime/learning-state-store.ts`
3. `apps/worker/src/runtime/learning-event-log.ts`
4. `apps/worker/src/jobs/dailyReview.job.ts`
5. `apps/worker/src/orchestration/learning-cycle-runner.ts`
6. `packages/risk-engine/src/regime-edge-attribution.ts`
7. `packages/risk-engine/src/edge-decay-detector.ts`
8. `packages/signal-engine/src/live-calibration-store.ts`
9. `packages/signal-engine/src/live-calibration-updater.ts`
10. `packages/signal-engine/src/confidence-shrinkage-policy.ts`

## Requirements for Wave 1

### 1. `packages/domain/src/learning-state.ts`
Create the canonical types for all learning-related state.
It must export at minimum:
- `HealthLabel`
- `LearningState`
- `StrategyVariantState`
- `RegimePerformanceSnapshot`
- `CalibrationState`
- `ExecutionLearningState`
- `PromotionDecision`
- `QuarantineDecision`
- `CapitalAllocationDecision`
- `LearningCycleSummary`
- `LearningEvent`

Do not create competing versions elsewhere.

### 2. `apps/worker/src/runtime/learning-state-store.ts`
Implement durable state persistence.
Requirements:
- load state
- initialize defaults if missing
- save atomically
- keep backup snapshots
- fail safely on corrupted writes

### 3. `apps/worker/src/runtime/learning-event-log.ts`
Implement append-only learning event storage.
Every material adaptive event must be durable and inspectable.

### 4. `apps/worker/src/jobs/dailyReview.job.ts`
Convert this into the primary learning-cycle orchestrator.
It must:
- load realized outcomes
- load prior learning state
- run attribution
- run calibration update
- evaluate degradation
- generate learning summary
- persist updated state
- append learning events

Do not let this job mutate live behavior directly.
It may produce outputs that downstream runtime logic can consume.

### 5. `apps/worker/src/orchestration/learning-cycle-runner.ts`
Create one deterministic coordinator for the learning cycle.
Evaluation order must be explicit and stable.
Partial failures must be visible in the summary.

### 6. `packages/risk-engine/src/regime-edge-attribution.ts`
Compute expected-vs-realized performance by:
- regime
- liquidity bucket
- spread bucket
- time-to-expiry bucket
- entry timing bucket
- execution style
- side
- strategy variant

Do not return only global aggregates.

### 7. `packages/risk-engine/src/edge-decay-detector.ts`
Detect persistent degradation.
Required labels:
- `healthy`
- `watch`
- `degraded`
- `quarantine_candidate`

Use deterministic threshold-based logic.
Do not escalate from a single noisy sample.

### 8. `packages/signal-engine/src/live-calibration-store.ts`
Persist calibration state by strategy/context.
Must store:
- sample count
- Brier score
- log loss
- shrinkage factor
- health label
- version

### 9. `packages/signal-engine/src/live-calibration-updater.ts`
Update calibration state from realized outcomes.
Must detect overconfidence and emit drift signals.
Poor calibration must weaken confidence.

### 10. `packages/signal-engine/src/confidence-shrinkage-policy.ts`
Translate degraded calibration into safer behavior.
It must return typed threshold and size multipliers plus rationale.

---

# Wave 1 acceptance criteria

Do not continue until all are true:
- learning state persists across restart
- learning events are append-only and readable
- daily learning cycle produces a machine-readable summary
- regime attribution updates bucketed performance snapshots
- calibration updates from realized outcomes
- degraded calibration can reduce aggressiveness through explicit shrinkage logic
- no duplicate learning-state vocabularies were introduced

## Required Wave 1 verification commands
Run these after implementation:

```bash
pnpm -r typecheck
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
rg "interface .*LearningState|type .*LearningState|interface .*CalibrationState|type .*CalibrationState|interface .*StrategyVariantState|type .*StrategyVariantState" packages apps
rg "dailyReview|LearningCycleSummary|learning-cycle-runner|live-calibration-updater|regime-edge-attribution" apps packages
```

Adjust the worker package filter only if the actual package name differs.

---

# WAVE 2 — Controlled strategy evolution

## Goal
Add champion–challenger evaluation, promotion discipline, quarantine, staged rollout, and rollback.

## Implement only after Wave 1 passes
11. `packages/domain/src/strategy-variant.ts`
12. `packages/signal-engine/src/champion-challenger-manager.ts`
13. `packages/signal-engine/src/shadow-evaluation-engine.ts`
14. `packages/signal-engine/src/promotion-decision-engine.ts`
15. `packages/signal-engine/src/strategy-quarantine-policy.ts`
16. `apps/worker/src/runtime/strategy-deployment-registry.ts`
17. `apps/worker/src/runtime/strategy-rollout-controller.ts`
18. `apps/worker/src/runtime/rollback-controller.ts`

## Requirements for Wave 2

### Strategy variant types
Create canonical lifecycle types and statuses.
Statuses must include:
- `incumbent`
- `shadow`
- `canary`
- `quarantined`
- `retired`

### Champion–challenger manager
Register challengers, maintain lineage, track evaluation mode, allow multiple challengers.
Do not let this module promote directly.

### Shadow evaluation engine
Evaluate challengers without unrestricted capital.
Produce evidence packages for the promotion engine.

### Promotion decision engine
Return only typed explicit decisions:
- `reject`
- `shadow_only`
- `canary`
- `promote`
- `rollback`

Every decision must include explicit reasons.
Do not promote on PnL alone.

### Strategy quarantine policy
Support precise quarantine by:
- variant
- regime
- market context

Every quarantine must include reason and severity.

### Deployment registry
Persist what is live:
- incumbent
- challengers
- rollout stage
- quarantines
- retired variants

### Rollout controller
Support:
- shadow only
- canary 1%
- canary 5%
- partial
- full

Canary capital must be bounded.

### Rollback controller
Rollback on:
- realized EV collapse
- calibration collapse
- execution deterioration
- unexplained drawdown threshold
- quarantine escalation

---

# Wave 2 acceptance criteria

Do not continue until all are true:
- challengers can be registered and tracked
- challengers can be evaluated in shadow form
- promotion decisions are explicit and reasoned
- rollout stages are bounded and inspectable
- degraded promoted variants can roll back automatically
- quarantine is precise and does not default to full-engine halt

## Required Wave 2 verification commands

```bash
pnpm -r typecheck
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
rg "promotion-decision-engine|strategy-quarantine-policy|strategy-rollout-controller|rollback-controller|champion-challenger-manager" apps packages
```

---

# WAVE 3 — Execution learning

## Goal
Make execution policy adapt from realized fill and venue behavior in a typed, replayable, versioned manner.

## Implement only after Wave 2 passes
19. `packages/execution-engine/src/execution-learning-store.ts`
20. `packages/execution-engine/src/execution-policy-updater.ts`
21. `packages/execution-engine/src/adaptive-maker-taker-policy.ts`
22. `packages/execution-engine/src/adverse-selection-monitor.ts`
23. `packages/execution-engine/src/execution-policy-version-store.ts`

## Requirements for Wave 3

### Execution learning store
Persist execution-quality metrics by context, including:
- maker fill rate
- taker fill rate
- fill delay
- slippage
- adverse selection
- cancel success
- partial-fill behavior

### Execution policy updater
Update fill-probability and slippage assumptions from realized venue outcomes.
Do not mutate live order logic directly inside this module.
Output must be versionable.

### Adaptive maker-taker policy
Choose execution style using learned context.
Must consider:
- fill delay
- adverse selection
- slippage
- market context

### Adverse selection monitor
Detect whether passive liquidity is being punished independently of global PnL.

### Execution policy version store
Version every learned execution-policy change.

---

# Wave 3 acceptance criteria

Do not continue until all are true:
- execution learning persists across restart
- execution assumptions update from realized fills
- adaptive execution choices are typed and explainable
- execution policy versions are durable and replayable

## Required Wave 3 verification commands

```bash
pnpm -r typecheck
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
rg "execution-learning-store|execution-policy-updater|adaptive-maker-taker-policy|adverse-selection-monitor|execution-policy-version-store" apps packages
```

---

# WAVE 4 — Portfolio learning and capital routing

## Goal
Move from trade-level adaptation to portfolio-level capital intelligence.

## Implement only after Wave 3 passes
24. `packages/risk-engine/src/portfolio-learning-state.ts`
25. `packages/risk-engine/src/capital-allocation-engine.ts`
26. `packages/risk-engine/src/strategy-correlation-monitor.ts`
27. `packages/risk-engine/src/allocation-promotion-gate.ts`

## Requirements for Wave 4

### Portfolio learning state
Track:
- allocation by variant
- allocation by regime
- allocation by opportunity class
- drawdown by sleeve
- concentration and correlation signals

### Capital allocation engine
Route capital using:
- performance quality
- calibration health
- execution health
- drawdown
- sample sufficiency
- concentration penalties

Every decision must include rationale.

### Strategy correlation monitor
Detect hidden overlap between variants or sleeves.

### Allocation promotion gate
Block capital scaling unless:
- calibration is healthy
- execution is healthy
- sample is sufficient
- concentration is acceptable

---

# Wave 4 acceptance criteria

Do not continue until all are true:
- portfolio-level learning state exists
- allocation decisions are evidence-driven
- concentration penalties can block scaling
- degraded variants can be de-scaled without disabling the full system

## Required Wave 4 verification commands

```bash
pnpm -r typecheck
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
rg "capital-allocation-engine|strategy-correlation-monitor|allocation-promotion-gate|portfolio-learning-state" apps packages
```

---

# WAVE 5 — Version lineage, venue learning, inspectability, integration tests

## Goal
Make the learning layer fully auditable, venue-aware, operator-inspectable, and proven by integration tests.

## Implement only after Wave 4 passes
28. `packages/domain/src/version-lineage.ts`
29. `apps/worker/src/runtime/version-lineage-registry.ts`
30. `apps/worker/src/runtime/decision-replay-context.ts`
31. `packages/polymarket-adapter/src/venue/venue-health-learning-store.ts`
32. `packages/polymarket-adapter/src/venue/venue-uncertainty-detector.ts`
33. `packages/polymarket-adapter/src/venue/venue-mode-policy.ts`
34. operator commands
35. integration tests

## Operator commands to add
- `apps/worker/src/commands/print-learning-state.command.ts`
- `apps/worker/src/commands/print-strategy-lineage.command.ts`
- `apps/worker/src/commands/run-learning-cycle.command.ts`
- `apps/worker/src/commands/print-promotion-decision.command.ts`

## Integration tests to add
- `apps/worker/src/tests/learning-cycle.integration.test.ts`
- `apps/worker/src/tests/champion-challenger.integration.test.ts`
- `apps/worker/src/tests/execution-learning.integration.test.ts`
- `apps/worker/src/tests/quarantine-policy.integration.test.ts`
- `apps/worker/src/tests/version-lineage.integration.test.ts`

## Requirements for Wave 5

### Version lineage
Canonical lineage must exist for:
- strategy version
- feature-set version
- calibration version
- execution-policy version
- risk-policy version
- allocation-policy version

### Version-lineage registry
Any live decision must be traceable to the exact version ids used.

### Decision replay context
Historical decisions must be reconstructable from:
- market state
- runtime state
- learning state
- lineage state
- active parameter bundle
- venue mode if relevant

### Venue health learning
Persist venue metrics such as:
- latency distributions
- request failures
- stale data intervals
- open-order visibility lag
- trade visibility lag
- cancel acknowledgement lag

### Venue uncertainty detector
Map venue behavior into:
- `healthy`
- `degraded`
- `unsafe`

### Venue mode policy
Map venue health into runtime modes:
- normal
- size-reduced
- cancel-only
- reconciliation-only

### Operator commands
Operators must be able to inspect current learning, lineage, and promotion state without opening raw storage manually.

### Integration tests
Tests must prove safe self-improvement behavior, not only type safety.

---

# Wave 5 acceptance criteria

Phase 11 is not complete unless all of the following are true:
- every live decision can be traced to exact versions
- decision replay context can be reconstructed
- venue instability can force safer runtime restrictions
- operator commands expose learning and lineage state
- integration tests prove learning, promotion, rollback, quarantine, execution adaptation, and lineage behavior

## Required Wave 5 verification commands

```bash
pnpm -r typecheck
pnpm test
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
rg "learning-state-store|learning-event-log|learning-cycle-runner|live-calibration-updater|confidence-shrinkage-policy|promotion-decision-engine|strategy-rollout-controller|rollback-controller|capital-allocation-engine|version-lineage-registry|venue-uncertainty-detector" apps packages
```

---

# Required final verification gate

Before claiming Phase 11 complete, run all of these.

```bash
pnpm -r typecheck
pnpm test
pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
```

Then verify required files exist.

```bash
test -f packages/domain/src/learning-state.ts && \
test -f apps/worker/src/runtime/learning-state-store.ts && \
test -f apps/worker/src/runtime/learning-event-log.ts && \
test -f apps/worker/src/jobs/dailyReview.job.ts && \
test -f apps/worker/src/orchestration/learning-cycle-runner.ts && \
test -f packages/risk-engine/src/regime-edge-attribution.ts && \
test -f packages/risk-engine/src/edge-decay-detector.ts && \
test -f packages/signal-engine/src/live-calibration-store.ts && \
test -f packages/signal-engine/src/live-calibration-updater.ts && \
test -f packages/signal-engine/src/confidence-shrinkage-policy.ts && \
test -f packages/domain/src/strategy-variant.ts && \
test -f packages/signal-engine/src/champion-challenger-manager.ts && \
test -f packages/signal-engine/src/shadow-evaluation-engine.ts && \
test -f packages/signal-engine/src/promotion-decision-engine.ts && \
test -f packages/signal-engine/src/strategy-quarantine-policy.ts && \
test -f apps/worker/src/runtime/strategy-deployment-registry.ts && \
test -f apps/worker/src/runtime/strategy-rollout-controller.ts && \
test -f apps/worker/src/runtime/rollback-controller.ts && \
test -f packages/execution-engine/src/execution-learning-store.ts && \
test -f packages/execution-engine/src/execution-policy-updater.ts && \
test -f packages/execution-engine/src/adaptive-maker-taker-policy.ts && \
test -f packages/execution-engine/src/adverse-selection-monitor.ts && \
test -f packages/execution-engine/src/execution-policy-version-store.ts && \
test -f packages/risk-engine/src/portfolio-learning-state.ts && \
test -f packages/risk-engine/src/capital-allocation-engine.ts && \
test -f packages/risk-engine/src/strategy-correlation-monitor.ts && \
test -f packages/risk-engine/src/allocation-promotion-gate.ts && \
test -f packages/domain/src/version-lineage.ts && \
test -f apps/worker/src/runtime/version-lineage-registry.ts && \
test -f apps/worker/src/runtime/decision-replay-context.ts && \
test -f packages/polymarket-adapter/src/venue/venue-health-learning-store.ts && \
test -f packages/polymarket-adapter/src/venue/venue-uncertainty-detector.ts && \
test -f packages/polymarket-adapter/src/venue/venue-mode-policy.ts && \
test -f apps/worker/src/commands/print-learning-state.command.ts && \
test -f apps/worker/src/commands/print-strategy-lineage.command.ts && \
test -f apps/worker/src/commands/run-learning-cycle.command.ts && \
test -f apps/worker/src/commands/print-promotion-decision.command.ts && \
test -f apps/worker/src/tests/learning-cycle.integration.test.ts && \
test -f apps/worker/src/tests/champion-challenger.integration.test.ts && \
test -f apps/worker/src/tests/execution-learning.integration.test.ts && \
test -f apps/worker/src/tests/quarantine-policy.integration.test.ts && \
test -f apps/worker/src/tests/version-lineage.integration.test.ts
```

Then verify no duplicate core vocabularies were reintroduced.

```bash
rg "interface .*LearningState|type .*LearningState|interface .*StrategyVariant|type .*StrategyVariant|interface .*CalibrationState|type .*CalibrationState|interface .*PromotionDecision|type .*PromotionDecision" packages apps
```

---

# Completion standard

Phase 11 is complete only if the repository can truthfully demonstrate all of the following:
- learning state persists across restarts
- regime-aware attribution exists
- edge decay is detectable
- calibration updates from realized outcomes
- degraded calibration reduces aggressiveness explicitly
- challengers can be evaluated without uncontrolled promotion
- promotions require explicit evidence
- rollback is automatic and logged
- execution assumptions adapt from realized fills
- failing slices can be quarantined precisely
- capital allocation changes are evidence-driven
- version lineage is durable and queryable
- decision replay context can be reconstructed
- venue instability can force safer runtime modes
- operator commands expose learning and lineage state
- integration tests prove safe self-improvement behavior

If any item above is not yet true, do not claim Phase 11 complete.

---

# Output format required from Codex after each work block

Use this structure exactly:

## Changed files
- exact paths only

## What was implemented
- concise factual summary

## What is now true
- operational statements now true because of the change

## Verification run
- exact commands executed
- pass/fail
- notable warnings or unresolved issues

## Remaining work
- next items from the current wave only

---

# Final instruction

Implement Phase 11 as a controlled operational upgrade.
Optimize for:
- correctness
- auditability
- replayability
- rollback safety
- capital protection
- real venue robustness

Do not optimize for novelty.
Do not improvise outside the wave sequence.
