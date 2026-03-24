# AGENTS.md

## Repository mission

This repository exists to become a production-oriented, capital-protective, evidence-driven autonomous Polymarket trading system that compounds capital through selective, net-profitable trading.

The system is not a toy, not a dashboard project, and not an "AI for AI's sake" experiment.

Its objective is:

**MAXIMIZE LONG-TERM NET CAPITAL GROWTH**

That objective must be pursued only through:
- realistic net-edge estimation
- disciplined trade selection
- execution-cost awareness
- uncertainty-aware sizing
- regime-aware capital allocation
- explicit guardrails
- full auditability and replayability

Do not optimize for raw activity, raw PnL, or superficial autonomy.
Optimize for net expectancy, EV retention, drawdown control, and capital efficiency.

---

## Operating mindset

Treat the repository as a serious live-trading engine where every change must improve or protect one of the following:
- expected net EV
- capital preservation
- execution quality
- compounding efficiency
- decision quality under uncertainty

Assume that bad logic will lose real money.
Assume that overtrading, overconfidence, and poor execution are default failure modes.
Assume that more complexity is not automatically better.

---

## Phase 12 mission

Phase 12 is focused purely on **capital growth and trading effectiveness**.

It is not a generic autonomy phase.
It is not a feature accumulation phase.
It is not a "make the AI smarter" phase.

Phase 12 exists to make the bot:
- take fewer, better trades
- reject weak opportunities after realistic costs
- size capital better
- detect capital leakage faster
- reduce exposure in bad regimes
- preserve more edge after execution
- promote only economically stable behavior

---

## Non-negotiable principles

### 1. Net edge beats raw edge
Never rely on gross forecast edge alone.
Every trading decision must trend toward using:
- forecast edge
- minus fees
- minus expected slippage
- minus adverse selection cost
- minus uncertainty penalty
- minus venue degradation penalty where relevant

If the net edge is weak, the system should prefer no trade.

### 2. Fewer, better trades
Do not optimize for activity.
Do not optimize for trade count.
Do not optimize for signal firing frequency.

Low-quality activity is capital leakage.
Overtrading is a bug.

### 3. Costs are part of edge
Execution is not separate from alpha.
If execution destroys the edge, then there is no real edge.

Any module that ignores realistic costs is economically incomplete.

### 4. Calibration governs aggressiveness
When calibration weakens, confidence and size must shrink.
No exceptions.

### 5. Weak regimes deserve less or zero capital
Do not treat all market regimes equally.
Capital should flow toward proven conditions and away from destructive ones.

### 6. Promotion must reflect capital-growth quality
A variant should not promote merely because it had recent profits.
It must prove:
- net edge quality
- acceptable drawdown
- healthy calibration
- healthy execution retention
- stable regime behavior
- acceptable leak profile

### 7. Replayability and explicitness remain mandatory
Do not bypass Phase 11 controls.
Do not introduce hidden adaptive behavior.
Do not introduce silent parameter drift.
Every learned economic behavior must remain typed, logged, versioned, and replayable.

---

## What not to do

Do not:
- add black-box online RL to the live path
- optimize on gross PnL only
- increase complexity without clear economic benefit
- allow profitable-but-unstable variants to scale automatically
- trade marginal net-edge opportunities just to stay active
- bury economic logic inside ad hoc execution code
- bypass rollout, rollback, quarantine, lineage, or logging

---

## Build order discipline

Implement Phase 12 in exactly 5 waves.
Do not skip ahead.
Do not work on later waves before current-wave verification is complete.

### Wave 1
Net-edge realism and no-trade logic

### Wave 2
Capital leak attribution and trade quality

### Wave 3
Regime economics and anti-overtrading controls

### Wave 4
Execution-cost realism and uncertainty-weighted sizing

### Wave 5
Promotion economics, capital-growth metrics, commands, and integration tests

---

## General implementation rules

### Rule A
Prefer explicit typed inputs and outputs over implicit objects.

### Rule B
Prefer deterministic threshold-based decisions first.
Do not begin with opaque adaptive logic where the economic safety case is unclear.

### Rule C
Prefer surgical capital reduction over blanket shutdown when conditions degrade.

### Rule D
Every meaningful decision should be explainable in terms of:
- expected net benefit
- estimated risk
- uncertainty
- cost
- regime context

### Rule E
Economic logic must integrate with existing Phase 11 systems instead of bypassing them.
That includes:
- learning state
- promotion decisions
- quarantine policy
- rollout controller
- rollback controller
- version lineage
- replay context

---

## Success standard for Phase 12

Phase 12 succeeds only if the repository becomes materially better at:
- rejecting weak trades
- allocating capital only where justified
- retaining more edge after costs
- reducing capital leakage
- avoiding destructive regimes
- controlling overtrading
- promoting only economically stable behavior

If the system becomes more complex but not more capital-efficient, Phase 12 has failed.

---

## Final instruction to Codex / engineer

Implement Phase 12 as a performance phase, not a novelty phase.
At every step ask:

**Does this improve net capital growth or reduce capital leakage in a measurable way?**

If the answer is no, do not prioritize it.
