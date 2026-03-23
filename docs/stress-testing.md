# Stress Testing

## Purpose

This document defines the stress-testing framework for the live bot.

The stress-testing system exists to answer one question:

**does the live trading system remain coherent, selective, and safe when market conditions, timing, and execution quality degrade?**

Because the bot operates on short-duration BTC-linked markets, it is sensitive to:

- timing near market expiry
- stale market data
- spread widening
- shallow depth
- slippage
- order latency
- execution drift
- regime change

The stress-testing framework must quantify how the bot behaves under these conditions.

## Output requirements

Every stress-test run must produce structured results that include:

- test family
- scenario identifier
- injected perturbation parameters
- sample size
- expected EV
- realized EV
- slippage statistics
- fill rate
- stale-order counts
- drawdown
- kill-switch triggers
- final pass/fail verdict

Results must be persisted and exposed through diagnostics endpoints.

## Stress-test families

The live system defines six stress-test families:

1. resolution-window integrity
2. orderbook and fill-quality stress
3. fee and friction stress
4. latency stress
5. regime stress
6. risk-of-ruin stress

A seventh analysis family is also required:

7. expected-vs-realized EV drift analysis

---

## 1. Resolution-window integrity

### Objective

Verify that the bot does not rely on fragile timing assumptions near the end of the 5-minute contract window.

### Variables to perturb

- local clock skew
- BTC reference feed delay
- order submission lag
- order cancel lag
- entry cutoff time before expiry

### Example scenarios

- local clock skew: ±100ms, ±250ms, ±500ms, ±1s
- feed delay: 100ms, 250ms, 500ms, 1s, 2s
- entry cutoff: 120s, 60s, 30s, 15s, 5s before expiry

### What to measure

- change in trade frequency
- change in expected EV
- change in realized EV
- late-entry rejection rate
- timing-related fill degradation

### Pass condition

The bot should either:
- remain profitable within realistic timing noise, or
- correctly reduce activity and reject fragile entries

If profitability depends on unrealistically low latency or zero timing error, the scenario fails.

---

## 2. Orderbook and fill-quality stress

### Objective

Verify that the bot behaves correctly when the live book worsens.

### Variables to perturb

- spread width
- available depth
- partial fills
- no-fill conditions
- adverse queue movement

### Example scenarios

- spread widening by 0.5c, 1c, 2c
- depth reduced by 25%, 50%, 75%
- partial fill fractions of 25%, 50%, 75%
- full no-fill scenario
- queue movement one or more price levels worse than expected

### What to measure

- fill rate
- slippage
- expected EV vs realized EV
- cancel-and-replace counts
- stale-order counts
- final trade profitability after fills

### Pass condition

The system must:
- avoid forced overtrading in bad books
- manage partial/no fills without corruption
- keep stale-order behavior under control

---

## 3. Fee and friction stress

### Objective

Verify that the strategy survives realistic cost expansion.

### Variables to perturb

- taker fee multiplier
- slippage estimate
- impact estimate
- price proxy choice

### Example scenarios

- fee multiplier: 1.0x, 1.25x, 1.5x, 2.0x
- slippage add-on: 0.5c, 1c, 2c
- impact profiles: low, medium, high
- EV reference computed from different pricing assumptions

### What to measure

- trade count under cost pressure
- break-even threshold drift
- expected EV degradation
- realized EV degradation

### Pass condition

The system must either:
- remain selective and survive cost stress, or
- reduce trading activity before sustained negative expectancy occurs

---

## 4. Latency stress

### Objective

Verify that the system does not depend on impossible execution speed.

### Variables to perturb

- market-data lag
- signal-processing delay
- order-submission latency
- cancel latency
- reconciliation delay

### Example scenarios

- 50ms
- 100ms
- 250ms
- 500ms
- 1s

### What to measure

- edge at signal time
- edge at fill time
- fill quality
- stale-order rate
- realized EV decay

### Pass condition

The strategy must not rely on a latency assumption the system cannot realistically sustain.

---

## 5. Regime stress

### Objective

Verify that the bot changes behavior appropriately across market regimes.

### Regimes

- `trend_burst`
- `low_vol_chop`
- `reversal_shock`
- `spread_blowout`
- `correlated_rush`

### What to measure

- trade frequency by regime
- win rate by regime
- expected EV by regime
- realized EV by regime
- no-trade rate by regime
- drawdown by regime

### Pass condition

The bot should be more selective in hostile regimes and should not treat all regimes equally.

---

## 6. Risk-of-ruin stress

### Objective

Verify that the risk system protects capital and halts when necessary.

### Variables to perturb

- consecutive losses
- drawdown severity
- stale working orders
- auth failures
- API / signing failures
- reconciliation failure

### Example scenarios

- 3, 5, 7, 10 consecutive losses
- bankroll drops of 5%, 10%, 20%
- signer unavailable during live session
- exchange auth failure during runtime
- temporary market data outage

### What to measure

- kill-switch triggers
- halt behavior correctness
- blocked new-entry behavior
- bankroll contraction behavior
- state consistency after recovery

### Pass condition

The bot must stop trading safely when protective thresholds are crossed.

---

## 7. Expected-vs-realized EV drift analysis

### Objective

Measure whether the system captures the EV it thinks it is capturing.

### Required fields

For each trade:

- expected EV at decision time
- estimated fee
- estimated slippage
- estimated impact
- realized fill price
- realized fee
- realized outcome
- realized EV
- EV delta

### What to measure

- rolling expected EV
- rolling realized EV
- ratio of realized EV to expected EV
- drift by regime
- drift by spread band
- drift by latency bucket

### Pass condition

Persistent negative EV drift must trigger a protective response.

---

## Metrics definitions

### Fill rate
Fraction of submitted orders that receive fills.

### Stale-order rate
Fraction of submitted orders that become stale under policy definition.

### Expected EV
Pre-trade expected value after modeled friction.

### Realized EV
Observed value after actual fill and outcome.

### EV drift
Difference between realized EV and expected EV.

### Drawdown
Peak-to-trough bankroll decline over the relevant horizon.

### Kill-switch count
Number of times the system triggered an emergency protective halt.

---

## Run-level pass / fail policy

A stress-test run should be marked `failed` if any of the following occur:

- the bot continues trading after a hard risk boundary is breached
- stale-order handling corrupts order state
- position limits are exceeded
- realized EV collapses without triggering safeguards
- runtime state becomes inconsistent
- Start / Stop / Halt transitions break invariants

A stress-test run may be marked `degraded` if:

- trade frequency collapses safely
- profitability falls but risk handling remains correct
- protective throttling is triggered appropriately

A stress-test run may be marked `passed` if:

- runtime remains coherent
- risk controls behave correctly
- expected degradation is observed without unsafe behavior

---

## Persistence requirements

Each run must persist:

- run metadata
- scenario definitions
- scenario-level results
- aggregate summary
- final verdict

This data is consumed by diagnostics APIs and the web dashboard.

---

## API requirements

The API should expose diagnostics routes for:

- listing stress runs
- fetching a stress-run summary
- fetching scenario-level results
- launching stress jobs
- retrieving EV drift metrics

---

## UI requirements

The web dashboard should provide a stress-testing panel that can display:

- latest run summaries
- pass / fail status
- scenario comparisons
- EV drift charts
- fill-quality summaries
- regime-based diagnostics

---

## Default acceptance thresholds

Initial baseline thresholds should be conservative.

Examples:

- fill rate must remain acceptable in supported liquidity bands
- realized EV / expected EV ratio must not collapse persistently
- stale-order timeout handling must remain near-perfect
- kill-switch behavior must be immediate and correct
- no-trade-near-expiry logic must always be respected

Exact numbers are configured in live policy and diagnostics code.

---

## Summary

Stress testing is not optional.

The live bot must be able to answer:

- what happens when latency increases
- what happens when spreads widen
- what happens when depth vanishes
- what happens when timing assumptions fail
- what happens when the model overestimates edge
- what happens when operations degrade

Only a bot that remains coherent under these stressors can be considered operationally trustworthy.