# P2/P3 Research-to-Production Framework

This document defines the canonical P2/P3 operating contract for the Polymarket BTC 5-minute autonomous trading system.

## Canonical edge definition

The canonical edge contract lives in `packages/domain/src/edge.ts` and `packages/signal-engine/src/edge-definition-service.ts`.

The bot predicts one thing:

- expected net executable EV for a fee-aware Polymarket entry that can still be exited inside the configured hold window

The contract is versioned as `btc-5m-polymarket-edge-v1` and explicitly defines:

- predictive target
- forecast horizon
- executable benchmark
- admission thresholds

The executable benchmark is hybrid, Polymarket-aware, and never assumes passive fills are free alpha. Fees, slippage, timeout/cancel risk, stale-signal risk, and inventory constraints are all part of admissibility.

## Research governance and promotion

Rolling walk-forward validation is implemented in `packages/signal-engine/src/walk-forward-validator.ts`.

Governance policy is implemented in `packages/signal-engine/src/research-governance-policy.ts`.

Promotion scoring and robustness gates are implemented in:

- `packages/signal-engine/src/robustness-suite.ts`
- `packages/signal-engine/src/multi-objective-promotion-score.ts`

Every governed record now includes:

- walk-forward window spec
- segmentation across regime, event type, liquidity, time-of-day, and market structure
- calibration buckets
- cost-model and calibration versions
- promotion eligibility

Live entry admission must fail closed when governed validation or robustness evidence is missing for live tiers.

## Empirical validation evidence

The default P2/P3 validation path is now empirical and lives in:

- `apps/worker/src/validation/p23-validation.ts`
- `apps/worker/src/validation/datasets/p23-empirical-validation.dataset.json`

What counts as empirical validation:

- real historical Polymarket BTC 5-minute markets loaded from Gamma slug snapshots
- real quote-history points loaded from CLOB `prices-history`
- real BTC 5-minute candles used for walk-forward features
- real venue replay book frames used for executable stress on slippage, latency, and timeout risk

What does not count as proof:

- synthetic samples by themselves
- framework smoke fixtures without historical observations
- REST-only point checks without executable frictions

Synthetic samples are still available only as an explicit smoke mode for wiring checks. They are not accepted as governed robustness evidence and the default validator fails closed if the empirical dataset is missing, stale, or mislabeled.

Historical walk-forward validation now works like this:

- load the checked-in empirical dataset and reject it if stale
- rebuild strategy-side probabilities from historical BTC candles plus venue quote context
- score executable edge with explicit spread, slippage, fees, latency, and timeout/cancel penalties
- run walk-forward windows on those empirical samples
- audit calibration against realized outcomes for the chosen side
- store the full result in `artifacts/p23-validation/latest.json`

The persisted artifact is the audit record for reviewers. It includes dataset provenance, the walk-forward result, regime holdouts, executable-edge stress scenarios, calibration audit output, and the exact evidence path that was written during the run.

## Dataset quality verification

Dataset-quality verification now runs as a first-class gate before empirical validation can be treated as evidence.

The canonical verifier lives in:

- `apps/worker/src/validation/dataset-quality.ts`
- `apps/worker/src/validation/dataset-quality.command.ts`

For every dataset it computes and persists:

- provenance and collection method
- capture window and covered hours
- observation, replay-frame, and market counts
- missingness and duplicate rates
- stale-feature rate
- regime, time-of-day, source-kind, liquidity, and market-structure coverage
- bias-risk flags
- explicit verdict: `accepted`, `accepted_with_warnings`, or `rejected_for_validation`

`validate:p23` now fails closed unless dataset quality is `accepted`. The current checked-in empirical dataset is intentionally rejected for promotion because replay-frame depth, regime coverage, and liquidity coverage are still too thin.

## Executable admission

Canonical executable admission is enforced through `packages/signal-engine/src/trade-admission-gate.ts`.

Admission uses an explicit executable-edge breakdown:

- raw model edge
- spread-adjusted edge
- slippage-adjusted edge
- fee-adjusted edge
- timeout/cancel-adjusted edge
- stale-signal-adjusted edge
- inventory-adjusted edge
- final admissible net edge

Missing or stale friction inputs block admission.

Paper edge is never sufficient.

## Microstructure, strategy families, no-trade zones, and half-life

Event-contract microstructure is modeled in:

- `packages/signal-engine/src/event-microstructure-model.ts`
- `packages/signal-engine/src/strategy-family-policy.ts`
- `packages/signal-engine/src/no-trade-zone-policy.ts`
- `packages/signal-engine/src/edge-half-life-policy.ts`

The system now treats the market as a venue-specific binary event contract rather than raw BTC direction.

Named strategy families:

- momentum continuation
- mean reversion after overshoot
- volatility expansion
- expiry-window behavior
- spread/liquidity opportunism

No-trade zones are explicit and enforced for:

- near expiry
- stale reference or stale orderbook truth
- spread blowout
- thin depth
- microstructure chaos
- failed governance
- expired edge half-life

## Setup-aware attribution

Post-trade attribution now includes setup context via `packages/risk-engine/src/trade-attribution-service.ts`.

Attribution distinguishes:

- bad forecast
- bad execution
- bad setup fit
- bad market selection
- stale data
- fee drag
- inventory management

Setup-aware fields include strategy family, edge-definition version, admissible net edge, half-life status, and no-trade-zone tags.

## Audit, replay, readiness, and chaos

Structured decision logs are written through `apps/worker/src/runtime/decision-log.service.ts`.

Replay is implemented in `apps/worker/src/runtime/replay-engine.ts`.

Chaos testing is implemented in:

- `apps/worker/src/runtime/chaos-harness.ts`
- `apps/worker/src/runtime/chaos-command.ts`

Single-dashboard readiness is computed by:

- `packages/risk-engine/src/production-readiness-dashboard.ts`
- `apps/worker/src/runtime/readiness-dashboard.command.ts`
- `apps/api/src/modules/ui/ui.service.ts`

Independent observer verification is implemented in:

- `apps/worker/src/runtime/readiness-observer.ts`

The readiness observer cross-checks internal service claims against externally observed freshness and reconciliation truth for:

- market stream freshness
- user stream freshness
- auth smoke validity
- heartbeat continuity
- external truth freshness
- open-order divergence
- lifecycle evidence freshness

Material internal-vs-observer divergence is blocking and is persisted through the production readiness checkpoints.

The readiness dashboard covers:

- startup gate
- live truth / stream freshness
- research governance
- robustness evidence
- auditability
- replayability
- chaos validation
- deployment tier permissions
- capital ramp eligibility

## Deployment tiers and capital ramp

Deployment-tier policy is implemented in `packages/risk-engine/src/deployment-tier-policy-service.ts`.

Capital-ramp policy is implemented in `packages/risk-engine/src/capital-ramp-policy-service.ts`.

Capital-exposure validation is implemented in:

- `apps/worker/src/runtime/capital-exposure-validation.ts`
- `apps/worker/src/runtime/capital-exposure.command.ts`

Supported tiers:

- `research`
- `paper`
- `canary`
- `cautious_live`
- `scaled_live`

Live tiers do not share identical permissions or size limits.

Scaling is blocked without:

- robustness evidence
- chaos evidence
- auditability
- post-trade attribution coverage
- positive promotion score
- capital exposure validation evidence

Capital validation now tracks explicit staged modes:

- `shadow`
- `micro_cap_live`
- `limited_cap_live`

The persisted capital report includes:

- expected EV at entry
- realized EV
- execution drift
- realized fees and slippage
- lifecycle anomaly rate
- regime-level performance
- drawdown
- capital efficiency

Higher-capital rollout is blocked unless the requested mode is explicitly validated for the active deployment tier.

## Adversarial chaos evidence

The chaos harness now persists durable evidence to `artifacts/chaos-harness/latest.json` in addition to optional database records.

It covers adversarial scenarios for:

- network jitter and burst latency
- delayed ACK and delayed visibility
- dropped stream messages
- reconnect storms
- out-of-order event arrival
- partial persistence failure
- clock skew injection
- REST-vs-stream truth races
- delayed cancel visibility
- duplicate fill visibility with timing offset

The harness records expected runtime transitions, readiness outcomes, reconciliation behavior, lifecycle safety assertions, capital actions, and soak summaries instead of only reporting a single pass/fail bit.

## Commands

Primary P2/P3 operator commands:

- `corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:p23`
- `corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:dataset-quality`
- `corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:capital-exposure`
- `corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker chaos:p23`
- `corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker chaos:p23:soak`
- `corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker readiness:dashboard`
- `corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker replay:signal <signalId>`
- `scripts/run-p23-validations.sh`
