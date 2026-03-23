# Architecture

## Purpose

`polymarket-btc-5m-agentic-bot` is a live-only, fully automated BTC 5-minute Polymarket trading system.

The P1 execution and capital-safety control plane is documented in `docs/p1-execution-capital-safety.md`.

It is designed to:

- discover active BTC-linked 5-minute markets
- estimate probabilistic edge
- reject weak or costly opportunities
- size trades conservatively
- place and manage live orders
- expose all live state through a web dashboard
- use AI only for supervision and review, not direct live trade control

## Architectural principles

1. **Deterministic code trades**
2. **Risk can veto any trade**
3. **Execution is observable and auditable**
4. **AI supervises but does not directly own the live buy/sell loop**
5. **The system runs only in live mode**
6. **Start / Stop is an explicit runtime state**

## System overview

The repository is split into:

- `apps/api` — control plane and read APIs
- `apps/worker` — live runtime
- `apps/web` — operator dashboard
- `packages/*` — domain, trading, risk, execution, diagnostics, and agent packages

## Package boundary discipline

Runtime code must consume sibling packages through canonical package entrypoints, not `../../../../packages/*/src/*` deep imports.

The public API surface is now enforced by package `index.ts` entrypoints plus the repository validation command:

- `corepack pnpm validate:no-deep-imports`

This keeps the build graph stable and ensures apps depend on package contracts rather than private source-tree paths.

## Data flow

### 1. Market discovery
The worker discovers active BTC-linked markets through the Polymarket adapter.

### 2. Market state sync
The worker synchronizes:

- BTC reference price
- recent BTC candles
- Polymarket orderbooks
- live market snapshots

### 3. Signal generation
The signal engine computes:

- prior probability
- posterior probability
- edge
- net EV after fees, slippage, and impact assumptions

### 4. Risk gating
The risk engine decides whether a signal is eligible to become an order.

This includes:

- position limits
- bankroll constraints
- daily loss rules
- consecutive-loss protection
- execution-drift protection
- no-trade near expiry rules

### 5. Execution
If risk approves, the execution engine:

- resolves one canonical trade intent for the market and token
- plans the order
- hands the explicit venue order to the official Polymarket trading client
- manages order lifecycle
- tracks fills and positions

### 6. Reconciliation
The worker continuously reconciles:

- open orders
- fills
- positions
- portfolio state

### 7. Diagnostics
The system computes diagnostics for:

- expected EV vs realized EV
- fill quality
- stale-order frequency
- slippage
- regime behavior
- stress-test outcomes

### 8. UI exposure
The API app exposes:

- current bot state
- market state
- signal state
- order and portfolio state
- diagnostics
- activity and audit trail

The web app consumes these endpoints and renders a live operator dashboard.

## Applications

## `apps/api`

The API application is the control plane.

Responsibilities:

- expose health endpoints
- expose Start / Stop control endpoints
- expose live config management
- serve markets, signals, orders, portfolio, diagnostics, and audit data
- provide dashboard aggregation payloads for the web app

The API should never contain the hot live trading loop.

## `apps/worker`

The worker application is the live execution runtime.

Responsibilities:

- run the live loop
- sync data sources
- build signals
- apply risk checks
- place live orders
- manage stale orders and exits
- reconcile positions and portfolio
- compute diagnostics and daily review jobs

The worker is the only process that should own live trade execution.

## `apps/web`

The web app is the operator dashboard.

Responsibilities:

- show Start / Stop state
- display current market and signal state
- display edge / EV / risk state
- display open orders and portfolio state
- display activity and diagnostics
- present agent commentary and summaries

## Package responsibilities

## `packages/domain`

Contains shared domain models and types:

- market, candle, and orderbook shapes
- signals, EV, and edge
- orders, fills, positions, portfolio
- bot state and strategy config
- diagnostics and stress-test results

This package should remain framework-agnostic.

## `packages/polymarket-adapter`

Encapsulates all Polymarket-specific interactions:

- market discovery
- Gamma access and official Polymarket trading client
- auth bootstrapping
- credential management
- live order submission, cancellation, and venue queries
- canonical fail-closed Gamma, CLOB, rewards, balance, and data-API parsing in `packages/polymarket-adapter/src/parsers/venue-parsers.ts`
- canonical venue-awareness for startup readiness, server-time/clock-skew handling, normalized venue errors, and scope-aware rate governance

No application should talk directly to Polymarket outside this package.

## `packages/market-data`

Provides normalized BTC market inputs:

- reference price
- candles
- volatility
- feed latency
- timestamp alignment
- shared Polymarket WebSocket connection lifecycle for market and user channels

## Live stream truth

The worker now uses two real Polymarket WebSocket channels instead of local in-memory placeholders:

- the market channel subscribes by `asset_id`
- the authenticated user channel subscribes by `conditionId`

Both channels share one connection client that owns:

- immediate subscription after socket open
- client-side `PING` heartbeats and inbound `PONG` traffic monitoring
- bounded reconnect with exponential backoff and jitter
- stale-traffic detection
- outbound subscribe / unsubscribe queueing across reconnects

The service-specific state layers own the domain mapping:

- `MarketWebSocketStateService` fetches REST orderbook truth first, opens the market stream, waits for `book` initial dumps for every tracked token, reconciles the stream snapshots against the REST baseline, and only then marks the market stream trusted
- `UserWebSocketStateService` fetches REST open-order and trade truth first, opens the authenticated user stream, buffers post-open user events, refetches REST truth, replays buffered events with ordering protection, and only then marks the user stream trusted

If either stream disconnects, stops receiving traffic, or fails reconciliation:

- market stream trust is revoked and runtime degrades
- user stream trust is revoked and runtime moves to reconciliation-only
- the worker does not keep trading on stale or unauditable stream state

## Production readiness proof

The production readiness suite is not allowed to treat `start()` as proof.

It must prove all of the following with the real stream services:

- the market channel sent a real Polymarket subscribe request and received actual incoming market events
- the authenticated user channel sent a real authenticated subscribe request and received actual incoming order or trade events
- stream freshness is measured from the timestamp of the last actual incoming event or heartbeat traffic observed by the socket client
- reconnect recovery is validated by forcing a disconnect on the live code path, waiting for bounded backoff plus re-bootstrap, and confirming trusted stream state returns
- user-stream reconciliation is checked against REST truth after stream traffic has been observed, not before

REST-only proof is insufficient because REST can show a snapshot while the live stream is disconnected, stale, or missing order lifecycle events.

## Live lifecycle validation proof

`apps/worker/src/validation/live-order-lifecycle-validation.ts` runs the end-to-end order lifecycle suite against the real worker jobs, reconciliation flow, crash recovery path, and replay engine.

The suite proves all of the following with shared production code paths:

- submit timeout with uncertain venue visibility blocks blind replay
- partial fill plus reconnect preserves fill truth without duplicate exposure
- late cancel acknowledgement keeps the order in `cancel_requested` until venue truth confirms terminal state
- restart ghost orders fail closed until user-stream or REST truth reconciles them
- duplicate or delayed fills stay idempotent
- REST and stream visibility mismatches degrade trust until reconciliation clears divergence
- process-crash recovery reloads intent state, re-fetches venue truth, clears stale local assumptions, and restores filled truth safely

Every scenario persists auditable evidence containing the intent ID, submit attempts, local bot belief, REST truth, stream events, reconciliation result, and final replayable truth.

## `packages/signal-engine`

Implements deterministic signal logic:

- feature building
- prior model
- posterior update
- edge calculation
- EV calculation
- filters
- mispricing scoring
- regime classification

This package should not know anything about HTTP, NestJS, or the UI.

## `packages/risk-engine`

Implements approval and safety logic:

- bankroll state
- bet sizing
- capped Kelly
- position limits
- daily loss limits
- kill switches
- EV drift guards
- adverse-selection guards

The risk engine is the final veto layer before execution.

## `packages/execution-engine`

Implements order lifecycle logic:

- canonical trade-intent resolution
- order planning
- routing rules
- marketable-limit behavior
- slippage estimation
- queue-position heuristics
- fill tracking
- stale-order handling
- exit logic
- execution diagnostics

## `packages/signing-engine`

Owns live signing readiness inputs:

- loading signing material
- Polymarket private-key normalization
- signer health validation

This package exists to keep signing readiness concerns isolated from higher-level trade logic. Live order signing happens inside the official Polymarket trading client.

## `packages/agent-layer`

Implements supervisory AI behaviors:

- strategy planning
- strategy critique
- daily review
- anomaly analysis
- execution-drift explanation

The agent layer should never directly own raw live order placement.

## `packages/ui-contracts`

Defines shared payloads between backend and frontend:

- dashboard
- scene
- activity
- markets
- signals
- orders
- portfolio
- diagnostics
- control state

## Runtime state

The bot has explicit runtime state.

Expected states include:

- `stopped`
- `starting`
- `running`
- `stopping`
- `halted`

Only `running` permits new order creation.

## Start / Stop model

### Start
Start transitions the system into active live operation.

Expected checks before activation:

- signer health
- credentials loaded
- live config present
- risk limits loaded
- market sync available

### Stop
Stop blocks new entries and transitions toward a clean, safe state.

Expected behavior:

- no new orders created
- stale working orders optionally canceled
- reconciliation continues
- final state becomes `stopped`

## Diagnostics and hardening

The system includes dedicated diagnostics and stress testing because short-duration binary crypto markets are sensitive to:

- latency
- spread widening
- shallow depth
- stale books
- execution drift
- adverse selection
- timing near market resolution

The architecture therefore includes:

- diagnostics module in the API
- stress-test jobs in the worker
- execution-quality support in domain, risk, and execution packages

## Security boundaries

- private credentials must remain server-side
- signing material must not be exposed to the frontend
- OpenAI API credentials must remain server-side
- the UI is strictly an operator and observability surface

## Deployment model

At minimum, a production deployment should include:

- one API instance
- one worker instance
- PostgreSQL
- Redis
- metrics / telemetry stack

The worker and API should be independently deployable.

## Non-goals

This repository is not intended to be:

- a free-form LLM trading bot
- a manual-only operator console
- a replay-first research repository
- the P2/P3 research-to-production contract is defined in `docs/p2-p3-research-production-framework.md`
- a general-purpose exchange framework

It is specifically a live BTC 5-minute Polymarket trading system with agentic supervision and live diagnostics.

## Canonical Signing Path

Live signing now flows through one canonical path:

1. worker config resolves secret provenance and trading credentials
2. `packages/signing-engine/src/server-signer.ts` normalizes key material and exposes signer health
3. `packages/polymarket-adapter/src/official-trading-client.ts` constructs the official Polymarket SDK client from that signer
4. the official Polymarket trading client submits the live order

There is no secondary production wallet path and no generic live-signing fallback.

## Stream-First Truth

Runtime truth is stream-first:

- the market stream owns live book, midpoint, spread, tick-size, and last-trade truth
- the authenticated user stream owns near-real-time order/trade truth
- REST remains reconciliation and healing truth, not the sole live authority

If either stream becomes stale, the runtime downgrades to a safe state and blocks new entries.

## Startup And Recovery

The startup gate persists one verdict object that combines startup runbook, secret policy, signer readiness, crash recovery, and stream bootstrap checks before the worker may enter `running`.
