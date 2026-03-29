# AGENTS.md

## Repository mission for this pass

This pass exists to answer one narrow question:

**Why does the tracked-market rerun remain blocked by stale control-plane truth — specifically an old `start` command stuck in `processing` and replayed queued `stop` / `halt` commands on worker restart — and can that exact blocker be corrected safely?**

This pass is not for live trading.
This pass is not for settlement.
This pass is not for dashboard work.
This pass is not for discovery/strategy activation beyond using their already-restored state.
This pass is not for the previous Invalid URL bug, which is already fixed.
This pass is not for the previous REST bootstrap 404 bug, which is already fixed.
This pass is not for the previous Prisma `tickSize` client mismatch, which is already fixed.
This pass is not for the stale-market selection bug, which is already fixed.

---

## Prime directive

**FIX ONLY THE EXACT CONTROL-PLANE RESTART / REPLAY / STUCK-COMMAND BLOCKER WHILE PRESERVING REAL RUNTIME SAFETY AND AUDIT TRUTH**

---

## Non-negotiable operating rules

1. **Use the real worker/control-plane path.**
   This pass is only valid if the worker is rerun and the real control plane is exercised again.

2. **Do not fake command completion.**
   Command rows must remain truthful and auditable.

3. **Do not erase history.**
   Historical command truth must be preserved.

4. **Do not weaken real halt/stop safety.**
   Valid stop/halt commands must still work.

5. **Do not broaden scope.**
   Touch only the exact command lifecycle / replay / restart recovery path needed.

6. **Minimal changes only.**
   Fix only the blocker in scope.

7. **Truth over convenience.**
   If the next real blocker appears after fixing this one, report it honestly.

---

## Required order

1. confirm the current stale replay symptoms
2. trace the stuck `start` lifecycle
3. trace replay of old `stop` / `halt` on restart
4. identify the exact root cause
5. apply only the minimum safe fix if justified
6. rerun worker/control-plane truth
7. attempt one clean fresh `start`
8. report strictly

Do not skip steps.

---

## What must be proven

### Path A — blocker fixed
A successful pass proves:
- the exact reason the old `start` remained stuck was identified
- the exact reason obsolete `stop` / `halt` commands replayed was identified
- the minimum safe fix was applied
- the worker was rerun
- stale commands are no longer replayed incorrectly
- the stuck `start` no longer blocks a fresh rerun dishonestly
- one clean fresh `start` can be issued again
- runtime truth after that is reported honestly

### Path B — blocker still unresolved
A successful pass also exists if it proves:
- the exact replay/stuck-command cause remains blocked
- no fake workaround was introduced
- the tracked-market rerun still cannot proceed honestly

---

## Allowed actions

You may:
- inspect worker logs and audit evidence
- inspect command repository/service/runtime-control code
- inspect restart recovery / bootstrap command processing
- inspect DB truth for runtime command rows
- make a minimal safe fix if justified
- rerun the worker and capture fresh evidence
- issue one clean fresh `start` after the fix

---

## Forbidden actions

Do not:
- delete or rewrite command history deceptively
- hardcode fake terminal states without justified lifecycle logic
- suppress halt/stop commands just to keep runtime alive
- broaden into live trading, settlement, dashboard, or unrelated runtime refactors
- claim success without rerunning the worker
- claim clean recovery without attempting a fresh start

---

## Truth hierarchy for this pass

Trust in this order:

1. fresh worker/runtime evidence on the restart/replay path
2. DB truth for runtime command rows
3. exact command lifecycle / processing path evidence
4. API bot-control state
5. audit events
6. assumptions

---

## Required final report must answer

1. why was the old `start` command stuck in `processing`?
2. why were old `stop` / `halt` commands replayed on restart?
3. are those two symptoms coupled or independent?
4. what exact change was made, if any?
5. are stale commands no longer replayed?
6. is the stuck `start` now handled truthfully?
7. can a clean fresh `start` now be issued?
8. does runtime now reach `bootstrapping` / `running` again?
9. if not, what exact blocker surfaced next?

---

## Delivery stance

Be narrow.
Be evidence-based.
Be runtime-safety-first.
Do not over-claim.

A successful pass is one where the system either truly clears the stale control-plane replay blocker or isolates it honestly.