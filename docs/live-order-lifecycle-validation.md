# Live Order Lifecycle Validation

## Purpose

This suite proves that the live Polymarket order path behaves safely under failure, delay, restart, and reconciliation.

The implementation lives in `apps/worker/src/validation/live-order-lifecycle-validation.ts`.

## What it proves

The suite runs the real worker execution and recovery jobs together:

- `ExecuteOrdersJob`
- `ManageOpenOrdersJob`
- `ReconcileFillsJob`
- `CrashRecoveryService`
- `ReplayEngine`
- `UserWebSocketStateService`

The validated scenarios are:

- submit timeout followed by uncertain venue state
- partial fill followed by reconnect
- cancel acknowledged late
- ghost open order after restart
- duplicate or delayed fill events
- order visibility mismatch between REST and stream
- stale local assumptions after process crash

For each scenario the suite records:

- what the bot believed locally
- what REST truth reported
- what user-stream events were observed
- which reconciliation path corrected or confirmed state
- whether duplicate exposure was prevented
- whether runtime safety stayed fail-closed

## Evidence

Scenario evidence is written to `artifacts/live-order-lifecycle-validation/latest.json`.

Each scenario persists:

- intent ID
- submit attempts
- bot-belief snapshots
- REST and venue truth snapshots
- stream events
- reconciliation results
- final replay truth

The replay engine also surfaces lifecycle evidence from persisted audit events so a reviewer can trace the final state back to the scenario-level proof.

The readiness suite and replay engine now consume the same persisted lifecycle artifact instead of maintaining separate truth sources. That keeps operator readiness, post-incident replay, and lifecycle proof aligned on one durable evidence file.

## Soak validation

Lifecycle validation also has a soak mode so timing drift and race-sensitive behavior are exercised repeatedly instead of only in a single clean pass.

The soak output records:

- iteration count
- per-iteration duration
- failed scenarios by iteration
- average and max scenario-suite duration

Run the soak suite with:

- `corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:lifecycle:soak`

## Commands

Run the suite with:

- `corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:lifecycle`

The suite must fail if any scenario leaves unresolved duplicate exposure, assumes a terminal cancel too early, or recovers from a crash before venue truth is authoritative again.
