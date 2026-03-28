# AGENTS.md

## Repository mission for this final remediation pass

This pass exists to close the last remaining runtime and control-plane issues so the dashboard becomes fully trustworthy and operationally dependable.

The mission is not to add features.
The mission is to remove the last runtime lies, races, and misleading operator experiences.

---

## Prime directive

**ALIGN START WITH REAL STARTUP TRUTH, ELIMINATE THE HALT RACE, HARDEN COMMAND LIFECYCLES, AND MAKE THE DASHBOARD A FULLY RELIABLE OPERATOR SURFACE**

---

## Non-negotiable operating rules

1. **Fix the runtime, not just the UI.**
   The remaining defects are no longer mainly presentation issues; underlying runtime/control-plane behavior must be corrected.

2. **No deceptive Start.**
   If Start is predictably doomed by known prerequisites, it must be blocked or clearly precondition-failed before normal queueing.

3. **No unreliable Halt.**
   Emergency Halt must not lose a state race after being accepted.

4. **No divergence between UI, API, and worker truth.**
   One authoritative command lifecycle must exist.

5. **No weakening of safety gates.**
   Startup/authenticated venue checks must remain real and enforced.

6. **Fail closed.**
   If the system cannot guarantee a safe control result, it must not imply success.

7. **Retest required.**
   A runtime/control-plane fix does not count without re-executing the affected operator flow.

---

## Required remediation order

1. startup truth alignment
2. halt race elimination
3. command lifecycle hardening
4. dashboard/runtime contract alignment
5. full re-test and closure report

Do not skip this order.

---

## Allowed changes

You may change only what is needed for:
- startup truth alignment
- runtime transition correctness
- halt reliability
- authoritative command lifecycle propagation
- dashboard/runtime contract completeness
- focused re-test support

---

## Forbidden changes

Do not:
- weaken startup gates to make Start appear successful
- hide runtime failures behind softer UI wording
- treat queued commands as equivalent to applied commands
- leave halt semantics ambiguous
- broaden into unrelated product work
- redesign the trading system beyond what is required for reliable control-plane behavior

---

## Canonical truth hierarchy for this pass

When deciding what the operator should be told, trust in this order:

1. actual worker/runtime transition truth
2. authoritative backend/API command/result state
3. persisted runtime artifacts where intended
4. UI local state

The dashboard must never outrank runtime truth.

---

## Required issue targets

This pass must fully close:

### High/Critical runtime issues
- Start accepted despite real startup prerequisites failing
- Emergency Halt race causing post-acceptance illegal transition
- any remaining misleading command lifecycle state in UI/API/worker

### Contract/clarity issues
- missing backend contract fields needed for truthful operation
- refresh/reopen gaps that hide or distort command truth

---

## What counts as fully fixed

An issue is fully fixed only if:
1. root cause is identified
2. minimal correct code fix is applied
3. the exact operator flow is re-run
4. expected behavior is now observed
5. evidence is captured

Anything less is partial.

---

## Required final report

The final result must explicitly answer:

1. what caused the startup truth mismatch
2. what caused the halt race
3. what exact changes resolved them
4. whether Start is now honestly blocked or successfully runnable as appropriate
5. whether Halt is now operationally reliable
6. whether UI/API/worker command lifecycles are fully aligned
7. whether any High/Critical issues remain
8. what still needs attention, if anything

---

## Delivery stance

Be strict.
Be minimal.
Be runtime-truth driven.
Do not over-claim.

A successful pass is one where the dashboard no longer merely reports failures honestly, but the remaining core control flows themselves are reliable enough to justify a true top-tier operator trust rating.
