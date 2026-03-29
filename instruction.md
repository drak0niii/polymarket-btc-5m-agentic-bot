# instruction.md

## Objective

Validate and correct the next real tracked-market runtime blocker:

- preconditions are restored
- real BTC 5m markets are dynamically discovered and loaded
- an active strategy version exists
- the previous tracked-market Invalid URL blocker is fixed
- the previous market-stream REST bootstrap 404 blocker is fixed
- the next real failure is now:
  - `evaluation_tick_failed`
  - `Invalid prisma.orderbook.create() invocation`
  - `Unknown argument tickSize`

This pass must focus only on that blocker.

This is **not** a discovery pass.
This is **not** a strategy activation pass.
This is **not** a market-stream URL pass.
This is **not** a REST bootstrap pass.
This is **not** a live-trading pass.
This is a **SyncOrderbooksJob / Prisma orderbook schema mismatch** pass only.

---

## Prime directive

**FIX ONLY THE EXACT SYNCORDERBOOKSJOB PRISMA SCHEMA-MISMATCH BLOCKER SO THE TRACKED-MARKET RUNTIME PATH CAN BE VALIDATED HONESTLY**

---

## Success definition

This work is complete only when one of these outcomes is proven with evidence.

### Outcome A — SyncOrderbooksJob schema blocker is fixed
All of the following are true:
1. the exact Prisma write payload that fails is identified
2. the exact Prisma `orderbook` model shape currently accepted by the repo is identified
3. the exact mismatch is classified correctly:
   - obsolete field usage
   - mapper drift
   - missing migration
   - stale generated Prisma client
   - model mismatch
   - other specific cause
4. the minimum safe fix is made, if justified
5. the worker is re-run with real tracked markets
6. runtime evidence proves:
   - the specific `Unknown argument tickSize` failure no longer recurs
   - SyncOrderbooksJob gets past the previous failing write stage
7. the report states whether runtime now remains healthy or whether the next real blocker surfaced

### Outcome B — blocker remains justified or unresolved
All of the following are true:
1. the exact write/model mismatch cause is identified honestly
2. no unsafe or fake workaround is introduced
3. the report explains exactly why the orderbook-sync path still cannot proceed

Both are acceptable outcomes if evidenced properly.

---

## Non-negotiable rules

1. **Do not switch to live trading.**
2. **Do not broaden scope.**
   Do not drift into dashboard, settlement, startup-gate redesign, discovery redesign, or unrelated runtime work.
3. **Do not mask real persistence failures.**
   A real broken orderbook persistence path must still fail.
4. **Do not weaken runtime safety.**
   Do not simply suppress evaluation/orderbook failures to keep runtime alive.
5. **Keep changes minimal.**
   Fix only the exact orderbook write/schema mismatch path.
6. **Use real tracked markets.**
   This pass is valid only if the worker is rerun on the real tracked-market path.

---

## Required execution order

You must execute in this exact order:

### Phase 1 — Confirm the current tracked-market orderbook-sync failure
### Phase 2 — Identify the exact failing Prisma write payload
### Phase 3 — Trace the payload construction path
### Phase 4 — Identify the exact Prisma model/client truth
### Phase 5 — Classify the root cause
### Phase 6 — Apply only the minimum safe fix if justified
### Phase 7 — Re-run worker/runtime truth with real tracked markets
### Phase 8 — Final strict report

Do not skip phases.

---

## Phase 1 — Confirm the current tracked-market orderbook-sync failure

### Goal
Prove the current runtime failure is the SyncOrderbooksJob Prisma write path.

### Requirements
Capture evidence for:
- tracked markets are present
- start is admitted/applied
- runtime reaches the tracked-market evaluation path
- runtime gets past the previous Invalid URL and REST bootstrap blockers
- runtime then fails on:
  - `evaluation_tick_failed`
  - `Invalid prisma.orderbook.create() invocation`
  - `Unknown argument tickSize`

### Acceptance
- the failure is freshly proven, not inferred from older logs

---

## Phase 2 — Identify the exact failing Prisma write payload

### Goal
Find the exact write payload that Prisma rejects.

### Requirements
Prove:
- the exact `create()` or `upsert()` payload used for `orderbook`
- whether `tickSize` is the only invalid field or merely the first surfaced invalid field
- which job/service constructs the payload

### Acceptance
- the exact failing payload is captured or reconstructed precisely

---

## Phase 3 — Trace the payload construction path

### Goal
Find where the bad orderbook payload comes from.

### Requirements
Inspect only the exact orderbook-sync path, including as relevant:
- `SyncOrderbooksJob`
- orderbook snapshot/mapper services
- market-data ingestion
- persistence repository/service
- domain-to-Prisma mapping layer
- any write helpers or DTO translators

You must answer:
1. where is the payload built?
2. where does `tickSize` come from?
3. are there adjacent fields likely to fail next?
4. is the mismatch caused by stale mapper logic, stale schema, stale client, or another path?

### Acceptance
- the payload construction path is understood precisely

---

## Phase 4 — Identify the exact Prisma model/client truth

### Goal
Find what the repository actually allows right now.

### Requirements
Inspect:
- Prisma schema for `orderbook`
- generated Prisma client truth
- whether migrations/schema generation are in sync
- whether runtime is using a stale generated client

You must answer:
1. does the current Prisma schema define `tickSize`?
2. does the generated client accept `tickSize`?
3. is this a schema drift issue or a mapper issue?

### Acceptance
- the write target truth is explicit

---

## Phase 5 — Classify the root cause

### Goal
State the real cause before changing anything.

### Requirements
You must state clearly:
- the exact root cause of the `tickSize` failure
- whether it is:
  - obsolete field usage
  - mapper drift
  - missing migration
  - stale generated client
  - schema mismatch
  - mixed cause

### Acceptance
- blocker is explicit and precise

---

## Phase 6 — Apply only the minimum safe fix if justified

### Goal
Correct only what is needed to make the tracked-market orderbook-sync path valid.

### Requirements
If safe:
- implement only the minimum correction
- preserve real persistence failure detection
- preserve degrade/halt behavior for real failures
- do not hardcode fake success

If not safe:
- do not change code
- explain exactly why the blocker remains

### Acceptance
- the change is minimal and specific

---

## Phase 7 — Re-run worker/runtime truth with real tracked markets

### Goal
Recompute runtime truth from a fresh worker run.

### Requirements
Re-run the worker and validate with fresh evidence:
- tracked markets are still present
- runtime reaches orderbook sync/evaluation
- the `Unknown argument tickSize` failure no longer occurs, if fixed
- SyncOrderbooksJob behavior after the fix
- runtime state after the fix:
  - running
  - degraded
  - reconciliation_only
  - cancel_only
  - halted_hard

Capture:
- worker logs
- API bot-control state
- relevant audit events
- orderbook persistence evidence

### Acceptance
- post-fix runtime truth is freshly recomputed

---

## Phase 8 — Final strict report

### Required sections
1. concise validation summary
2. files added
3. files changed
4. exact tracked-market orderbook-sync failure before the change
5. exact root cause
6. exact rule/config/code change made, or exact reason no change was safe
7. commands run
8. post-change runtime evidence
9. whether orderbook sync now succeeds
10. whether runtime now remains running
11. remaining blockers
12. regressions introduced
13. assumptions
14. final tracked-market runtime-readiness verdict

---

## Truthfulness requirements

- do not call the blocker fixed unless the worker is rerun and the specific `Unknown argument tickSize` failure no longer occurs
- do not claim runtime is healthy unless the tracked-market path is freshly exercised
- do not suppress real persistence failures
- if High/Critical blockers remain, say so plainly

---

## Strict scope boundary

Do not add in this pass:
- live trading enablement
- settlement work
- dashboard work
- startup-gate redesign
- discovery redesign unrelated to orderbook sync
- unrelated runtime refactors

The target is an **exact SyncOrderbooksJob / Prisma schema mismatch pass** only.