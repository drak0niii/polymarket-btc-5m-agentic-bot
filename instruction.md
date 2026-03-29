# instruction.md

## Objective

Validate and correct the next real tracked-market runtime blocker:

- preconditions are restored
- real BTC 5m markets are dynamically discovered and loaded
- an active strategy version exists
- the previous tracked-market Invalid URL blocker is fixed
- the previous market-stream REST bootstrap 404 blocker is fixed
- the previous SyncOrderbooksJob Prisma `tickSize` crash is fixed
- the stale-market selection bug behind `orderbook_count = 0` is fixed
- the portfolio refresh/checkpoint path is alive again
- the next real blocker is now:
  - stale control-plane truth
  - old `start` command stuck in `processing`
  - replayed queued `stop` / `halt` commands on worker restart
  - runtime forced into `halted_hard` before a clean rerun

This pass must focus only on that blocker set.

This is **not** a discovery pass.  
This is **not** a strategy activation pass.  
This is **not** a market-stream URL pass.  
This is **not** a REST bootstrap pass.  
This is **not** an orderbook-persistence pass.  
This is **not** a live-trading pass.  
This is a **stale control-plane replay / stuck command lifecycle** pass only.

---

## Prime directive

**FIX ONLY THE EXACT CONTROL-PLANE RESTART / REPLAY / STUCK-COMMAND BLOCKER SO A CLEAN TRACKED-MARKET RERUN CAN BE VALIDATED HONESTLY**

---

## Success definition

This work is complete only when one of these outcomes is proven with evidence.

### Outcome A — stale control-plane replay blocker is fixed
All of the following are true:
1. the exact reason an old `start` command remains stuck in `processing` is identified
2. the exact reason queued `stop` / `halt` commands replay on worker restart is identified
3. the relationship between those symptoms is classified correctly:
   - directly coupled
   - partially coupled
   - independent blockers
4. the exact failing path is identified correctly:
   - repository command-state bug
   - worker restart/recovery replay bug
   - command acknowledgement bug
   - stale active-command selection bug
   - restart bootstrap command reprocessing bug
   - other specific cause
5. the minimum safe fix is made, if justified
6. the worker is re-run
7. runtime/control-plane evidence proves:
   - stale commands are no longer replayed on restart
   - the stuck `start` command is no longer left falsely active
   - a clean fresh `start` can be issued again
8. the report states whether runtime now reaches `bootstrapping` / `running` again or whether the next real blocker surfaced

### Outcome B — blocker remains justified or unresolved
All of the following are true:
1. the exact stale-command / replay cause is identified honestly
2. no unsafe or fake cleanup workaround is introduced
3. the report explains exactly why the clean rerun still cannot proceed

Both are acceptable outcomes if evidenced properly.

---

## Non-negotiable rules

1. **Do not switch to live trading.**
2. **Do not broaden scope.**
   Do not drift into dashboard, settlement, startup-gate redesign, discovery redesign, market-stream redesign, or unrelated runtime work.
3. **Do not fake command cleanup.**
   Command truth must remain accurate and auditable.
4. **Do not silently discard real active commands unless the code path justifies it.**
5. **Do not weaken runtime safety.**
   A real halt/stop request must still be honored correctly when valid.
6. **Keep changes minimal.**
   Fix only the exact control-plane replay / stuck-command lifecycle path.
7. **Use the real worker/control-plane path.**
   This pass is valid only if the worker is rerun and the control plane is re-exercised honestly.

---

## Required execution order

You must execute in this exact order:

### Phase 1 — Confirm the current stale control-plane replay symptoms
### Phase 2 — Trace the stuck `start` command lifecycle
### Phase 3 — Trace restart replay of queued `stop` / `halt` commands
### Phase 4 — Classify the root cause
### Phase 5 — Apply only the minimum safe fix if justified
### Phase 6 — Re-run worker/control-plane truth
### Phase 7 — Attempt one clean fresh `start`
### Phase 8 — Final strict report

Do not skip phases.

---

## Phase 1 — Confirm the current stale control-plane replay symptoms

### Goal
Prove the current runtime/control-plane state is blocked by stale command truth.

### Requirements
Capture fresh evidence for:
- old `start` command still in `processing`
- replayed queued `stop` / `halt` commands on restart, if present
- runtime forced to `halted_hard` or otherwise blocked before clean rerun
- new `start` requests blocked because another command is still considered active

### Acceptance
- the symptoms are freshly proven, not inferred from older logs

---

## Phase 2 — Trace the stuck `start` command lifecycle

### Goal
Determine exactly why the old `start` command remains in `processing`.

### Requirements
Prove:
- where command status changes are persisted
- whether the command was ever acknowledged/applied/failed
- why it never reached a terminal state
- whether selection of “active” commands is stale or incorrect
- whether the worker restart path leaves commands orphaned

### Acceptance
- the stuck-command lifecycle is explicit

---

## Phase 3 — Trace restart replay of queued `stop` / `halt` commands

### Goal
Determine exactly why old `stop` / `halt` commands replay on worker restart.

### Requirements
Prove:
- where pending/processing commands are loaded on worker boot
- how replay selection works
- whether old commands should have become terminal before restart
- whether replay is expected but incorrectly scoped
- whether obsolete commands are being re-run incorrectly

### Acceptance
- the replay path is explicit

---

## Phase 4 — Classify the root cause

### Goal
State the real cause before changing anything.

### Requirements
You must state clearly:
- the exact cause of the stuck `start` command
- the exact cause of replayed `stop` / `halt` commands
- whether they are:
  - directly coupled
  - partially coupled
  - independent
- whether the blocker is:
  - repository state bug
  - worker restart recovery bug
  - command processing bug
  - acknowledgement bug
  - stale active-command query bug
  - mixed cause

### Acceptance
- blocker is explicit and precise

---

## Phase 5 — Apply only the minimum safe fix if justified

### Goal
Correct only what is needed to restore honest control-plane truth and allow one clean rerun.

### Requirements
If safe:
- implement only the minimum correction
- preserve auditability
- preserve real halt/stop/start behavior
- do not hardcode fake terminal states
- do not erase history
- do not bypass real safety commands

If not safe:
- do not change code
- explain exactly why the blocker remains

### Acceptance
- the change is minimal and specific

---

## Phase 6 — Re-run worker/control-plane truth

### Goal
Recompute control-plane truth from a fresh worker run.

### Requirements
Re-run the worker and validate with fresh evidence:
- stale commands are not replayed incorrectly
- old stuck command no longer blocks truthfully invalid new work
- control-plane state reflects real active commands only
- runtime is not forced into `halted_hard` by obsolete replay

Capture:
- worker logs
- API bot-control state
- relevant audit events
- DB truth for command rows

### Acceptance
- post-fix control-plane truth is freshly recomputed

---

## Phase 7 — Attempt one clean fresh `start`

### Goal
Prove whether the control-plane blocker is actually cleared.

### Requirements
Issue one fresh `start` after the fix and validate:
- whether the new start is admitted
- whether it reaches `bootstrapping`
- whether it reaches `running`
- or what exact next blocker appears

### Acceptance
- a real fresh rerun attempt is made and evaluated honestly

---

## Phase 8 — Final strict report

### Required sections
1. concise validation summary
2. files added
3. files changed
4. exact stale control-plane failure before the change
5. exact root cause
6. exact rule/config/code change made, or exact reason no change was safe
7. commands run
8. post-change runtime/control-plane evidence
9. whether stale commands are no longer replayed
10. whether the stuck `start` command is handled truthfully
11. whether a clean fresh `start` can now be issued
12. whether runtime reaches `bootstrapping` / `running`
13. remaining blockers
14. regressions introduced
15. assumptions
16. final tracked-market runtime-readiness verdict

---

## Truthfulness requirements

- do not call the blocker fixed unless the worker is rerun and stale replay no longer occurs on the tested path
- do not claim clean control-plane recovery unless a fresh start can actually be attempted
- do not suppress or erase real command history
- if High/Critical blockers remain, say so plainly

---

## Strict scope boundary

Do not add in this pass:
- live trading enablement
- settlement work
- dashboard work
- startup-gate redesign
- discovery redesign
- market-stream redesign
- unrelated runtime refactors

The target is an **exact stale control-plane replay / stuck command lifecycle pass** only.