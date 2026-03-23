# Execution Diagnostics

## Purpose

This document defines the execution diagnostics layer for the live bot.

Execution diagnostics exist to answer:

- did the bot get the fills it expected?
- did realized outcomes match expected EV assumptions?
- did live execution degrade without the strategy noticing?
- are spread, latency, and order handling eroding profitability?

This layer is mandatory because short-duration market strategies often fail through execution drift rather than pure model error.

## Diagnostic goals

The execution diagnostics system must make it possible to identify:

- poor fill quality
- stale orders
- hidden slippage
- queue-position deterioration
- adverse selection
- expected EV vs realized EV drift
- routing-policy mistakes
- cancel/replace inefficiency

## Core diagnostic units

Diagnostics should be captured at multiple levels:

### Order-level
For every placed order, track:
- planned side
- reference market price
- expected entry price
- expected fee
- expected slippage
- expected impact
- posted price
- posted size
- time submitted
- time acknowledged
- time canceled or filled
- fill fraction
- realized average fill price

### Trade-level
For every completed trade, track:
- expected EV
- realized EV
- edge at signal
- edge at fill
- fill delay
- regime tag
- spread band
- no-trade filters passed
- exit reason

### Window-level
Over rolling windows, track:
- fill rate
- stale-order rate
- average slippage
- EV drift
- adverse-selection incidence
- cancel/replace frequency
- rejected-opportunity counts by reason

## Required metrics

## 1. Fill rate

Definition:
- fraction of submitted orders that receive fills

Use:
- identifies whether the bot is too passive
- helps compare routes and price aggressiveness

## 2. Partial fill rate

Definition:
- fraction of orders that fill only partially

Use:
- indicates whether quote placement is too aggressive or too large for available depth

## 3. Stale-order rate

Definition:
- fraction of orders that exceed freshness thresholds without acceptable fills

Use:
- detects poor cancel/replace policy
- identifies exposure to resting stale quotes

## 4. Fill delay

Definition:
- time between order submission and fill

Use:
- helps explain queue degradation
- identifies timing fragility in fast markets

## 5. Edge at signal

Definition:
- estimated model edge at decision time

Use:
- baseline expected opportunity quality

## 6. Edge at fill

Definition:
- estimated edge using realized fill context

Use:
- measures opportunity decay between decision and execution

## 7. Expected EV

Definition:
- pre-trade EV after estimated fee, slippage, and impact

Use:
- baseline profitability expectation

## 8. Realized EV

Definition:
- observed EV after actual fill and outcome

Use:
- confirms whether theoretical expectancy survives live execution

## 9. EV drift

Definition:
- realized EV minus expected EV

Use:
- the most important execution-health metric
- persistent negative drift suggests live degradation

## 10. Slippage

Definition:
- difference between expected executable price and actual realized price

Use:
- indicates live fill quality
- should be segmented by spread, regime, and order style

## 11. Adverse selection rate

Definition:
- frequency with which fills occur after market movement against the bot’s expected edge

Use:
- identifies whether the bot is getting picked off by faster participants

## 12. Cancel/replace count

Definition:
- number of order modifications or replacement attempts per trade cycle

Use:
- measures routing efficiency and stale-order handling

## Diagnostic dimensions

Every diagnostic should be segmentable by:

- regime
- spread band
- depth band
- latency bucket
- time-to-expiry bucket
- order type / route
- side
- market
- strategy version

This segmentation is essential. Averages across all conditions are not enough.

## Timing diagnostics

The live system must measure timing explicitly.

Required timestamps:

- market data timestamp
- signal timestamp
- risk approval timestamp
- order creation timestamp
- order post timestamp
- order acknowledgement timestamp
- fill timestamp
- cancel timestamp
- reconciliation timestamp

The diagnostics system must calculate:

- data staleness
- decision latency
- posting latency
- fill latency
- cancellation latency

## Price reference diagnostics

The system must record the price basis used at decision time.

Examples:
- best bid
- best ask
- mid
- modeled executable price
- last trade

If a strategy looks profitable only under one unrealistic price proxy, diagnostics must reveal that.

## Expected-vs-realized EV framework

Every completed trade should produce an EV comparison record.

Required fields:

- trade identifier
- expected EV
- realized EV
- EV drift
- expected fee
- realized fee
- expected slippage
- realized slippage
- expected impact
- realized impact proxy
- edge at signal
- edge at fill

This framework is the basis for execution-drift detection.

## Execution-drift detection

The system must compute rolling execution drift.

Examples of rolling windows:
- last 10 trades
- last 25 trades
- last 50 trades
- last 60 minutes
- current trading session

A negative drift trend should trigger:

- warnings
- throttling
- size contraction
- or halt behavior, depending on severity

## Adverse-selection diagnostics

Adverse selection should be measured explicitly.

Indicators:
- edge materially worse at fill than at signal
- fills occurring only when book moves against the bot
- profitable-looking signal decisions turning into weak fills systematically

The risk engine may use these diagnostics through the adverse-selection guard.

## No-trade diagnostics

The system must also record **why trades were rejected**.

Examples:
- stale book
- insufficient liquidity
- spread too wide
- too close to expiry
- EV below threshold
- risk limit exceeded
- kill switch active

These diagnostics are important because improvement often comes from understanding rejections, not just filled trades.

## Daily execution summary

The daily review path should include:

- total attempted orders
- fill rate
- stale-order rate
- average expected EV
- average realized EV
- EV drift summary
- worst spread conditions traded
- regime breakdown
- top rejection reasons
- major execution anomalies

This summary is used by the supervisory agent layer and surfaced in the UI.

## Persistence requirements

Execution diagnostics must be persisted in structured form.

Expected persisted entities include:

- per-order execution diagnostics
- per-trade EV diagnostics
- rolling EV drift diagnostics
- regime-segmented summaries
- stale-order summaries

Diagnostics should not exist only in logs.

## API exposure

The API should expose endpoints for:

- recent execution diagnostics
- EV drift summaries
- fill quality summaries
- adverse-selection summaries
- rejection reason summaries

The web dashboard should consume these endpoints directly.

## UI requirements

The web app should surface at least:

- fill rate
- stale-order rate
- expected EV vs realized EV
- EV drift
- slippage trend
- adverse-selection rate
- top rejection reasons

These diagnostics should be available in dedicated execution-quality panels.

## Invariants

The diagnostics layer must preserve the following invariants:

- every live order should produce execution diagnostics
- every completed trade should produce EV comparison diagnostics
- stale orders should be measurable
- diagnostic timestamps should be consistent and comparable
- no hidden routing behavior should escape observation

## Summary

Execution diagnostics are how the bot verifies that live trading matches its own assumptions.

Without them, the system cannot reliably tell whether:

- the signal model is wrong
- execution is poor
- market conditions changed
- fills are being adversarially selected
- or friction erased the edge

This diagnostics layer is a first-class part of the live system.