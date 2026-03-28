# AGENTS.md

## Repository mission

This repository must support **two explicit operating modes** for the BTC 5-minute Polymarket system:

1. **Sentinel Simulation Mode** — a learning-first, no-real-orders mode that simulates trade execution end to end, learns from those simulated outcomes, and decides whether the system is ready to recommend live trading.
2. **Real Trading Mode** — the existing live execution path, which may only be enabled by a user-controlled dashboard switch after Sentinel has produced enough evidence.

The immediate objective of this document is not to optimize live returns directly.
It is to create a **strict, auditable sentinel gate** that answers:

- how many simulated trades have been taken
- how many have been learned from
- what the current learning baseline is
- what threshold remains before the system is considered ready
- whether the system recommends switching from simulation to live trading

This repository must never silently blur simulation and live trading.

---

## Prime directive

**BUILD A SENTINEL-FIRST TRADING SYSTEM THAT LEARNS SAFELY FROM SIMULATED BTC 5-MINUTE POLYMARKET TRADES BEFORE ANY REAL CAPITAL IS DEPLOYED**

Sub-goals:

1. simulation must reuse the real decision path as much as possible
2. simulation must never place real orders
3. learning must be based on explicit, reviewable trade outcomes
4. readiness to go live must be computed from clear thresholds, not vague confidence
5. the dashboard must let the user switch modes explicitly and must display sentinel progress clearly

---

## Non-negotiable operating rules

1. **Simulation and live are separate operating modes.**
   Sentinel mode must never call the real Polymarket order-placement path.

2. **One decision pipeline, two execution targets.**
   Signal generation, edge evaluation, regime logic, no-trade logic, and sizing logic should be reused. Only the execution target changes.

3. **Sentinel must be strict, not theatrical.**
   The simulator must model spread, fees, slippage, fill probability, and timing frictions. It must not assume perfect fills.

4. **Readiness is advisory, not autonomous.**
   Sentinel may recommend “safe to go live,” but the final switch to real trading must be user-controlled via the dashboard.

5. **No real trading until sentinel thresholds pass.**
   If sentinel thresholds are not met, the UI must say so explicitly and live mode should remain visually discouraged.

6. **Learning must be durable and auditable.**
   Every simulated trade and every learning update must be written to artifacts under `artifacts/learning/`.

7. **Learning must be bounded.**
   Sentinel may update narrow parameters and confidence/trust state. It must not rewrite strategy families or bypass risk rules.

8. **The user must always know the current sentinel state.**
   The dashboard must show:
   - current mode
   - simulated trades completed
   - simulated trades learned from
   - target threshold
   - current readiness score
   - recommendation status

---

## Canonical Sentinel operating model

### Mode definitions

#### `sentinel_simulation`
The system:
- runs discovery, market sync, signal generation, edge evaluation, regime classification, no-trade filtering, and sizing
- routes approved trade intents into a simulated execution engine
- writes simulated fills/trade outcomes into dedicated sentinel artifacts
- learns from those outcomes
- never places a live venue order

#### `live_trading`
The system:
- uses the existing live execution path
- may only be entered through the dashboard switch
- should be recommended only when sentinel readiness is satisfied

---

## Minimum Sentinel baseline requirements

Before the first simulated trade, the system must create a **baseline knowledge state**.

That baseline must include:
- current strategy variant and version
- current regime model version
- current net-edge assumptions
- current cost assumptions
- current learning-state snapshot
- current trust/readiness defaults
- sentinel target thresholds

This baseline is the reference point from which Sentinel learns.

### Mandatory baseline artifact
Create and maintain:
- `artifacts/learning/sentinel/baseline-knowledge.latest.json`

Required contents:
- `createdAt`
- `strategyVariantId`
- `strategyVersion`
- `regimeModelVersion`
- `initialNetEdgeAssumptions`
- `initialCostAssumptions`
- `initialTrustScore`
- `targetSimulatedTrades`
- `targetLearnedTrades`
- `safeToGoLiveThresholds`

---

## Sentinel readiness thresholds

The default target window is:
- **20 simulated trades completed**
- **20 simulated trades learned from**

The system may only recommend live trading when all of the following are true:

1. `simulatedTradesCompleted >= 20`
2. `simulatedTradesLearned >= 20`
3. `readinessScore >= 0.75`
4. `simulatedNetEdgeAfterCostsBps > 0` over the sentinel window
5. `expectedVsRealizedEdgeGapBps <= 8` on average over the sentinel window
6. `simulatedFillQualityPassRate >= 0.80`
7. `unresolvedSentinelAnomalies = 0`
8. `noTradeDisciplinePassRate >= 0.80`
9. `learningCoverage = simulatedTradesLearned / simulatedTradesCompleted >= 0.95`

### Important rule
Crossing the threshold means:
- **display “Safe to consider live trading”**
- **display “Recommended to flip toggle to live trading”**

It does **not** mean:
- auto-enable live trading
- bypass startup gates
- bypass real readiness checks
- bypass existing deployment-tier rules

---

## Dashboard requirements

The dashboard must include a clear **mode switch** controlled by the user.

### Required switch behavior

Two visible options:
- `Sentinel Simulation`
- `Real Trading`

Rules:
- switching to Sentinel is always allowed
- switching to Real Trading must require explicit user action
- when Sentinel thresholds are not met, the UI must show a warning
- when Sentinel thresholds are met, the UI must show a recommendation
- the switch must persist through the API/backend control path, not only local UI state

### Required sentinel message block
The dashboard must show a persistent message similar to:

- `Mode: Sentinel Simulation`
- `Simulated trades taken: X / 20`
- `Trades learned from: Y / 20`
- `Current readiness score: Z`
- `Threshold to recommend live trading: 0.75`
- `Recommendation: Not ready / Ready to consider live trading`

### Required extra breakdown
Also show:
- net edge after simulated costs
- average realized-vs-expected edge gap
- fill-quality pass rate
- unresolved anomaly count
- no-trade discipline pass rate

---

## Canonical truth hierarchy for Sentinel

When Sentinel views disagree, trust in this order:

1. canonical simulated trade ledger
2. sentinel learning state
3. sentinel readiness summary
4. dashboard/API read models
5. UI local state

Sentinel must not derive readiness directly from transient UI state.

---

## Required architectural stance

Extend existing systems. Do not build a disconnected simulator.

### Extend, do not fork

#### Worker / runtime
- `apps/worker/src/jobs/evaluateTradeOpportunities.job.ts`
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/reconcileFills.job.ts`
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/runtime/bot-state.ts`
- `apps/worker/src/runtime/bot-runtime.ts`
- `apps/worker/src/runtime/runtime-control.repository.ts`
- `apps/worker/src/runtime/learning-state-store.ts`
- `apps/worker/src/runtime/decision-log.service.ts`
- `apps/worker/src/runtime/start-stop-manager.ts`

#### API / control
- `apps/api/src/modules/bot-control/bot-control.controller.ts`
- `apps/api/src/modules/bot-control/bot-control.service.ts`
- `apps/api/src/modules/bot-control/bot-control.repository.ts`
- `apps/api/src/modules/bot-control/dto/start-bot.dto.ts`
- `apps/api/src/modules/bot-control/dto/set-live-config.dto.ts`
- `apps/api/src/modules/ui/ui.service.ts`
- `apps/api/src/modules/ui/ui.controller.ts`
- `apps/api/src/modules/ui/dto/dashboard-response.dto.ts`

#### Web dashboard
- `apps/web/src/components/panels/ControlPanel.tsx`
- `apps/web/src/hooks/useBotState.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/components/panels/DiagnosticsPanel.tsx` *(only if the sentinel status is surfaced there too)*

#### Domain / UI contracts
- `packages/domain/src/bot-state.ts`
- `packages/domain/src/index.ts`
- `packages/ui-contracts/src/control.ts`
- `packages/ui-contracts/src/dashboard.ts`

---

## Sentinel-specific files that may be added

These are the preferred canonical insertion points for the sentinel build:

### Domain
- `packages/domain/src/sentinel.ts`

### Worker runtime
- `apps/worker/src/runtime/sentinel-state-store.ts`
- `apps/worker/src/runtime/sentinel-trade-simulator.ts`
- `apps/worker/src/runtime/sentinel-learning-service.ts`
- `apps/worker/src/runtime/sentinel-readiness-service.ts`

### API DTOs / read models
- `apps/api/src/modules/ui/dto/sentinel-status-response.dto.ts` *(if DTO separation is preferred)*

### Tests
- `apps/worker/src/tests/sentinel-simulation.integration.test.ts`
- `apps/worker/src/tests/sentinel-readiness.integration.test.ts`
- `apps/api/src/modules/bot-control/bot-control.sentinel.integration.test.ts`
- `apps/web/src/components/panels/ControlPanel.sentinel.test.tsx` *(if web tests exist in repo conventions)*

---

## Sentinel data model requirements

### Canonical mode enum
Add a domain enum/value union for:
- `sentinel_simulation`
- `live_trading`

### Canonical sentinel status
Must include at minimum:
- `mode`
- `targetSimulatedTrades`
- `simulatedTradesCompleted`
- `simulatedTradesLearned`
- `learningCoverage`
- `readinessScore`
- `readinessThreshold`
- `netEdgeAfterCostsBps`
- `expectedVsRealizedEdgeGapBps`
- `fillQualityPassRate`
- `noTradeDisciplinePassRate`
- `unresolvedAnomalyCount`
- `recommendedLiveEnable`
- `recommendationMessage`
- `lastLearningAt`
- `baselineKnowledgeVersion`

### Canonical simulated trade record
Must include at minimum:
- `simulationTradeId`
- `decisionId`
- `strategyVariantId`
- `marketId`
- `tokenId`
- `regime`
- `side`
- `intendedPrice`
- `simulatedFillPrice`
- `simulatedFee`
- `simulatedSlippageBps`
- `expectedNetEdgeBps`
- `realizedNetEdgeBps`
- `fillProbabilityUsed`
- `orderbookSnapshotRef`
- `createdAt`
- `finalizedAt`
- `learned`
- `learningOutcomeRef`

---

## Hard guardrails for Sentinel implementation

1. Sentinel execution must never call the real exchange submit path.
2. Live trading mode must never read Sentinel recommendation from the UI as truth; it must come from backend state.
3. Sentinel readiness must be computed backend-side.
4. Sentinel trades must be persisted independently from live trades.
5. Sentinel learning must be append-safe and auditable.
6. Reusing the live planning path is mandatory; duplicating signal/edge logic for simulation is forbidden.
7. The dashboard switch must go through the API control path and be persisted.
8. The dashboard message must reflect backend truth, not client-only counters.

---

## Required artifacts

The sentinel build must write these artifacts:

- `artifacts/learning/sentinel/baseline-knowledge.latest.json`
- `artifacts/learning/sentinel/simulated-trades.jsonl`
- `artifacts/learning/sentinel/learning-updates.jsonl`
- `artifacts/learning/sentinel/readiness.latest.json`

Optional but allowed:
- `artifacts/learning/sentinel/daily-summary/YYYY-MM-DD.json`

---

## Acceptance standard

This Sentinel feature is only complete when all of the following are true:

1. the user can switch between Sentinel Simulation and Real Trading from the dashboard
2. Sentinel mode runs the real decision path but simulates execution
3. the system can complete and learn from at least 20 simulated trades
4. the backend computes readiness and recommendation status
5. the dashboard displays counts, thresholds, and recommendation text
6. the recommendation is based on persisted backend artifacts
7. live mode remains explicitly user-controlled
8. simulation and live execution paths are impossible to confuse in code and in UI

---

## Delivery stance

This work should be implemented in this order:

1. domain + contracts for sentinel mode and status
2. durable sentinel stores and baseline state
3. simulated execution adapter in worker
4. learning/readiness computation after each simulated trade
5. API exposure of sentinel mode/status
6. dashboard switch and progress message
7. tests and hard failure cases

No step may skip directly to “UI only” without backend truth and persistence.
