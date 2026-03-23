# Start / Stop

## Purpose

This document defines the Start / Stop behavior for the live bot runtime.

Operational reject handling, liquidation transitions, and restart-safe replay protection are summarized in `docs/p1-execution-capital-safety.md`.
P2/P3 readiness dashboard, replay tooling, audit-grade decision logs, deployment tiers, and capital ramping are summarized in `docs/p2-p3-research-production-framework.md`.
End-to-end live order lifecycle validation is summarized in `docs/live-order-lifecycle-validation.md`.

The system is live-only. Start and Stop are not cosmetic UI actions. They are control-plane operations that determine whether the worker is allowed to create new live market exposure.

## Runtime states

The bot should expose explicit runtime states.

Recommended states:

- `stopped`
- `starting`
- `running`
- `stopping`
- `halted`

### Meanings

#### `stopped`
The bot is inactive.
- no new entries
- no active live loop
- monitoring endpoints may still work

#### `starting`
The bot is preparing to become live.
- readiness checks are running
- execution is not yet allowed

#### `running`
The bot is active.
- signal evaluation allowed
- risk evaluation allowed
- live execution allowed

#### `stopping`
The bot is winding down.
- no new entries
- reconciliation continues
- working orders may be canceled according to policy

#### `halted`
The bot stopped due to a protective condition.
- no new entries
- manual investigation required
- manual restart required

## Start behavior

Start is the operation that arms the live runtime.

### Start preconditions

The system must reject Start unless all of the following are true:

- bot is currently `stopped`
- credentials are loaded
- signer health is good
- Polymarket startup preflight passes
- live configuration is valid
- market feeds are available
- required services are reachable
- portfolio state is initialized
- risk controls are loaded

Polymarket startup preflight must fail closed on:

- geoblock or jurisdiction restriction
- closed-only venue status
- server-time probe failure
- clock skew above the configured limit

### Start sequence

Expected sequence:

1. API receives Start request
2. bot-control validates current state
3. bot-control validates readiness
4. worker validates Polymarket startup preflight
5. runtime state transitions to `starting`
6. worker runtime initializes live loop dependencies
7. REST bootstrap runs for market and user stream truth
8. worker opens the real Polymarket WebSocket market channel and authenticated user channel
9. the worker reconciles stream state against REST truth and waits for trusted stream health
10. market sync begins
11. portfolio refresh completes
12. runtime state transitions to `running`

Readiness now proves more than service startup:

- market and user subscriptions must be active on the wire
- actual incoming stream traffic must be observed before readiness can pass
- stream freshness must be derived from the last actual incoming event time
- reconnect recovery must succeed through the same bootstrap path that production uses
- user order lifecycle events must be visible from the authenticated stream

If those conditions cannot be proven, readiness fails closed and Start must not continue.

### Start failure behavior

If any Start check fails:

- runtime must not enter `running`
- runtime should return to `stopped` or enter `halted` depending on severity
- an audit event must be written
- the API response must clearly indicate failure

## Stop behavior

Stop is the controlled shutdown of live trading activity.

### Stop rules

When Stop is issued:

- no new entries may be created
- existing working orders may be canceled according to policy
- reconciliation must continue until state is clean
- the runtime must transition through `stopping`
- final state becomes `stopped`

### Stop sequence

Expected sequence:

1. API receives Stop request
2. bot-control validates current state
3. runtime state transitions to `stopping`
4. worker blocks new entries
5. stale or working orders are handled
6. fills and positions are reconciled
7. runtime state transitions to `stopped`

### Stop idempotency

Stop should be safe to call repeatedly.

If the bot is already `stopped`:
- Stop should return success or no-op semantics
- no state corruption should occur

If the bot is already `stopping`:
- Stop should not restart cleanup or duplicate operations

## Halt behavior

Halt is different from Stop.

Stop is operator-driven.  
Halt is protection-driven.

### Example halt triggers

- signer health failure
- credential failure
- venue geoblock or closed-only detection
- excessive server-time clock skew
- daily loss limit breach
- consecutive-loss kill switch
- execution-drift kill switch
- stale data failure severe enough to invalidate live trading
- repeated critical order failures
- unrecoverable reconciliation failure

### Halt rules

When Halt occurs:

- runtime transitions to `halted`
- no new entries are allowed
- outstanding state may still be reconciled
- an audit event must be emitted
- manual restart is required

The system must not automatically resume from `halted` without explicit operator action.

## UI behavior

The web dashboard should clearly surface:

- current runtime state
- Start button
- Stop button
- disabled state logic
- last transition timestamp
- failure / halt reasons if present

### Start button rules

The Start button should be:

- enabled only when state is `stopped` and readiness checks pass
- disabled when state is `starting`, `running`, `stopping`, or `halted`

### Stop button rules

The Stop button should be:

- enabled when state is `running` or `starting`
- optionally enabled in `stopping` as a no-op
- disabled when state is `stopped`

### Halt visibility

If the runtime is `halted`, the UI must clearly show:

- halted status
- reason code or summary
- requirement for manual restart

## API responsibilities

The API should expose endpoints such as:

- `POST /api/v1/bot-control/start`
- `POST /api/v1/bot-control/stop`
- `GET /api/v1/bot-control/state`

The API is responsible for:
- validating state transitions
- exposing readiness and state payloads
- writing audit events for transition requests and outcomes

The worker is responsible for:
- enforcing runtime behavior
- refusing execution outside `running`
- honoring stop and halt flags
- failing closed when Polymarket venue-awareness checks detect degraded readiness

## Audit requirements

Every transition must be auditable.

Examples:

- Start requested
- Start accepted
- Start rejected
- runtime entered `starting`
- runtime entered `running`
- Stop requested
- runtime entered `stopping`
- runtime entered `stopped`
- runtime entered `halted`

Audit records should include:
- previous state
- next state
- reason
- request source if available
- timestamp

## Invariants

The Start / Stop model must preserve these invariants:

- no new order when state is not `running`
- no Start from `running`
- no silent transition to `running`
- no silent recovery from `halted`
- Stop must block new entries immediately
- cleanup and reconciliation must remain safe and repeatable

## Summary

Start / Stop is the live safety boundary of the system.

Start means:
- validate
- arm
- activate live loop

Stop means:
- block new entries
- clean up
- reconcile
- return to safe idle state

Halt means:
- protective shutdown
- operator investigation required

All three behaviors must be explicit, deterministic, and auditable.

## Canonical Runtime States

The runtime now uses one canonical state set:

- `bootstrapping`
- `running`
- `degraded`
- `reconciliation_only`
- `cancel_only`
- `halted_hard`
- `stopped`

`permissionsForRuntimeState()` is the single policy source for what jobs may do in each state.

Default semantics:

- `degraded`: no new entries and no discretionary submit; cancel, reconciliation, portfolio refresh, and heartbeat continue.
- `reconciliation_only`: sync, compare, rebuild, and heal truth only.
- `cancel_only`: cancel, reduce exposure, clean up, and reconcile only.
- `halted_hard`: fail closed, with emergency cancel as the only narrow exception when open venue risk must be neutralized.

## Startup Gate

Live start is hard-blocked by one persisted startup verdict.

That verdict records:

- production secret provenance approval
- signer health
- startup runbook evidence
- crash recovery outcome
- market/user stream bootstrap health
