# AGENTS.md

## Repository mission

This repository exists to become a **measurably trustworthy capital-growth bot** for live BTC 5-minute Polymarket trading.

Its purpose is not to look sophisticated. Its purpose is to:

- trade only when **net edge remains positive after fees, slippage, queue friction, and adverse selection**
- survive live venue uncertainty without corrupting state
- keep capital sizing bounded by **live evidence quality**
- improve through **controlled, auditable, reversible** learning
- earn higher deployment tiers only through **real operational proof**

The target state is **8+/10 trustworthiness** only when the bot proves:

- durable positive net expectancy after realized costs
- execution quality stable enough to preserve edge
- regime-aware selectivity, including explicit no-trade behavior
- low reconciliation defect rates
- promotion and scaling based on live evidence, not optimism

---

## What this repository is

It is:

- a live-oriented Polymarket BTC 5-minute directional trading system
- a runtime-controlled, reconciliation-first execution platform
- a system that must convert forecast edge into **realized post-cost edge**
- a staged deployment system with shadow, paper, canary, cautious live, and scaled live tiers
- an auditable learning system with bounded adaptation

It is not:

- a generic LLM trading experiment
- a self-rewriting autonomous trader
- a backtest theater repo
- a “just place more trades and learn” system
- a strategy that gets trusted because its architecture is advanced

---

## Prime directive

**MAXIMIZE RISK-ADJUSTED LONG-TERM CAPITAL GROWTH WITHOUT LOSING CONTROL OF EXECUTION, STATE, OR CAPITAL CONTAINMENT**

This prime directive has four mandatory sub-goals:

1. preserve capital first
2. trade only when net edge remains positive after realistic costs
3. scale only when live evidence justifies scaling
4. degrade safely when truth quality becomes uncertain

---

## Mandatory operating principles

1. **Reconciliation beats assumption.**
   External venue truth, account truth, and confirmed execution truth take priority over local intent.

2. **Net edge beats raw signal.**
   Gross predictive strength does not justify a trade unless net expectancy stays positive after realistic costs.

3. **No-trade is a first-class action.**
   The bot must explicitly refuse marginal or noisy conditions.

4. **Evidence beats confidence.**
   Forecast conviction cannot override weak live sample quality.

5. **Bounded adaptation only.**
   The live bot may tune parameters within narrow, audited bounds. It must not rewrite its own strategy logic broadly.

6. **Promotion is earned, not inferred.**
   No strategy variant moves up the rollout ladder without satisfying live promotion gates.

7. **Execution truth is risk truth.**
   Stale user streams, missing cancel confirmations, ghost exposure, or lifecycle ambiguity are direct risk inputs.

8. **Capital protection outranks throughput.**
   If there is tension between making more decisions and protecting capital, protect capital.

---

## Non-negotiable guardrails

### 1) Secret and environment hygiene

- Never commit real secrets.
- Treat `.env`, `.env.smoke`, runtime artifacts, snapshots, and logs as non-source material.
- In non-paper live tiers, missing required credentials must fail hard.
- If secrets have ever been committed, assume compromise and rotate them.

### 2) Deployment-tier discipline

Valid rollout order:

- `shadow`
- `paper`
- `canary`
- `cautious_live`
- `scaled_live`

Rules:

- no skipping tiers
- no direct promotion from paper to scaled live
- readiness artifacts are mandatory for live-executable tiers
- each higher tier requires stronger evidence thresholds

### 3) Reconciliation-first truth model

- local fill assumptions are provisional
- matched is not always final
- reserve release must follow confirmed truth
- portfolio truth, open-order truth, and trade truth must reconcile before the system trusts exposure
- unresolved anomalies must downgrade runtime state automatically

### 4) Learning boundaries

Allowed live-adjustable surfaces:

- entry threshold
- aggressiveness band
- max holding time
- cancel/repost timing
- regime confidence threshold
- size multiplier band within evidence caps

Not allowed for autonomous live rewriting:

- replacing the strategy family wholesale
- changing objective hierarchy
- silently introducing new live features
- changing safety gates or deployment-tier rules
- bypassing promotion criteria

### 5) Capital containment

- sizing must be capped by evidence quality
- regime caps must apply even when a local setup looks strong
- benchmark underperformance must clamp size
- kill-switches must be allowed to drive size to zero immediately
- no strategy may scale because of backtests alone

---

## Canonical truth hierarchy

When system views disagree, trust in this order:

1. confirmed venue/account truth
2. reconciled fill-state truth
3. canonical resolved-trade ledger
4. recent audited runtime snapshots
5. local order-intent metadata
6. forecast and planning assumptions

This hierarchy applies to:

- exposure
- realized pnl
- fee accounting
- slippage attribution
- strategy promotion evidence
- capital scaling evidence

---

## Required architectural stance

All major upgrades must preserve and extend the existing architecture instead of creating parallel systems.

### Extend, do not fork, these subsystems

#### Worker / runtime
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

#### Signal / edge / calibration
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

#### Execution
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

#### Risk / capital / kill-switches
- `packages/risk-engine/src/live-trade-guard.ts`
- `packages/risk-engine/src/live-sizing-feedback-policy.ts`
- `packages/risk-engine/src/regime-capital-policy.ts`
- `packages/risk-engine/src/regime-local-sizing.ts`
- `packages/risk-engine/src/execution-quality-kill-switches.ts`
- `packages/risk-engine/src/expected-vs-realized-ev-guard.ts`
- `packages/risk-engine/src/consecutive-loss-kill-switch.ts`
- `packages/risk-engine/src/capital-ramp-policy-service.ts`
- `packages/risk-engine/src/trade-quality-history-store.ts`
- `packages/risk-engine/src/portfolio-kill-switch-service.ts`

---

## Required new truth surfaces

The implementation plan must establish and keep authoritative the following surfaces:

### 1) Canonical resolved-trade ledger

Every economically resolved trade must generate exactly one canonical resolved record with:

- decision-time assumptions
- execution path facts
- realized costs
- regime/archetype context
- realized net outcome
- attribution labels

This ledger is the source of truth for:

- daily review
- promotion/demotion
- evidence-quality sizing
- realized-vs-expected edge analysis
- benchmark-relative validation

### 2) Net-edge decomposition

Every tradable decision must have a persisted decomposition including:

- gross edge
- fee cost
- slippage cost
- adverse-selection penalty
- queue penalty
- uncertainty penalty
- final net edge

The system must be able to explain both:

- why a trade was approved
- why a trade was rejected

### 3) Empirical execution realism

Planner assumptions must be grounded in recent live evidence by bucket, including:

- fill probability
- fill fraction
- queue delay
- cancel latency
- slippage
- post-fill toxicity

### 4) Regime/no-trade context

Every candidate signal must carry:

- regime label
- regime confidence
- transition risk
- no-trade allow/block status
- no-trade reason codes

### 5) Evidence-weighted sizing decomposition

Every order must have a sizing breakdown showing:

- base risk
- edge factor
- regime factor
- evidence factor
- deployment-tier factor
- kill-switch factor

---

## Trading approval doctrine

A trade is allowed only when all conditions hold:

1. runtime state permits new exposure
2. authenticated venue and user-state truth are healthy enough
3. regime classifier identifies a tradable regime with sufficient confidence
4. no-trade classifier does not block the setup
5. net edge remains positive after realistic costs
6. execution realism does not predict unacceptable fill degradation
7. capital sizing is allowed by evidence quality and tier rules
8. no kill-switch or anomaly detector is active

If any one of these fails, the correct behavior is reject, degrade, cancel-only, or reconciliation-only depending on severity.

---

## Strategy governance doctrine

### Promotion requirements

A strategy variant may be promoted only if it demonstrates:

- minimum live trade count
- positive net expectancy after realized costs
- benchmark-relative outperformance
- acceptable drawdown behavior
- acceptable execution variance
- acceptable reconciliation cleanliness
- no unresolved anomaly pattern

### Demotion / quarantine triggers

A strategy variant must be demoted, clamped, or quarantined when it exhibits:

- persistent realized-vs-expected edge underperformance
- benchmark-relative underperformance
- unstable regime behavior
- repeated adverse-selection spikes
- repeated execution-quality failures
- unresolved lifecycle or reconciliation defects

### Rollout discipline

All rollout must follow the registry and rollout controller. No manual shortcut that bypasses gating logic is acceptable.

---

## Runtime degradation doctrine

The system must be able to move deterministically among:

- `bootstrapping`
- `running`
- `degraded`
- `reconciliation_only`
- `cancel_only`
- `halted_hard`
- `stopped`

### Mandatory degradation triggers

The system must request downgrade when it detects:

- stale user stream while orders are live
- venue/local open-order disagreement
- repeated retry/fail lifecycle states
- abnormal cancel latency
- ghost exposure after reconnect
- filled-locally vs absent-from-venue inconsistency
- realized-vs-expected cost blowout
- repeated partial-fill toxicity deterioration
- reconciliation defect rate above policy threshold

### Escalation logic

- mild execution quality drift → `degraded`
- state truth uncertainty → `reconciliation_only`
- cancel-path urgency with live orders → `cancel_only`
- severe unresolved exposure or truth corruption → `halted_hard`

---

## Daily review doctrine

A valid daily review must answer:

- did the bot make money after costs
- which regimes helped or hurt
- whether losses came from forecast, execution, sizing, regime selection, or fee/slippage underestimation
- whether realized edge matched expected edge
- whether the bot is beating simple baselines after costs
- whether promotion or demotion evidence changed materially
- whether any anomaly blocks tier advancement

The daily report is not optional bookkeeping. It is a control system input.

---

## Code-change priorities

Implementation work must follow this order unless a security issue forces reordering.

### Priority 0 — before all live trust work
1. secret hygiene and environment hardening
2. canonical resolved-trade ledger
3. net-edge-after-costs truth path
4. live-calibrated fill realism
5. regime-aware no-trade authority

### Priority 1 — before 8+/10 is realistic
6. evidence-quality sizing
7. live promotion/demotion gates
8. execution-state anomaly handling and kill-switch tightening
9. daily decision-quality pack
10. readiness and rollout enforcement

### Priority 2 — only after Priority 0/1
11. better review UX / CLI summaries
12. secondary model upgrades
13. broader benchmark families

No work on cosmetic dashboards or non-essential abstractions may delay Priority 0 items.

---

## File-by-file intent map

### Worker layer

#### `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
Must become the canonical point where:

- net-edge decomposition is consumed
- regime/no-trade admission is enforced
- evidence-weighted sizing is applied
- full decision metadata is persisted

#### `apps/worker/src/jobs/executeOrders.job.ts`
Must persist planner assumptions, expected fill realism, and order-style rationale so later reconciliation can judge whether execution matched expectation.

#### `apps/worker/src/jobs/reconcileFills.job.ts`
Must write canonical resolved-trade records, update empirical fill realism, compute realized-vs-expected edge gaps, and emit auditable resolution events.

#### `apps/worker/src/jobs/refreshPortfolio.job.ts`
Must backfill final economic truth for recently resolved trades after external portfolio truth refresh.

#### `apps/worker/src/jobs/dailyReview.job.ts`
Must consume the resolved-trade ledger and produce daily decision-quality, promotion, demotion, and readiness evidence.

#### `apps/worker/src/runtime/*`
Must preserve deterministic rollout, startup gates, runtime transitions, and anomaly-triggered degradation.

### Signal layer

#### `packages/signal-engine/src/net-edge-estimator.ts`
Must return a decomposed cost-aware edge structure, not a black-box scalar only.

#### `packages/signal-engine/src/executable-ev-model.ts`
Must use empirical execution realism rather than optimistic static assumptions.

#### `packages/signal-engine/src/regime-classifier.ts`
Must produce regime confidence and transition-risk output that materially affects approval behavior.

#### `packages/signal-engine/src/trade-admission-gate.ts`
Must reject trades lacking sufficient regime confidence, live evidence quality, or net edge.

#### `packages/signal-engine/src/champion-challenger-manager.ts`
Must treat live promotion gates as mandatory.

### Execution layer

#### `packages/execution-engine/src/order-planner.ts`
Must output expected fill probability, fill fraction, queue delay, realized-cost estimate, adverse-selection penalty, and style rationale.

#### `packages/execution-engine/src/fill-probability-estimator.ts`
Must become empirical and bucket-based.

#### `packages/execution-engine/src/slippage-estimator.ts`
Must be calibrated from real fills.

#### `packages/execution-engine/src/realized-cost-model.ts`
Must produce a realized breakdown matching the estimator’s decomposition.

#### `packages/execution-engine/src/fill-state-service.ts`
Must distinguish provisional, matched, partial, retrying, failed, and finalized truth carefully.

### Risk layer

#### `packages/risk-engine/src/live-sizing-feedback-policy.ts`
Must blend execution quality with evidence quality.

#### `packages/risk-engine/src/regime-capital-policy.ts`
Must cap risk by regime trust, not regime label alone.

#### `packages/risk-engine/src/capital-ramp-policy-service.ts`
Must require evidence thresholds by deployment tier.

#### `packages/risk-engine/src/execution-quality-kill-switches.ts`
Must include realized-vs-expected edge gap and lifecycle anomaly triggers.

#### `packages/risk-engine/src/portfolio-kill-switch-service.ts`
Must drive deterministic runtime downgrades when truth becomes unsafe.

---

## Testing doctrine

Every new truth-affecting feature must ship with matching integration coverage.

Minimum required coverage includes:

1. resolved trade written once and only once
2. expected vs realized edge decomposition matches ledger truth
3. empirical execution realism updates future planner output
4. no-trade logic blocks high-toxicity or marginal setups
5. evidence-quality sizing caps under-sampled strategies
6. promotion gate rejects benchmark-underperforming strategies
7. execution watchdog triggers correct runtime degradation
8. daily decision-quality report attributes losses correctly

No merge that changes live trading behavior is complete without tests for the new control path.

---

## Review and acceptance doctrine

A code change is acceptable only if it:

- preserves or strengthens safety controls
- improves truth quality or decision quality in a measurable way
- leaves structured evidence for future review
- does not create parallel shadow logic that bypasses canonical systems
- is auditable and reversible

Reject any change that:

- weakens runtime or reconciliation safeguards
- increases live autonomy without increasing proof requirements
- hides cost components inside opaque scores
- scales capital without evidence-based gating
- confuses provisional and final execution truth

---

## Hard no-go conditions for scaled capital

Do not advance beyond canary if any of the following is false:

1. resolved-trade ledger is complete and internally consistent
2. net edge remains positive after realized costs over a meaningful live window
3. strategy beats simple baselines after costs
4. realized-vs-expected edge gap stays within tolerance
5. reconciliation defect rate stays below policy threshold
6. no unresolved execution-state anomalies remain active
7. recent daily decision-quality reports are available and healthy
8. readiness and smoke gates pass mechanically for the target tier

---

## Final instruction to all contributors and agents

When modifying this repository, act as though the bot is one good week away from earning trust and one sloppy assumption away from losing it.

That means:

- prefer explicit truth over convenience
- prefer smaller, auditable improvements over broad rewrites
- prefer capital containment over trade frequency
- prefer live evidence over theoretical confidence
- prefer deterministic downgrade over hopeful continuation

The repository becomes trustworthy not when it looks advanced, but when it repeatedly proves that it can preserve edge, preserve capital, and preserve control under live conditions.
