# instruction.md

## Objective

Fix the remaining runtime and control-plane issues completely so the dashboard becomes fully trustworthy, operationally safe, and functionally complete.

The remaining known issues are:

1. **Start cannot reach running**
   - startup/authenticated venue gating fails after Start is accepted
   - API/dashboard truth is still too optimistic before the worker proves startup success

2. **Emergency Halt runtime race**
   - halt can still fail during bootstrapping because the runtime transitions to `stopped` before halt is applied
   - the UI now reports the failure honestly, but the actual runtime behavior is still unsafe

To bring the dashboard to a true top-tier operational standard, this pass must also close any remaining gaps in:

3. **pre-start eligibility truth**
4. **runtime command state machine reliability**
5. **operator safety guarantees for halt/start/stop**
6. **full end-to-end dashboard trust validation after fixes**

This pass is complete only when the dashboard is both:
- **truthful**
- **operationally reliable**

---

## Prime directive

**ELIMINATE THE REMAINING RUNTIME/CONTROL-PLANE FAILURES SO THE DASHBOARD CAN BE TRUSTED AS THE AUTHORITATIVE OPERATIONAL SURFACE**

---

## Non-negotiable rules

1. **Fix the underlying runtime problems, not just the UI messaging.**
   Honest failure reporting is already improved; now the actual behavior must be made reliable.

2. **Start must not be offered as normal when startup success is already knowably blocked.**
   If startup prerequisites are not satisfied, the operator must be blocked or explicitly warned before queueing.

3. **Emergency Halt must be operationally reliable.**
   It must not be vulnerable to a bootstrapping-to-stopped race that causes a failed halt after acceptance.

4. **State-machine truth must be authoritative.**
   API, worker, and UI must agree on runtime transitions and command outcomes.

5. **No weakening of safety gates.**
   Do not bypass authenticated venue reads, readiness checks, or startup gates merely to make Start succeed.

6. **Fail closed.**
   If the runtime cannot guarantee a safe state transition, it must not imply success.

7. **Re-test everything after the runtime fixes.**
   No issue is considered closed without direct re-execution of the previously failing flows.

8. **Minimal but complete changes.**
   Fix the remaining problems end to end, but do not broaden into unrelated product work.

---

## Target outcome: dashboard 10/10 standard

For this pass, “dashboard to 10” means all of the following are true:

1. no false operational truth
2. no misleading control result states
3. no unsafe live/sentinel ambiguity
4. no duplicate or racy command submissions
5. Start is either:
   - successfully brought to running when prerequisites are satisfied, or
   - blocked before queueing with a truthful backend reason
6. Emergency Halt is either:
   - successfully enforced, or
   - blocked before acceptance if impossible
7. UI, API, and worker remain consistent across refresh/reopen
8. dashboard re-test finds no remaining Critical issues and no remaining High issues in core control flows

---

## Required implementation order

Implement in this exact order:

### Phase 1 — Startup truth alignment
### Phase 2 — Runtime transition and halt-race elimination
### Phase 3 — Command lifecycle hardening
### Phase 4 — Dashboard/runtime contract alignment
### Phase 5 — Full end-to-end re-test and closure report

Do not skip phases.

---

## Phase 1 — Startup truth alignment

### Goal
Ensure Start cannot be accepted as normal when runtime startup is already knowably blocked.

### Primary files to inspect and modify
- `apps/worker/src/runtime/start-stop-manager.ts`
- `apps/worker/src/runtime/runtime-state-machine.ts`
- `apps/worker/src/runtime/bot-runtime.ts`
- `apps/worker/src/runtime/live-loop.ts`
- `apps/worker/src/runtime/venue-open-order-heartbeat.service.ts`
- `apps/worker/src/runtime/user-websocket-state.service.ts`
- `apps/api/src/modules/bot-control/bot-control.service.ts`
- `apps/api/src/modules/bot-control/bot-control.controller.ts`
- `apps/api/src/modules/ui/ui.service.ts`
- `apps/web/src/hooks/useBotState.ts`
- `apps/web/src/components/panels/ControlPanel.tsx`

### Required changes
1. Identify exactly why API/backend can expose readiness/startability that is more optimistic than real worker startup truth.

2. Add or refine a backend-visible **pre-start eligibility state** that reflects the real runtime prerequisites needed to reach running.

3. Ensure Start behavior becomes one of only two honest outcomes:
   - **allowed and plausibly runnable**
   - **blocked with explicit backend reason before queueing**

4. If some prerequisites are only knowable at worker/runtime level, propagate that truth back up into the API/dashboard contract.

5. Do not allow “ready” to mean merely “not currently running” if authenticated venue checks or startup dependencies are known to fail.

### Acceptance
- Start is not offered as normal when startup would predictably fail
- blocking reason is surfaced before or immediately at submission
- API/dashboard truth matches worker startup truth

---

## Phase 2 — Runtime transition and halt-race elimination

### Goal
Make Emergency Halt operationally reliable and eliminate the stopped-vs-halt race.

### Primary files to inspect and modify
- `apps/worker/src/runtime/runtime-state-machine.ts`
- `apps/worker/src/runtime/start-stop-manager.ts`
- `apps/worker/src/runtime/bot-runtime.ts`
- `apps/worker/src/runtime/live-loop.ts`
- `apps/api/src/modules/bot-control/bot-control.service.ts`
- `apps/web/src/hooks/useBotState.ts`
- `apps/web/src/components/buttons/EmergencyHaltButton.tsx`
- `apps/web/src/components/panels/ControlPanel.tsx`

### Required changes
1. Identify the exact race that allows:
   - Start accepted
   - runtime falls back to `stopped`
   - Halt accepted or queued
   - Halt later fails with illegal transition

2. Redesign or harden the relevant transition logic so halt semantics are safe and deterministic.

3. Emergency Halt must have one of these truthful models:
   - **preemptive priority command** that wins over normal fallback-to-stopped transitions, or
   - **explicitly blocked** if halt is no longer meaningful in current state

4. Do not allow the operator to believe halt succeeded when runtime semantics make it impossible.

5. Expose a truthful final halt outcome consistently across worker, API, and UI.

### Acceptance
- no accepted halt ends in a race-induced illegal transition
- halt outcome is operationally reliable
- runtime transitions are deterministic and auditable

---

## Phase 3 — Command lifecycle hardening

### Goal
Bring control actions to a fully reliable operator model.

### Primary files to inspect and modify
- `apps/api/src/modules/bot-control/bot-control.repository.ts`
- `apps/api/src/modules/bot-control/bot-control.service.ts`
- `apps/api/src/modules/bot-control/bot-control.controller.ts`
- `apps/web/src/hooks/useBotState.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/components/buttons/StartBotButton.tsx`
- `apps/web/src/components/buttons/StopBotButton.tsx`
- `apps/web/src/components/buttons/EmergencyHaltButton.tsx`
- `apps/web/src/components/panels/ControlPanel.tsx`

### Required changes
1. Standardize command lifecycle semantics for:
   - start
   - stop
   - halt
   - mode switch if relevant

2. Ensure one authoritative lifecycle model exists:
   - idle
   - queued
   - processing
   - applied
   - failed
   - blocked/precondition_failed if appropriate

3. Remove any remaining ambiguity between:
   - accepted
   - queued
   - actually applied

4. Keep duplicate-prevention, disable-in-flight, and latest-result visibility coherent across refresh/reopen.

5. Ensure the operator can always answer:
   - what command was last attempted
   - what happened
   - what state the runtime is actually in now

### Acceptance
- command lifecycle is coherent and consistent across UI/API/worker
- no remaining misleading command states in core controls

---

## Phase 4 — Dashboard/runtime contract alignment

### Goal
Finish the last contract gaps so the dashboard can be trusted as the operational source of truth.

### Primary files to inspect and modify
- `packages/ui-contracts/src/control.ts`
- `packages/ui-contracts/src/dashboard.ts`
- `apps/api/src/modules/ui/dto/dashboard-response.dto.ts`
- `apps/api/src/modules/ui/ui.service.ts`
- `apps/web/src/hooks/useBotState.ts`
- `apps/web/src/components/panels/ControlPanel.tsx`
- `apps/web/src/components/panels/DiagnosticsPanel.tsx`
- any related read-model DTO or adapter surface

### Required changes
1. Ensure the dashboard has explicit fields for:
   - pre-start eligibility
   - pre-start blocking reason
   - latest command result by type
   - halt reliability/final result state
   - stale/offline/current truth state
   - any runtime transition state needed for operators to understand what is happening

2. Remove any remaining places where the dashboard must infer critical operator truth from weak local assumptions.

3. Ensure refresh/reopen preserves truthful backend-driven control status.

### Acceptance
- dashboard contract is sufficient for truthful operation
- control panel no longer depends on unsafe inference

---

## Phase 5 — Full end-to-end re-test and closure report

### Goal
Prove the fixes actually close the remaining High/Critical issues.

### Required re-test list
Re-test at minimum:

1. Start when runtime prerequisites are not satisfied
2. Start when runtime prerequisites are satisfied, if feasible in the environment
3. Emergency Halt during bootstrapping
4. Emergency Halt when runtime is already stopping/stopped
5. Refresh/reopen after command submission
6. Mode switching persistence
7. API outage + recovery behavior
8. dashboard truth vs backend truth after the runtime fixes

### Required final report status labels
For each previously open issue, report:
- fixed
- partially fixed
- still broken
- blocked by environment

### Required final report sections
1. concise remediation summary
2. files added
3. files changed
4. exact root cause of startup truth mismatch
5. exact root cause of halt race
6. startup commands run
7. endpoints exercised
8. re-test results by issue
9. remaining broken flows
10. any still-open Medium/Low issues
11. highest-priority remaining attention list
12. assumptions
13. blockers

---

## Severity model

Use this model consistently for anything still open:

- **Critical** — unsafe control-plane behavior, false state, live/sentinel confusion, impossible to trust
- **High** — core control flow broken, command lifecycle misleading, runtime transition unreliable
- **Medium** — partial functionality, degraded UX, missing operator clarity
- **Low** — minor nuisance or low-risk clarity issue

---

## Final acceptance criteria

This pass is complete only when all are true:

1. Start cannot be queued deceptively when failure is already knowable
2. Emergency Halt no longer fails due to the stopped/halt race
3. command lifecycle is consistent and truthful across UI/API/worker
4. no remaining Critical issues exist in the dashboard/control-plane surface
5. no remaining High issues exist in:
   - Start
   - Stop
   - Halt
   - mode switching
   - backend truth rendering
6. the dashboard re-test supports a practical 10/10 trust rating for the operator surface

---

## Strict scope boundary

Do not add in this pass:
- new trading strategy logic
- unrelated optimization work
- speculative architectural redesign
- convenience threshold tuning
- UI redesign unrelated to control-plane truth and runtime reliability

The target is a **strict final runtime/control-plane remediation pass** that closes the remaining defects completely and makes the dashboard genuinely dependable.
