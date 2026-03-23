# Live Trading Flow

## Purpose

This document defines the live-only end-to-end trading flow for `polymarket-btc-5m-agentic-bot`.

For the canonical P1 safety model that wraps this flow, see `docs/p1-execution-capital-safety.md`.

The system operates only in `live_bot` mode.

## High-level loop

The live runtime follows this cycle:

1. discover active BTC-linked Polymarket markets
2. sync BTC reference price and recent candles
3. sync Polymarket orderbooks and market snapshots
4. build deterministic features
5. compute prior probability
6. apply posterior update
7. compute edge
8. compute net EV after expected execution costs
9. apply risk gates
10. if approved, resolve the explicit trade intent and submit through the official Polymarket trading client
11. manage open orders and fills
12. update portfolio state
13. persist diagnostics and audit events
14. expose updated state through the API

## Runtime prerequisites

The live loop should not start unless all of the following are true:

- bot state is `starting` or `running`
- credentials are loaded
- signer health is `ok`
- market sync is available
- market stream bootstrap succeeds from REST truth into live WebSocket truth
- user stream bootstrap succeeds from REST truth into authenticated WebSocket truth
- BTC reference feed is fresh
- risk config is loaded
- portfolio state is initialized

If any prerequisite fails, the runtime should refuse activation or transition to `halted`.

## Flow stages

## 1. Discover active BTC markets

The worker periodically queries live market discovery through the Polymarket adapter.

Expected output:

- active BTC-linked market IDs
- token IDs
- current market metadata
- tradability flags

These results are persisted for later signal and execution use.

## 2. Sync BTC reference

The worker fetches BTC reference inputs:

- current BTC reference price
- recent candle history
- volatility metrics
- feed freshness metrics

This data must be timestamped and normalized before use.

## 3. Sync orderbooks

The worker fetches current live orderbooks for the active target markets.

Expected book fields:

- best bid
- best ask
- bid / ask depth
- spread
- book timestamp

If the book is stale, the signal engine must reject the opportunity.

### 3a. Market stream bootstrap and recovery

The live runtime does not trust the market channel on socket-open alone.

For every tracked token:

1. fetch REST orderbook truth from the CLOB API
2. open the market WebSocket and subscribe by `asset_id`
3. require the initial `book` dump from the venue
4. reconcile the initial dump against the REST baseline
5. mark the market stream trusted only after every tracked token has completed that handshake

After trust is established:

- `price_change`, `book`, `best_bid_ask`, `last_trade_price`, and `tick_size_change` update the in-memory live book state
- duplicate or out-of-order messages are ignored with timestamp-plus-event-key protection
- heartbeat health comes from real inbound traffic, not a local `start()` toggle

If market traffic goes stale or reconnect/bootstrap fails:

- the stream becomes unhealthy
- runtime state downgrades to `degraded`
- new entries stay blocked until trusted stream truth returns

## 4. Build features

The signal engine constructs features from:

- BTC returns
- BTC volatility
- market microstructure
- orderbook imbalance
- market probability state
- spread and liquidity conditions
- timing within the 5-minute market window

This step should be deterministic and reproducible from persisted market data.

## 5. Compute prior probability

The prior model estimates the base probability for the relevant BTC 5-minute contract outcome.

The prior is independent of trade execution and should reflect only modeled state.

## 6. Apply posterior update

The posterior update adjusts the prior with live evidence such as:

- new orderbook imbalance
- rapid price movement
- volatility changes
- regime classification
- live signal freshness

The posterior is the primary probability estimate used for edge calculation.

## 7. Compute edge

Edge is computed by comparing posterior probability against the live market-implied probability.

This must be done using a clearly defined market-price proxy.

Examples of possible market-price references:

- best ask for taker-style buy logic
- best bid for sell logic
- controlled reference price depending on route

The system must avoid using unrealistic price assumptions.

## 8. Compute net EV

Net EV must include:

- edge
- fee estimate
- slippage estimate
- impact estimate

An opportunity with positive raw edge but negative net EV must be rejected.

## 9. Apply risk gates

The risk engine determines whether a candidate signal is tradable.

Risk checks include:

- max open positions
- bankroll availability
- per-trade sizing
- daily loss limit
- consecutive-loss kill switch
- adverse-selection guard
- expected-vs-realized EV drift guard
- no-trade near expiry
- stale-book rejection

Any failing risk check must block execution.

## 10. Plan and execute order

If risk approves the trade:

1. the execution engine resolves the canonical trade intent to one explicit token and venue side
2. the execution engine plans one venue-valid order from that intent
   - GTC for passive open-ended resting entry
   - GTD for passive time-bounded resting entry with a venue-safe expiration
   - FOK for immediate all-or-nothing execution
   - FAK for immediate partial-fill-tolerant execution
   - negative-risk markets are rejected explicitly by policy
   - duplicate venue exposure is vetoed before submit
   - live fee-rate and maker-quality metadata are attached when available
3. the official Polymarket trading client signs the order through the official SDK wallet path and submits it
4. the resulting order state is persisted

Execution must use the same assumptions that were used in EV calculation as closely as possible.

## 11. Manage open orders

After submission, the worker continuously evaluates working orders.

Expected behaviors:

- detect stale orders
- wait, replace, cancel, or abandon according to deterministic policy
- stop chasing after adverse price moves
- cap reprices per signal
- track partial fills
- update open order state
- prevent duplicate exposure

The runtime must not allow stale working orders to accumulate uncontrolled.

## 12. Reconcile fills and positions

The worker regularly reconciles:

- open orders
- completed fills
- current position inventory
- realized and unrealized P&L

This reconciliation step should be idempotent and safe to rerun.

### 12a. User stream bootstrap and recovery

The authenticated user channel is the primary live source for near-real-time order and trade truth.

Its bootstrap sequence is:

1. resolve tracked BTC markets to Polymarket `conditionId` values
2. fetch REST open orders and trades
3. open the authenticated user WebSocket and subscribe by `conditionId`
4. buffer incoming `order` and `trade` events while bootstrap is in progress
5. refetch REST truth, seed local state from that snapshot, replay buffered events with ordering/status protection, and verify there is no divergence
6. mark the user stream trusted only after reconciliation passes

Reconnect policy for both streams:

- retry is bounded
- delays use exponential backoff plus jitter
- reconnect always re-runs the full REST-to-stream bootstrap
- disconnect, stale traffic, or unrecoverable divergence revoke trust immediately

If the user stream becomes unhealthy:

- runtime moves to `reconciliation_only`
- entry evaluation stops
- reconciliation and portfolio refresh continue until stream truth is restored or the operator stops the bot

### 12b. Production readiness stream proof

`scripts/run-production-readiness.sh` now proves live stream truth instead of only checking that services were instantiated.

The readiness run must show:

- an active market subscription request on the market socket
- an active authenticated user subscription request on the user socket
- actual incoming market and user events after subscription
- stream freshness computed from the most recent actual incoming event time
- reconnect recovery after a forced disconnect using the same bootstrap and reconciliation code path as production
- user order lifecycle visibility from the stream, including appearance, advancement, and disappearance, rather than REST-only snapshots

If real venue access is unavailable, the controlled test harness must still exercise the same WebSocket client, bootstrap, reconciliation, and fail-closed logic.

REST-only proof is insufficient because readiness has to confirm that the system can trust live orderbook and order lifecycle truth between REST polls.

### 12c. Lifecycle validation proof

`corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:lifecycle` runs the lifecycle validation suite in `apps/worker/src/validation/live-order-lifecycle-validation.ts`.

The suite ties together submit, visibility, fill, cancel, reconnect, restart, and crash recovery paths instead of testing them in isolation.

For every scenario it persists:

- intent ID and submit attempts
- local order and fill belief before and after correction
- venue REST truth
- user-stream events
- reconciliation verdicts
- final replayable order and portfolio truth

The suite must fail closed if any scenario would create duplicate exposure, leave ghost exposure after recovery, or accept a terminal assumption before venue truth confirms it.

## 13. Refresh portfolio state

The portfolio module updates:

- available capital
- active exposure
- current open positions
- daily P&L
- rolling loss state
- risk flags

Risk logic should always use the latest reconciled portfolio state.

## 14. Persist diagnostics and audit events

For every important event, the system persists audit and diagnostic records.

Examples:

- signal created
- signal rejected
- signal approved
- order posted
- order canceled
- fill received
- position opened
- position closed
- EV drift detected
- kill switch triggered

This data is later used by the API and web dashboard.

## 15. Publish live state through API

The API exposes the latest state for:

- bot runtime state
- markets
- signals
- orders
- portfolio
- diagnostics
- audit stream

The frontend consumes these endpoints to render the live dashboard.

## Start sequence

The expected Start sequence is:

1. UI or API issues Start
2. bot-control validates config
3. signer health is checked
4. runtime transitions to `starting`
5. worker begins market sync
6. portfolio is refreshed
7. signal loop activates
8. runtime transitions to `running`

`BOT_LIVE_EXECUTION_ENABLED` must be `true` for Start readiness to pass.

If any step fails, runtime should enter `halted` or return to `stopped` depending on failure class.

## Stop sequence

The expected Stop sequence is:

1. UI or API issues Stop
2. runtime transitions to `stopping`
3. no new entries are allowed
4. stale or all working orders may be canceled when `cancelOpenOrders=true`
5. reconciliation continues
6. runtime transitions to `stopped`

The Stop sequence must be safe to call repeatedly.

## Emergency halt

An emergency halt is distinct from a normal stop.

Expected halt triggers include:

- signer failure
- exchange credential failure
- market data freshness failure
- execution drift threshold breach
- daily loss threshold breach
- repeated unexpected order failures

When halted:

- no new entries are allowed
- risk state is frozen for investigation
- alerts and audit events must be emitted

## Timing discipline

Because the target product is a short-duration BTC market, timing discipline matters.

The live loop must account for:

- feed freshness
- local clock consistency
- market-window timing
- no-trade near expiry
- cancellation responsiveness

The runtime should not assume frictionless or latency-free execution.

## Diagnostics in live flow

The live loop is instrumented with diagnostics to measure:

- expected EV vs realized EV
- fill quality
- slippage
- stale-order rate
- spread conditions
- regime behavior

These diagnostics are not optional. They are part of the live trading flow.

## Daily review flow

The worker also performs a periodic review pass.

This includes:

- P&L summary
- execution-quality summary
- EV drift summary
- anomaly explanations
- AI-generated supervisory review output

This review should not alter the live loop directly. It should support monitoring and future strategy refinement.

## Invariants

The live trading flow should maintain the following invariants:

- no new order when bot state is not `running`
- no new order when signer is unhealthy
- no new order when required market data is stale
- no trade if net EV does not pass threshold
- no trade if risk vetoes
- no duplicate exposure beyond configured limits
- all order state changes are auditable

## Summary

The live bot is a closed-loop system:

- data comes in
- deterministic logic evaluates opportunity
- risk decides if action is allowed
- execution acts
- reconciliation updates state
- diagnostics measure quality
- API and UI expose the system live

This loop must remain deterministic, risk-controlled, and fully observable.

## Live Control Flow

The live flow now requires:

1. secret provenance resolution and production-safe secret approval
2. a persisted startup verdict
3. crash recovery before new capital is deployed
4. market/user stream bootstrap
5. official SDK-backed order signing and submission

The official Polymarket trading client signs the order through the official SDK wallet path.

## Runtime Downgrade Rules

New entries are blocked when any of the following becomes stale or unhealthy:

- external portfolio truth
- market-stream truth
- user-stream truth
- open-order heartbeat when live resting orders exist
- required venue metadata such as tick size

The runtime responds by moving into `degraded` or `reconciliation_only` and forcing reconciliation before discretionary trading can resume.

## Production Readiness Suite

Use `scripts/run-production-readiness.sh` to run the full readiness suite.
Use `scripts/run-p23-validations.sh` to run the P2/P3 governed validation, worker tests, and fail-closed research checks.

It covers authenticated venue reads, submit/visibility/heartbeat/cancel/post-cancel checks, stream health, and reconciliation health.
