# AGENTS.md

## Repository mission for this pass

This pass exists to answer one narrow question:

**Why does the tracked-market runtime path fail in SyncOrderbooksJob with `Invalid prisma.orderbook.create() invocation` and `Unknown argument tickSize`, and can that exact blocker be corrected safely?**

This pass is not for live trading.
This pass is not for settlement.
This pass is not for dashboard work.
This pass is not for discovery/strategy activation beyond using their already-restored state.
This pass is not for the previous Invalid URL bug, which is already fixed.
This pass is not for the previous REST bootstrap 404 bug, which is already fixed.

---

## Prime directive

**FIX ONLY THE EXACT SYNCORDERBOOKSJOB PRISMA ORDERBOOK SCHEMA-MISMATCH BLOCKER WHILE PRESERVING REAL RUNTIME SAFETY**

---

## Non-negotiable operating rules

1. **Use the real tracked-market path.**
   This pass is only valid if real tracked markets are present and the worker is rerun.

2. **Do not fake persistence success.**
   Orderbook sync must succeed through the repository’s real write path.

3. **Do not weaken failure handling.**
   Real persistence faults must still degrade or halt correctly.

4. **Do not broaden scope.**
   Touch only the exact orderbook write/schema/mapping/client path needed.

5. **Minimal changes only.**
   Fix only the schema-mismatch blocker.

6. **Truth over convenience.**
   If the next real blocker appears after fixing this one, report it honestly.

---

## Required order

1. confirm the current tracked-market orderbook-sync failure
2. identify the exact failing Prisma payload
3. trace the payload construction path
4. inspect the exact Prisma schema/client truth
5. identify the exact root cause
6. apply only the minimum safe fix if justified
7. rerun worker/runtime truth
8. report strictly

Do not skip steps.

---

## What must be proven

### Path A — blocker fixed
A successful pass proves:
- the exact Prisma write/model mismatch was identified
- the minimum safe fix was applied
- the worker was rerun with real tracked markets
- the specific `Unknown argument tickSize` failure no longer occurs
- runtime truth after that is reported honestly

### Path B — blocker still unresolved
A successful pass also exists if it proves:
- the exact mismatch cause remains blocked
- no fake workaround was introduced
- the tracked-market runtime path still cannot proceed honestly

---

## Allowed actions

You may:
- inspect worker logs and audit evidence
- inspect SyncOrderbooksJob and related orderbook write code
- inspect Prisma schema and generated client truth
- inspect env/config only if it directly affects this exact path
- make a minimal safe fix if justified
- rerun the worker and capture fresh evidence

---

## Forbidden actions

Do not:
- suppress orderbook-sync failures just to keep runtime alive
- hardcode fake DB writes as a deceptive success path
- broaden into live trading, settlement, dashboard, or unrelated runtime refactors
- claim success without rerunning the worker
- claim runtime health from the no-market case

---

## Truth hierarchy for this pass

Trust in this order:

1. fresh worker/runtime evidence on the tracked-market path
2. exact Prisma schema/client truth
3. exact orderbook write payload evidence
4. API bot-control state
5. audit events
6. assumptions

---

## Required final report must answer

1. what exact Prisma write payload failed?
2. where was that payload constructed?
3. what does the current Prisma `orderbook` model actually accept?
4. was the fault obsolete field usage, mapper drift, missing migration, stale client, schema mismatch, or mixed?
5. what exact change was made, if any?
6. does orderbook sync now succeed?
7. does runtime now remain running?
8. if not, what exact blocker surfaced next?

---

## Delivery stance

Be narrow.
Be evidence-based.
Be runtime-safety-first.
Do not over-claim.

A successful pass is one where the system either truly clears the SyncOrderbooksJob schema blocker or isolates it honestly.