# AGENTS.md

## Repository mission

This repository exists to become a real, production-oriented, capital-protective, fully autonomous Polymarket trading system for BTC 5-minute markets.

The system is not a toy, not a dashboard-only project, and not a research-only sandbox.
Its target end state is a live trading engine that:
- discovers valid live opportunities on Polymarket
- builds and validates edge
- executes orders correctly against real venue constraints
- reconciles venue truth continuously
- protects capital with explicit controls
- learns safely from realized outcomes
- improves over time without uncontrolled drift

The primary objective is:

**MAXIMIZE LONG-TERM RISK-ADJUSTED PORTFOLIO GROWTH WITHOUT VIOLATING CAPITAL SAFETY OR REPLAYABILITY**

Do not pursue growth by inventing venue behavior, weakening safeguards, or hiding uncertainty.

---

## Required operating mindset

Always treat this repository as an incomplete but serious attempt to build a real autonomous trading system.

Always prefer:
- correctness over speed
- explicit state over implicit behavior
- replayability over convenience
- hard evidence over narrative
- capital protection over aggressiveness
- deterministic control over hidden adaptation

Never assume a module is production-grade just because tests pass.
Always inspect whether behavior is:
- connected to the real live path
- grounded in real venue behavior
- durable across restart
- safe under degraded conditions
- explainable after the fact

---

## Codex behavior rules

### 1. Do not drift from the repository mission
Every change must make the system more capable as a real autonomous Polymarket trader, not merely more complex.

### 2. Do not hide logic in the live path
Do not introduce silent adaptive logic directly inside:
- signal generation
- trade evaluation
- order execution
- reconciliation

If behavior changes over time, that change must come through explicit learning state, explicit policy, explicit lineage, and explicit rollout/rollback controls.

### 3. Do not duplicate canonical domain types
When a canonical type file exists, import from it.
Do not redefine equivalent interfaces in other modules.

Examples for Phase 11:
- `packages/domain/src/learning-state.ts`
- `packages/domain/src/strategy-variant.ts`
- `packages/domain/src/version-lineage.ts`

### 4. Do not bypass auditability
Every material adaptive decision must be:
- typed
- logged
- replayable
- attributable to stored evidence
- reversible

### 5. Do not widen scope opportunistically
Complete the requested wave fully before expanding into adjacent architecture.
Do not invent new frameworks or abstractions unless they materially simplify Phase 11 implementation.

### 6. Prefer extension over rewrite
Unless the current structure fundamentally blocks the mission, extend and tighten existing modules instead of rewriting large sections of the repo.

### 7. Keep module boundaries clean
Do not introduce deep fragile cross-package imports.
Prefer package entry points or stable internal boundaries.

### 8. Always preserve live-trading safety
Any change that weakens readiness gating, venue validation, reconciliation, or exposure controls is a regression unless explicitly required and replaced by something stronger.

---

## Phase 11 execution order

Implement Phase 11 in this exact order and do not skip ahead.

### Wave 1 — Minimum viable self-improvement
Build the backbone first:
1. canonical learning-state types
2. learning-state store
3. learning-event log
4. real daily learning-cycle job
5. deterministic learning-cycle runner
6. regime-aware attribution
7. edge decay detector
8. live calibration store
9. live calibration updater
10. confidence shrinkage policy

### Wave 2 — Controlled strategy evolution
Only after Wave 1 verifies:
11. canonical strategy-variant types
12. champion-challenger manager
13. shadow evaluation engine
14. promotion decision engine
15. strategy quarantine policy
16. strategy deployment registry
17. rollout controller
18. rollback controller

### Wave 3 — Execution learning
19. execution learning store
20. execution policy updater
21. adaptive maker-taker policy
22. adverse selection monitor
23. execution policy version store

### Wave 4 — Portfolio learning
24. portfolio learning state
25. capital allocation engine
26. strategy correlation monitor
27. allocation promotion gate

### Wave 5 — Lineage, venue learning, inspectability, tests
28. canonical version-lineage types
29. version-lineage registry
30. decision replay context
31. venue health learning store
32. venue uncertainty detector
33. venue mode policy
34. operator commands
35. integration tests

---

## Hard implementation rules for Phase 11

### Learning
- No uncontrolled online learning.
- No self-modifying live code.
- No hidden parameter drift.
- All learning outputs must be persisted and versioned.

### Promotion
- Never promote on raw PnL alone.
- Promotion requires multi-factor evidence:
  - sample sufficiency
  - calibration health
  - execution health
  - realized-vs-expected consistency
  - rollback criteria

### Quarantine
- Prefer precise quarantine by:
  - variant
  - regime
  - market context
- Use full halt only for system or venue integrity threats.

### Replayability
- Every learned behavior change must answer:
  - what changed
  - why it changed
  - what evidence justified it
  - which versions were active
  - what rollback condition applies

### Persistence
- State must survive restart.
- Writes must be atomic where applicable.
- Event logs must be append-only.

---

## Required working style

For each implementation chunk:
1. inspect the existing repo structure first
2. identify the canonical insertion points
3. add or modify the minimum files needed
4. wire the new module into real execution paths
5. add or update tests
6. run verification commands
7. report exactly what changed and what remains

Do not claim completion if files exist but are not wired.
Do not claim success if only typecheck passes but runtime integration is missing.
Do not claim self-improvement if the system still only measures without adapting safely.

---

## Definition of acceptable completion for any Phase 11 step

A step is complete only if:
- the target file exists
- the exported interface is explicit and typed
- the module is wired into the appropriate runtime path
- persistence and replay implications are handled
- verification commands pass
- no duplicate canonical types were introduced
- the change materially advances the repository toward safe autonomous self-improvement

---

## Output format Codex should follow after each work block

After completing a block of work, report in this structure:

### Changed files
- list exact file paths changed or created

### What was implemented
- concise factual summary of the implemented behavior

### What is now true
- operational statements that are now true because of the change

### Verification run
- exact commands executed
- pass/fail status
- notable warnings or limitations

### Remaining work
- next steps from the Phase 11 order only

---

## Anti-drift reminders

Do not:
- invent new unrelated subsystems
- rewrite the architecture for style reasons
- add black-box ML claims without deployment controls
- add mock-only improvement loops and call them autonomy
- skip persistence
- skip lineage
- skip rollback
- skip quarantine
- skip verification

If forced to choose, prefer a smaller but fully wired, fully auditable implementation over a broader but partially connected one.

---

## Final standard

The repository should move from:
- automated live trader with strong controls

toward:
- governed, replayable, rollback-safe, self-improving autonomous Polymarket trader

Any change that does not clearly support that transition is out of scope.
