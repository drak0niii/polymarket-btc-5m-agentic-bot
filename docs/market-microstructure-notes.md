# Market Microstructure Notes

## Purpose

This document captures the live market microstructure assumptions that matter for the BTC 5-minute Polymarket bot.

The trading system operates on short-duration binary contracts, so execution quality, timing, spread, and liquidity can dominate raw model quality.

These notes define the practical realities the system must account for.

## Core view

The bot is not simply predicting whether BTC will move.

It is trading a **binary contract** inside a live market structure where:

- prices move in a short time window
- probability representation is path-dependent
- fills occur through a live order book
- late entries can be fragile
- costs can erase small edges
- stale quotes can create false opportunity

The correct objective is not “predict direction.”
The correct objective is:

**find mispricing that survives fees, spread, slippage, latency, and live execution.**

## Short-duration binary market implications

Because the target market is a short-horizon BTC-linked contract, timing matters more than in slower markets.

### Implications

- model edge decays quickly
- late entries become dangerous
- stale market data can invalidate decisions
- quote management is critical
- execution quality must be measured continuously

## Probability market interpretation

The contract price is not the same thing as “ground truth probability.”

The live market price reflects:

- order flow
- spread
- liquidity
- resting interest
- recent trades
- latency and information arrival

The strategy must treat displayed price as a tradable market state, not as a perfectly efficient probability.

## Order-book reality

The bot trades into a live order book.

This means:

- spread matters
- depth matters
- queue position matters
- partial fills matter
- no-fill outcomes matter
- stale resting quotes are dangerous

Any strategy that ignores these realities is incomplete.

## Marketable-limit execution reality

The execution engine should assume that aggressive execution is not free.

Even when the bot uses a marketable order style, the effective fill still depends on:

- book depth
- quote movement
- matching speed
- how long the order remains exposed

Therefore EV must always be computed net of expected execution friction.

## Spread sensitivity

Short-duration binary markets can be highly sensitive to spread width.

A strategy that looks positive before spread can become negative after spread.

### Policy implication

The bot must:

- reject wide spreads
- penalize spread in EV
- reduce size in worse spread conditions
- record spread bands in diagnostics

## Depth sensitivity

Available depth determines whether the bot can obtain its expected price.

If the displayed top-of-book depth is small:

- larger orders become unrealistic
- partial fills become more likely
- effective slippage rises
- queue behavior matters more

### Policy implication

The bot must:

- check minimum depth before entry
- estimate fill probability
- shrink size when depth worsens

## Staleness risk

A quote or orderbook snapshot can become stale before execution.

In a short-duration market, stale data can create false edge.

### Policy implication

The bot must reject signals when:

- book age exceeds threshold
- BTC reference feed is stale
- price data and orderbook timestamps are materially misaligned

## Time-to-expiry risk

In a 5-minute market, time remaining in the window is part of the trade.

A strategy that enters too late is exposed to:

- timing noise
- quote fade
- reduced correction time
- fragile last-second execution assumptions

### Policy implication

The bot must enforce a hard no-trade-near-expiry rule.

## Latency sensitivity

The strategy must be robust to realistic latency.

Latency affects:

- signal freshness
- order-post timing
- cancel/replace timing
- fill quality
- edge decay

A strategy that only works at impossible latency is not valid for production.

### Policy implication

- measure latency explicitly
- include latency in stress tests
- detect execution drift
- halt or throttle when latency materially degrades outcomes

## Adverse selection

Adverse selection occurs when the bot gets filled mainly when the market is moving against its expected edge.

This is especially dangerous in short-horizon markets.

### Signals of adverse selection

- edge at fill consistently worse than edge at signal
- fills occurring mainly after price movement against the bot
- realized EV persistently below expected EV

### Policy implication

The system must:
- track adverse-selection rate
- use an adverse-selection guard
- reduce activity or halt if the pattern persists

## Regime dependence

Short-term binary BTC markets behave differently across regimes.

Examples:

- trend burst
- low-vol chop
- reversal shock
- spread blowout
- correlated rush

A good signal in one regime may be bad in another.

### Policy implication

The signal engine must classify regime and diagnostics must segment results by regime.

## Friction hierarchy

The bot should think about execution friction in this order:

1. spread
2. slippage
3. impact
4. fill uncertainty
5. latency
6. queue deterioration

All of these can overwhelm a weak raw edge.

## Why expected EV is not enough

Expected EV is only useful if the live system can realize it.

The gap between:
- expected EV
- realized EV

is where most live systems fail.

### Policy implication

Expected-vs-realized EV drift is a first-class health metric.

## Rejection is a feature

In this microstructure, a healthy live bot should reject many possible trades.

Rejection reasons are a strength, not a weakness.

Examples:
- stale book
- low depth
- wide spread
- too late in the interval
- EV too small after costs
- poor recent execution quality

The system should become more selective as market quality deteriorates.

## Implications for the repo

These notes justify the existence of:

- book-freshness filters
- late-window filters
- spread filters
- liquidity filters
- fill-probability estimation
- queue-position estimation
- cancel/replace policy
- expected-vs-realized EV diagnostics
- adverse-selection guards
- execution-drift kill switches

## Summary

The live BTC 5-minute Polymarket market should be treated as a microstructure-sensitive execution problem, not just a directional prediction problem.

The bot must assume:

- edge is small
- costs matter
- timing matters
- fills matter
- late entries are dangerous
- stale books are dangerous
- realized EV can diverge sharply from expected EV

These assumptions define how the system should trade, filter, size, diagnose, and halt.