# Risk Policy

## Purpose

This document defines the live trading risk policy for `polymarket-btc-5m-agentic-bot`.

The concrete P1 implementation details for canonical account state, kill switches, liquidation, eligibility, and venue-operational handling live in `docs/p1-execution-capital-safety.md`.

The policy exists to ensure that:

- no trade is placed without passing explicit risk checks
- capital protection takes precedence over activity
- risk behavior is deterministic and auditable
- live execution can be halted automatically when conditions degrade

This is a live-only trading system. There are no alternate runtime modes.

## Core philosophy

The system is designed around the following risk principles:

1. **Preserve capital first**
2. **Take only selective trades**
3. **Keep position size small**
4. **Reduce activity when execution quality degrades**
5. **Stop trading when predefined guardrails are breached**

The risk engine has final veto authority over every proposed trade.

Runtime enforcement path:

- Market Analysis Agent must pass market-authority checks before risk review proceeds.
- Risk and Verification Agent performs deterministic risk checks and can veto already-approved signals before execution.
- Optional AI final-veto (via `packages/agent-layer`) is applied in production when `OPENAI_API_KEY` is configured; invalid/unavailable AI verdict blocks entries.
- Execution and Portfolio Agent enforces authority gates and will not submit orders when market or risk authority vetoes are active.

## Risk boundaries

The live system must enforce the following categories of risk:

- exposure risk
- loss risk
- execution risk
- stale-data risk
- timing risk
- model-quality risk
- operational risk

## Exposure risk

Exposure risk controls how much live market exposure the system can hold.

### Required controls

- maximum open positions
- maximum exposure per market
- maximum aggregate exposure
- no duplicate exposure beyond configured limits
- no uncontrolled averaging into losing positions

### Expected baseline

Initial live configuration should assume:

- only one open position at a time
- tightly capped size
- no pyramiding unless explicitly supported later

## Position sizing policy

The system uses small position sizing derived from:

- bankroll state
- capped Kelly fraction
- EV quality
- liquidity conditions
- execution quality assumptions

Position sizing must decrease when:

- bankroll declines
- spread widens
- expected slippage increases
- fill quality deteriorates
- consecutive losses accumulate

Position sizing must never bypass hard configured limits.

## Daily loss policy

The bot must maintain a live daily loss limit.

### Rules

- once the configured daily loss threshold is reached, no new entries are allowed
- the bot must transition to a safe stopped or halted state
- the event must be recorded in the audit system
- the UI must surface the loss-triggered stop condition clearly

Daily loss is a hard rule, not a warning.

## Consecutive loss policy

The system must track consecutive losing trades.

### Rules

- after the configured number of consecutive losses is reached, new entries must stop
- a kill-switch event must be emitted
- the runtime must require explicit human restart after investigation

This protects against:

- rapid regime change
- model failure
- execution degradation
- adverse selection

## No-trade-near-expiry policy

Because the system targets short-duration BTC-linked markets, entering too close to resolution increases timing and execution risk.

### Rules

- no new entry is allowed inside the configured no-trade window near expiry
- the default live policy should block entries late in the 5-minute interval
- the exact threshold should be configurable but enforced hard

This control is mandatory.

## Stale-data policy

No trade may proceed if the required market inputs are stale.

### Required checks

- BTC reference feed freshness
- candle freshness
- orderbook freshness
- market snapshot timestamp freshness

If freshness is violated:

- signal generation may continue for monitoring
- trade execution must be blocked

## Spread and liquidity policy

A trade must be rejected when execution conditions are poor.

### Required checks

- spread width threshold
- minimum depth threshold
- fill-probability estimate
- expected slippage threshold

A positive model signal is not enough if the orderbook makes the trade uneconomic.

## EV threshold policy

A trade must pass a net EV threshold, not just a raw directional edge check.

Net EV must account for:

- fee estimate
- slippage estimate
- impact estimate

### Rules

- if net EV is less than or equal to threshold, reject
- if raw edge is positive but net EV is negative, reject
- the threshold must be conservative enough to survive realistic execution friction

## Adverse-selection policy

The system must detect whether fills are consistently worse than expected.

### Required checks

- edge at signal time
- edge at fill time
- realized EV vs expected EV
- quote decay while orders rest

If the system detects persistent adverse selection:

- reduce size
- reduce trade frequency
- or halt trading depending on severity

## Expected-vs-realized EV policy

The system must continuously compare:

- expected EV at decision time
- realized EV after fill and outcome

### Rules

- persistent negative drift must trigger protective action
- protective actions may include throttling, size contraction, or halt
- this drift must be visible in diagnostics and audit logs

A strategy with good-looking theoretical EV but poor realized EV is not behaving safely.

## Bankroll contraction policy

The system must reduce aggressiveness as bankroll declines.

### Rules

- sizing should contract automatically under drawdown
- drawdown should reduce both position size and willingness to trade marginal opportunities
- no static size policy should survive major bankroll impairment unchanged

This is especially important for small starting capital.

## Operational halt policy

The bot must halt when critical operational failures occur.

### Halt conditions include

- signer failure
- credential failure
- repeated order-post failures
- market data freshness failure
- severe execution-drift breach
- daily loss breach
- repeated reconciliation failure

### Halt behavior

- no new orders allowed
- audit event recorded
- UI reflects halted state
- manual restart required

## Start preconditions

The bot must not transition to `running` unless all of the following are true:

- credentials loaded
- signer health is good
- market feeds available
- portfolio initialized
- risk config loaded
- bot-control state valid

If these checks fail, Start must be rejected.

## Stop behavior

Normal Stop should:

- block new entries
- permit cleanup and reconciliation
- optionally cancel stale working orders
- transition safely to `stopped`

Normal Stop is distinct from Halt. Stop is controlled; Halt is protective.

## Agent-layer constraints

The AI supervisory layer must not bypass or weaken live risk rules in real time.

### Allowed AI roles

- strategy proposal
- strategy critique
- anomaly explanation
- daily review

### Disallowed AI roles

- direct live order approval bypassing risk checks
- direct override of kill-switch conditions
- direct mutation of live limits without explicit API-side validation

The risk engine remains authoritative.

## Required audit coverage

Every risk-relevant event must be auditable.

P2/P3 deployment tiers, capital ramping, and setup-aware attribution rules are defined in `docs/p2-p3-research-production-framework.md`.

Examples:

- signal rejected by risk
- signal approved by risk
- position limit breach
- daily loss breach
- stale data rejection
- spread rejection
- liquidity rejection
- no-trade-near-expiry rejection
- EV drift halt
- consecutive-loss halt

## Default posture

The default policy posture should be conservative:

- small size
- one position max
- strict freshness requirements
- strict EV threshold
- hard late-window rejection
- hard daily loss stop
- aggressive halt on repeated failures

## Policy invariants

The system must always preserve these invariants:

- no live trade without explicit risk approval
- no live trade when bot state is not `running`
- no live trade on stale market inputs
- no live trade when signer or credentials are unhealthy
- no trade outside configured exposure rules
- no trade when net EV fails threshold
- no silent recovery from critical risk breaches without audit visibility

## Summary

The risk policy is the hard safety boundary of the live bot.

The intended behavior is:

- trade selectively
- size conservatively
- reject low-quality opportunities
- shrink under drawdown
- halt when execution or operations become unsafe

This policy is mandatory for the live runtime and must be enforced in deterministic code.
