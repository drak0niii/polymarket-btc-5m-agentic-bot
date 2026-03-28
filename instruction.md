# instructions.md

## Objective

Build a **Sentinel Simulation version** of the BTC 5-minute Polymarket system that:

1. simulates trades instead of placing real orders
2. defines and persists a baseline knowledge state before simulation begins
3. simulates **at least 20 trades**
4. learns from those 20 simulated trades using explicit, durable artifacts
5. computes a backend-side readiness score and recommendation state
6. exposes a **dashboard switch** so the user can choose between Sentinel Simulation and Real Trading
7. shows the user a clear progress and recommendation message:
   - how many trades were taken
   - how many were learned from
   - what threshold must be reached
   - whether the system recommends going live

This implementation must be **strict**:
- simulation must not place real orders
- readiness must be computed from persisted backend state
- the dashboard switch must be wired through the API/backend
- recommendation to go live must remain advisory, not automatic

---

## Implementation summary

The build must add a **Sentinel mode** to the existing system rather than creating a parallel bot.

Use the existing pipeline:
- market discovery
- market/orderbook sync
- signal build
- trade evaluation
- admission and sizing

Then replace only the execution target:
- in sentinel mode: simulated execution
- in live mode: real execution

---

## Phase A — canonical mode and sentinel status

### Goal
Create a shared language for mode switching and readiness reporting.

### Files to add
- `packages/domain/src/sentinel.ts`

### Files to modify
- `packages/domain/src/bot-state.ts`
- `packages/domain/src/index.ts`
- `packages/ui-contracts/src/control.ts`
- `packages/ui-contracts/src/dashboard.ts`

### Required changes

#### 1) Add `packages/domain/src/sentinel.ts`
Define canonical types:
- `TradingOperatingMode = 'sentinel_simulation' | 'live_trading'`
- `SentinelBaselineKnowledge`
- `SentinelSimulatedTradeRecord`
- `SentinelLearningUpdate`
- `SentinelReadinessStatus`
- `SentinelRecommendationState = 'not_ready' | 'ready_to_consider_live'`

#### 2) Update `packages/domain/src/bot-state.ts`
Add operating mode fields to the canonical bot state:
- `operatingMode`
- `sentinelEnabled`
- `recommendedLiveEnable`

#### 3) Update `packages/ui-contracts/src/control.ts`
Add request/response shapes for:
- setting operating mode
- reading current sentinel mode
- reading sentinel toggle eligibility/warning text

#### 4) Update `packages/ui-contracts/src/dashboard.ts`
Add dashboard contract fields for sentinel status:
- `operatingMode`
- `sentinelStatus`
- `recommendationMessage`
- `simulatedTradesCompleted`
- `simulatedTradesLearned`
- `targetSimulatedTrades`
- `readinessScore`
- `readinessThreshold`

### Acceptance
- shared mode and sentinel status types exist
- API and web can consume one canonical sentinel status model

---

## Phase B — baseline knowledge and durable sentinel stores

### Goal
Persist the baseline state and all simulated/learned outcomes.

### Files to add
- `apps/worker/src/runtime/sentinel-state-store.ts`

### Files to modify
- `apps/worker/src/runtime/learning-state-store.ts`
- `apps/worker/src/runtime/bot-state.ts`

### Required changes

#### 1) Add `apps/worker/src/runtime/sentinel-state-store.ts`
Responsibilities:
- initialize baseline knowledge
- append simulated trades
- append learning updates
- persist latest readiness state
- expose read methods for dashboard/API use

Required methods:
- `ensureBaselineKnowledge()`
- `appendSimulatedTrade(record)`
- `appendLearningUpdate(update)`
- `writeReadiness(status)`
- `readLatestReadiness()`
- `loadRecentSimulatedTrades(limit)`
- `countCompletedTrades()`
- `countLearnedTrades()`

### Required artifact paths
- `artifacts/learning/sentinel/baseline-knowledge.latest.json`
- `artifacts/learning/sentinel/simulated-trades.jsonl`
- `artifacts/learning/sentinel/learning-updates.jsonl`
- `artifacts/learning/sentinel/readiness.latest.json`

#### 2) Update `apps/worker/src/runtime/learning-state-store.ts`
Add a pointer block only, not full sentinel history:
- `sentinelBaselinePath`
- `sentinelTradesPath`
- `sentinelLearningUpdatesPath`
- `sentinelReadinessPath`

#### 3) Update `apps/worker/src/runtime/bot-state.ts`
Persist the current operating mode so sentinel/live survives restart.

### Acceptance
- baseline knowledge is written before the first sentinel trade
- sentinel trades and learning updates persist durably
- latest readiness can be read without scanning the whole ledger

---

## Phase C — simulated execution path

### Goal
Run the existing trade approval path but simulate the fill and outcome.

### Files to add
- `apps/worker/src/runtime/sentinel-trade-simulator.ts`

### Files to modify
- `apps/worker/src/jobs/executeOrders.job.ts`
- `apps/worker/src/jobs/reconcileFills.job.ts`
- `apps/worker/src/runtime/bot-runtime.ts`

### Required changes

#### 1) Add `apps/worker/src/runtime/sentinel-trade-simulator.ts`
Responsibilities:
- consume approved trade intents
- simulate fill probability using current orderbook + existing calibration surfaces
- simulate fill price and slippage
- simulate fees and queue delay
- finalize a simulated trade outcome

Required behavior:
- use existing order planner outputs where possible
- use existing fee/slippage assumptions where possible
- produce a `SentinelSimulatedTradeRecord`
- never call real submit/cancel endpoints

#### 2) Update `apps/worker/src/jobs/executeOrders.job.ts`
Add a hard split:
- if `operatingMode === 'sentinel_simulation'`: route to `SentinelTradeSimulator`
- if `operatingMode === 'live_trading'`: use existing live execution path

Rules:
- the sentinel branch must never fall through to live submit
- log an explicit audit event such as `sentinel.trade_simulated`

#### 3) Update `apps/worker/src/jobs/reconcileFills.job.ts`
Handle sentinel outcomes distinctly from live fills.

Rules:
- sentinel simulated trades may write to sentinel artifacts
- sentinel trades must not pollute live order truth
- if the repo already writes canonical resolved-trade evidence, sentinel may optionally write a mode-tagged record only if clearly separated from live execution truth

#### 4) Update `apps/worker/src/runtime/bot-runtime.ts`
Ensure mode is available to jobs and runtime wiring.

### Acceptance
- sentinel mode completes simulated trades without calling real exchange submission
- live mode remains unchanged
- both branches are explicit in code

---

## Phase D — learning from simulated trades

### Goal
After each simulated trade, update learning state and readiness state.

### Files to add
- `apps/worker/src/runtime/sentinel-learning-service.ts`
- `apps/worker/src/runtime/sentinel-readiness-service.ts`

### Files to modify
- `apps/worker/src/jobs/dailyReview.job.ts`
- `apps/worker/src/runtime/decision-log.service.ts`

### Required changes

#### 1) Add `apps/worker/src/runtime/sentinel-learning-service.ts`
Responsibilities:
- consume new simulated trade records
- mark whether the trade has been learned from
- update bounded learning fields only

Allowed updates:
- trust/readiness state
- calibrated execution expectation summaries
- regime confidence support metrics
- no-trade discipline summaries
- strategy confidence/readiness metrics

Not allowed:
- rewrite strategy families
- rewrite safety policy
- bypass risk rules

Required learning update fields:
- `learningUpdateId`
- `simulationTradeId`
- `learnedAt`
- `parameterChanges[]`
- `evidenceRefs[]`
- `reason`
- `rollbackCriteria[]`

#### 2) Add `apps/worker/src/runtime/sentinel-readiness-service.ts`
Responsibilities:
- compute readiness after every new learned trade
- write `readiness.latest.json`
- generate recommendation text

Readiness formula must combine at minimum:
- trade count progress
- learning coverage
- net edge after costs
- expected-vs-realized edge gap
- fill-quality pass rate
- no-trade discipline pass rate
- anomaly count

Default thresholds:
- `targetSimulatedTrades = 20`
- `targetLearnedTrades = 20`
- `readinessThreshold = 0.75`
- `expectedVsRealizedEdgeGapBps <= 8`
- `fillQualityPassRate >= 0.80`
- `noTradeDisciplinePassRate >= 0.80`
- `unresolvedAnomalyCount = 0`

#### 3) Update `apps/worker/src/jobs/dailyReview.job.ts`
Include sentinel review outputs:
- daily simulated trade count
- daily learned trade count
- sentinel readiness summary
- recommendation state

#### 4) Update `apps/worker/src/runtime/decision-log.service.ts`
Log sentinel-specific decision evidence and recommendation transitions.

### Acceptance
- every simulated trade can become a learned trade
- readiness updates after learning
- recommendation text is persisted backend-side

---

## Phase E — API control and dashboard read model

### Goal
Expose sentinel mode and readiness through API.

### Files to add
- `apps/api/src/modules/ui/dto/sentinel-status-response.dto.ts` *(optional if you prefer a separate DTO)*

### Files to modify
- `apps/api/src/modules/bot-control/dto/start-bot.dto.ts`
- `apps/api/src/modules/bot-control/dto/set-live-config.dto.ts`
- `apps/api/src/modules/bot-control/bot-control.controller.ts`
- `apps/api/src/modules/bot-control/bot-control.service.ts`
- `apps/api/src/modules/bot-control/bot-control.repository.ts`
- `apps/api/src/modules/ui/dto/dashboard-response.dto.ts`
- `apps/api/src/modules/ui/ui.service.ts`
- `apps/api/src/modules/ui/ui.controller.ts`

### Required changes

#### 1) Bot control DTO/controller/service
Allow the backend to:
- set `operatingMode`
- read `operatingMode`
- persist switch choice

Add an endpoint such as:
- `POST /bot-control/mode`
- `GET /bot-control/mode`

#### 2) UI service/controller/dashboard DTO
Add sentinel status to the dashboard response.

Required dashboard payload fields:
- `operatingMode`
- `sentinelStatus`
- `recommendationMessage`
- `simulatedTradesCompleted`
- `simulatedTradesLearned`
- `targetSimulatedTrades`
- `readinessScore`
- `readinessThreshold`
- `recommendedLiveEnable`

### Acceptance
- dashboard data can be fetched from backend truth
- mode switch persists server-side
- recommendation text comes from backend readiness state

---

## Phase F — dashboard switch and user message

### Goal
Let the user flip the mode from the dashboard and see progress clearly.

### Files to modify
- `apps/web/src/components/panels/ControlPanel.tsx`
- `apps/web/src/hooks/useBotState.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/components/panels/DiagnosticsPanel.tsx` *(optional if sentinel details also belong there)*

### Required changes

#### 1) Update `apps/web/src/lib/api.ts`
Add client methods for:
- reading current bot mode
- setting bot mode
- reading dashboard sentinel status

#### 2) Update `apps/web/src/hooks/useBotState.ts`
Expose:
- `operatingMode`
- `setOperatingMode(...)`
- `sentinelStatus`
- mode-switch loading/error state

#### 3) Update `apps/web/src/components/panels/ControlPanel.tsx`
Add a visible switch or segmented control with exactly two options:
- `Sentinel Simulation`
- `Real Trading`

Add a persistent sentinel status card/message showing:
- `Simulated trades taken: X / 20`
- `Trades learned from: Y / 20`
- `Readiness score: Z / 0.75`
- `Recommended: Yes / No`
- `Message: ...`

When not ready, display a warning style.
When ready, display a recommendation style.

### Required message behavior

If not ready:
`Sentinel is still learning. Simulated trades: X/20. Learned trades: Y/20. Readiness score: Z/0.75. Do not enable live trading yet.`

If ready:
`Sentinel thresholds are satisfied. Simulated trades: X/20. Learned trades: Y/20. Readiness score: Z/0.75. It is safe to consider enabling live trading.`

### Acceptance
- user can flip the mode from dashboard
- UI updates from backend truth
- the user always sees counts, threshold, and recommendation

---

## Phase G — strict tests

### Goal
Prove sentinel mode is safe, separate, and informative.

### Files to add
- `apps/worker/src/tests/sentinel-simulation.integration.test.ts`
- `apps/worker/src/tests/sentinel-readiness.integration.test.ts`
- `apps/api/src/modules/bot-control/bot-control.sentinel.integration.test.ts`

### Required test cases

#### Worker tests
1. sentinel mode simulates a trade without live submit
2. sentinel writes baseline knowledge before first trade
3. after 20 simulated trades and 20 learned trades with passing metrics, readiness recommends live
4. if edge gap is too large or anomaly count is non-zero, readiness does not recommend live
5. simulated trade counters and learned counters remain accurate

#### API tests
6. mode switch persists through bot-control endpoints
7. dashboard response contains sentinel status and recommendation fields

#### UI tests if repo conventions allow
8. ControlPanel renders current mode and progress message
9. toggle action calls backend mode endpoint

### Acceptance
- simulation/live separation is proven by tests
- recommendation threshold logic is proven by tests
- dashboard/API mode switch is proven by tests

---

## Final acceptance criteria

This work is complete only when all are true:

1. Sentinel Simulation and Real Trading are explicit backend-controlled modes.
2. Sentinel mode reuses the decision pipeline but does not place real orders.
3. A baseline knowledge file is created and persisted.
4. The system can simulate and learn from 20 trades.
5. Readiness and recommendation are computed backend-side from persisted state.
6. The dashboard shows counts, threshold, readiness score, and recommendation text.
7. The user can switch modes from the dashboard.
8. The recommendation to go live is advisory only.
9. Tests prove that sentinel mode cannot accidentally execute live orders.

---

## Strict scope boundary

Do not add in this implementation:
- automatic flipping from sentinel to live
- dynamic threshold tuning before the first version works
- new strategy families
- broad autonomous strategy rewriting
- live capital scaling changes unrelated to sentinel mode

The target is a **strict first Sentinel build** that safely learns from 20 simulated trades and tells the user when it is reasonable to consider turning on live trading.
