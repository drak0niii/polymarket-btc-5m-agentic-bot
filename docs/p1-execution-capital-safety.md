# P1 Execution And Capital Safety

## Purpose

This document describes the P1 control plane that governs capital allocation, execution safety, restart safety, and venue-operational handling for the live worker.

Validation commands:

- `corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:p1`
- `scripts/run-p1-validations.sh`

## Canonical account state

`apps/worker/src/portfolio/account-state.service.ts` builds the single authoritative `CanonicalAccountState` from:

- the latest external authenticated portfolio snapshot
- local working orders and reservations
- recent fills and realized fee records
- stream-health and divergence flags

Every new-risk decision uses this snapshot instead of recomputing deployable capital ad hoc inside individual jobs.

## Portfolio kill switches and attribution

`packages/risk-engine/src/portfolio-kill-switch-service.ts` evaluates portfolio drawdown, concentration, execution-quality drift, venue instability, and data freshness. The verdict feeds order admission and the graded safety state machine.

`packages/risk-engine/src/trade-attribution-service.ts` keeps signal quality separate from execution quality so losses can be classified as bad forecast, bad execution, stale data, fee drag, inventory management, or market selection.

## Idempotent order-intent lifecycle

`packages/execution-engine/src/order-intent-service.ts` derives deterministic intent IDs and client order IDs from stable intent inputs plus an explicit replacement epoch.

`apps/worker/src/runtime/order-intent.repository.ts` persists submit lifecycle state in reconciliation checkpoints:

- `prepared`
- `submitted`
- `unknown_visibility`
- `terminal`
- `blocked`

`apps/worker/src/jobs/executeOrders.job.ts` records intents before submit, reuses the same identity on retry, blocks replay when prior truth is still pending, and only opens a new intent epoch after a deliberate replacement cycle.

## Scoped venue throttling

`packages/polymarket-adapter/src/polymarket-venue-awareness.ts` now delegates throttling to `ScopedThrottleBudget` with isolated budgets for:

- `public`
- `private`
- `submit`
- `cancel`
- `heartbeat`
- `websocket_reconnect`

This prevents noisy public traffic from starving authenticated submit, cancel, or heartbeat flows.

## Fill, residual, and ghost-exposure handling

`packages/execution-engine/src/fill-state-service.ts` is the canonical model for:

- partial-fill accumulation
- remaining-size tracking
- residual keep/replace/cancel decisions
- ghost-exposure detection

`apps/worker/src/jobs/reconcileFills.job.ts` updates order fill state incrementally through this service, and `apps/worker/src/jobs/manageOpenOrders.job.ts` uses explicit residual decisions instead of cancel/replace churn by default.

Crash recovery treats unresolved intents and local/venue/user-stream mismatches as ghost exposure and fails closed until truth is known.

## Liquidation policy

`packages/risk-engine/src/inventory-liquidation-policy.ts` centralizes soft-reduce and hard-flatten decisions for:

- near-expiry exposure
- stale BTC reference truth
- user-stream loss
- market closed-only / ineligible states
- external portfolio divergence

`apps/worker/src/runtime/live-loop.ts` evaluates this policy continuously, updates runtime state deterministically, and forces reconciliation or cancel-all behavior when required.

## Market eligibility

`packages/signal-engine/src/market-eligibility-service.ts` is the single eligibility gate used by:

- discovery
- signal generation
- trade evaluation
- execution admission
- open-order review

Markets fail closed when orderbook support, depth, spread, tick size, metadata consistency, or time-to-resolution no longer match the BTC 5-minute strategy.

## Fee and reward accounting

`packages/execution-engine/src/fee-accounting-service.ts` separates:

- gross PnL
- net alpha PnL after fees
- optional total economics including rewards

Fees affect default profitability and account-state marking. Rewards remain explicitly separate and are excluded from default alpha admission unless a caller opts in.

## Operational reject handling

`packages/risk-engine/src/venue-operational-policy-service.ts` classifies venue-side rejects and maps them to deterministic runtime transitions:

- geoblock -> `halted_hard`
- auth invalidation -> `reconciliation_only`
- closed-only -> `cancel_only`
- clock skew -> `reconciliation_only`
- validation-reject bursts -> `degraded` or `cancel_only`

These are not treated as ordinary retry noise. The worker records the evidence and updates runtime status immediately.
