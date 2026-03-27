import { createHash } from 'crypto';
import type {
  LearningEvent,
  StrategyDeploymentRegistryState,
  StrategyPromotionDecision,
  StrategyRollbackRecord,
  StrategyRolloutRecord,
  StrategyRolloutStage,
  StrategyVariantEvaluationMode,
  StrategyVariantRecord,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface StrategySignalAssignment {
  variantId: string | null;
  strategyVersionId: string | null;
  stage: StrategyRolloutStage;
  allocationPct: number;
  bucketKey: string;
  reasonCodes: string[];
}

export interface StrategyExecutionRolloutControls {
  variantId: string | null;
  stage: StrategyRolloutStage;
  sizeMultiplier: number;
  blocked: boolean;
  reasonCodes: string[];
}

export interface StrategyRolloutMutationResult {
  registry: StrategyDeploymentRegistryState;
  event: LearningEvent | null;
}

export class StrategyRolloutController {
  resolveSignalAssignment(
    registry: StrategyDeploymentRegistryState,
    input: { marketId: string; observedAt: string },
  ): StrategySignalAssignment {
    const now = new Date();
    const incumbent = registry.incumbentVariantId
      ? registry.variants[registry.incumbentVariantId] ?? null
      : null;
    const bucketKey = `${input.marketId}:${input.observedAt.slice(0, 16)}`;
    const activeRollout = registry.activeRollout;

    if (!incumbent) {
      return {
        variantId: null,
        strategyVersionId: null,
        stage: 'shadow_only',
        allocationPct: 0,
        bucketKey,
        reasonCodes: ['no_incumbent_variant_registered'],
      };
    }

    if (variantIsBlocked(incumbent, now)) {
      return {
        variantId: null,
        strategyVersionId: null,
        stage: activeRollout?.stage ?? incumbent.rolloutStage,
        allocationPct: 0,
        bucketKey,
        reasonCodes: ['incumbent_variant_quarantined'],
      };
    }

    if (!activeRollout || !activeRollout.challengerVariantId) {
      return {
        variantId: incumbent.variantId,
        strategyVersionId: incumbent.strategyVersionId,
        stage: normalizeStage(incumbent.rolloutStage),
        allocationPct: effectiveAllocationPct(incumbent),
        bucketKey,
        reasonCodes:
          incumbent.status === 'probation' || isProbationActive(incumbent, now)
            ? ['incumbent_on_probation']
            : ['incumbent_only'],
      };
    }

    const challenger = registry.variants[activeRollout.challengerVariantId] ?? null;
    if (
      !challenger ||
      variantIsBlocked(challenger, now) ||
      normalizeStage(activeRollout.stage) === 'shadow_only' ||
      normalizeStage(activeRollout.stage) === 'paper' ||
      activeRollout.challengerAllocationPct <= 0
    ) {
      return {
        variantId: incumbent.variantId,
        strategyVersionId: incumbent.strategyVersionId,
        stage: normalizeStage(activeRollout.stage),
        allocationPct: effectiveAllocationPct(incumbent),
        bucketKey,
        reasonCodes: ['challenger_not_live'],
      };
    }

    if (normalizeStage(activeRollout.stage) === 'scaled_live') {
      return {
        variantId: challenger.variantId,
        strategyVersionId: challenger.strategyVersionId,
        stage: normalizeStage(activeRollout.stage),
        allocationPct: 1,
        bucketKey,
        reasonCodes: ['full_challenger_rollout'],
      };
    }

    const score = stableUnitInterval(activeRollout.rolloutSalt, bucketKey);
    if (score < activeRollout.challengerAllocationPct) {
      return {
        variantId: challenger.variantId,
        strategyVersionId: challenger.strategyVersionId,
        stage: normalizeStage(activeRollout.stage),
        allocationPct: activeRollout.challengerAllocationPct,
        bucketKey,
        reasonCodes: ['bounded_challenger_assignment'],
      };
    }

    return {
      variantId: incumbent.variantId,
      strategyVersionId: incumbent.strategyVersionId,
      stage: normalizeStage(activeRollout.stage),
      allocationPct: Math.max(0, 1 - activeRollout.challengerAllocationPct),
      bucketKey,
      reasonCodes: ['incumbent_retained_for_bucket'],
    };
  }

  getExecutionControls(
    registry: StrategyDeploymentRegistryState,
    input: { strategyVersionId: string | null },
  ): StrategyExecutionRolloutControls {
    const now = new Date();
    const variant =
      input.strategyVersionId == null
        ? null
        : Object.values(registry.variants).find(
            (candidate) => candidate.strategyVersionId === input.strategyVersionId,
          ) ?? null;
    if (!variant) {
      return {
        variantId: null,
        stage: 'scaled_live',
        sizeMultiplier: 1,
        blocked: false,
        reasonCodes: ['strategy_variant_untracked'],
      };
    }

    if (variantIsBlocked(variant, now)) {
      return {
        variantId: variant.variantId,
        stage: normalizeStage(variant.rolloutStage),
        sizeMultiplier: 0,
        blocked: true,
        reasonCodes: ['strategy_variant_quarantined'],
      };
    }

    const activeRollout = registry.activeRollout;
    if (
      activeRollout &&
      activeRollout.challengerVariantId === variant.variantId &&
      (normalizeStage(activeRollout.stage) === 'shadow_only' ||
        normalizeStage(activeRollout.stage) === 'paper')
    ) {
      return {
        variantId: variant.variantId,
        stage: normalizeStage(activeRollout.stage),
        sizeMultiplier: 0,
        blocked: true,
        reasonCodes: ['shadow_only_variant_not_live'],
      };
    }

    if (activeRollout && activeRollout.challengerVariantId === variant.variantId) {
      return {
        variantId: variant.variantId,
        stage: normalizeStage(activeRollout.stage),
        sizeMultiplier: activeRollout.challengerAllocationPct,
        blocked: false,
        reasonCodes:
          variant.status === 'probation' || isProbationActive(variant, now)
            ? ['challenger_rollout_size_bound', 'variant_probation_active']
            : ['challenger_rollout_size_bound'],
      };
    }

    const stage = normalizeStage(variant.rolloutStage);
    return {
      variantId: variant.variantId,
      stage,
      sizeMultiplier: effectiveAllocationPct(variant),
      blocked: stage === 'shadow_only' || stage === 'paper',
      reasonCodes:
        variant.status === 'probation' || isProbationActive(variant, now)
          ? ['incumbent_or_shadow_variant', 'variant_probation_active']
          : ['incumbent_or_shadow_variant'],
    };
  }

  applyPromotionDecision(input: {
    registry: StrategyDeploymentRegistryState;
    decision: StrategyPromotionDecision;
    cycleId: string;
    now?: Date;
  }): StrategyRolloutMutationResult {
    const now = input.now ?? new Date();
    const nextRegistry = cloneRegistry(input.registry, now);
    nextRegistry.lastPromotionDecision = input.decision;

    if (!input.decision.candidateVariantId) {
      return { registry: nextRegistry, event: null };
    }

    const candidate = nextRegistry.variants[input.decision.candidateVariantId];
    if (!candidate) {
      return { registry: nextRegistry, event: null };
    }

    if (input.decision.verdict === 'reject' || input.decision.verdict === 'shadow_only') {
      nextRegistry.variants[candidate.variantId] = updateVariant(candidate, {
        status: candidate.status === 'retired' ? 'retired' : 'shadow',
        evaluationMode: 'shadow_only',
        rolloutStage: 'shadow_only',
        capitalAllocationPct: 0,
        promotionReasonCodes: [...input.decision.reasons],
        updatedAt: now.toISOString(),
      });
      if (nextRegistry.activeRollout?.challengerVariantId === candidate.variantId) {
        nextRegistry.activeRollout = null;
      }
      return { registry: nextRegistry, event: null };
    }

    if (input.decision.verdict === 'canary') {
      const targetStage = nextAllowedStage(candidate.rolloutStage, input.decision.targetRolloutStage);
      const incumbentVariantId = nextRegistry.incumbentVariantId;
      nextRegistry.activeRollout = buildRolloutRecord({
        incumbentVariantId,
        challengerVariantId: candidate.variantId,
        stage: targetStage,
        appliedReason: input.decision.reasons.join(','),
        appliedAt: now.toISOString(),
      });
      nextRegistry.variants[candidate.variantId] = updateVariant(candidate, {
        status: 'canary',
        evaluationMode: evaluationModeForStage(targetStage),
        rolloutStage: targetStage,
        capitalAllocationPct: stageAllocationPct(targetStage),
        promotionReasonCodes: [...input.decision.reasons],
        demotionReasonCodes: [],
        quarantineUntil: null,
        updatedAt: now.toISOString(),
      });
      return {
        registry: nextRegistry,
        event: buildRolloutEvent(input.cycleId, nextRegistry.activeRollout, now),
      };
    }

    if (input.decision.verdict === 'promote') {
      const targetStage = nextAllowedStage(candidate.rolloutStage, input.decision.targetRolloutStage);
      const previousIncumbentId = nextRegistry.incumbentVariantId;
      if (previousIncumbentId && nextRegistry.variants[previousIncumbentId]) {
        nextRegistry.variants[previousIncumbentId] = updateVariant(
          nextRegistry.variants[previousIncumbentId]!,
          {
            status: 'shadow',
            evaluationMode: 'shadow_only',
            rolloutStage: 'shadow_only',
            capitalAllocationPct: 0,
            updatedAt: now.toISOString(),
          },
        );
      }
      nextRegistry.incumbentVariantId = candidate.variantId;
      nextRegistry.variants[candidate.variantId] = updateVariant(candidate, {
        status: 'incumbent',
        evaluationMode: evaluationModeForStage(targetStage),
        rolloutStage: targetStage,
        capitalAllocationPct: stageAllocationPct(targetStage),
        promotionReasonCodes: [...input.decision.reasons],
        demotionReasonCodes: [],
        quarantineUntil: null,
        updatedAt: now.toISOString(),
      });
      nextRegistry.activeRollout = buildRolloutRecord({
        incumbentVariantId: previousIncumbentId,
        challengerVariantId: candidate.variantId,
        stage: targetStage,
        appliedReason: input.decision.reasons.join(','),
        appliedAt: now.toISOString(),
      });
      return {
        registry: nextRegistry,
        event: buildRolloutEvent(input.cycleId, nextRegistry.activeRollout, now),
      };
    }

    if (input.decision.verdict === 'rollback') {
      return this.applyLiveDemotionDecision({
        registry: nextRegistry,
        variantId: candidate.variantId,
        decision: {
          action: 'demote',
          reasonCodes: [...input.decision.reasons],
          quarantineUntil: null,
        },
        cycleId: input.cycleId,
        now,
      });
    }

    return { registry: nextRegistry, event: null };
  }

  applyLiveDemotionDecision(input: {
    registry: StrategyDeploymentRegistryState;
    variantId: string;
    decision: {
      action: 'none' | 'probation' | 'demote' | 'quarantine';
      reasonCodes: string[];
      quarantineUntil: string | null;
    };
    cycleId: string;
    now?: Date;
  }): StrategyRolloutMutationResult {
    const now = input.now ?? new Date();
    if (input.decision.action === 'none') {
      return { registry: input.registry, event: null };
    }

    const nextRegistry = cloneRegistry(input.registry, now);
    const variant = nextRegistry.variants[input.variantId] ?? null;
    if (!variant) {
      return { registry: nextRegistry, event: null };
    }

    if (input.decision.action === 'quarantine') {
      nextRegistry.variants[input.variantId] = updateVariant(variant, {
        status: 'quarantined',
        evaluationMode: 'shadow_only',
        rolloutStage: 'shadow_only',
        capitalAllocationPct: 0,
        demotionReasonCodes: [...input.decision.reasonCodes],
        quarantineUntil: input.decision.quarantineUntil,
        updatedAt: now.toISOString(),
      });
      if (nextRegistry.activeRollout?.challengerVariantId === input.variantId) {
        nextRegistry.activeRollout = null;
      }
      return {
        registry: nextRegistry,
        event: buildRolloutEvent(
          input.cycleId,
          buildRolloutRecord({
            incumbentVariantId: nextRegistry.incumbentVariantId,
            challengerVariantId: input.variantId,
            stage: 'shadow_only',
            appliedReason: input.decision.reasonCodes.join(','),
            appliedAt: now.toISOString(),
          }),
          now,
        ),
      };
    }

    const nextStage =
      input.decision.action === 'demote'
        ? previousAllowedStage(variant.rolloutStage)
        : clampProbationStage(variant.rolloutStage);
    nextRegistry.variants[input.variantId] = updateVariant(variant, {
      status: 'probation',
      evaluationMode: evaluationModeForStage(nextStage),
      rolloutStage: nextStage,
      capitalAllocationPct: stageAllocationPct(nextStage),
      demotionReasonCodes: [...input.decision.reasonCodes],
      quarantineUntil: input.decision.quarantineUntil,
      updatedAt: now.toISOString(),
    });
    if (nextRegistry.activeRollout?.challengerVariantId === input.variantId) {
      nextRegistry.activeRollout = buildRolloutRecord({
        incumbentVariantId: nextRegistry.activeRollout.incumbentVariantId,
        challengerVariantId: input.variantId,
        stage: nextStage,
        appliedReason: input.decision.reasonCodes.join(','),
        appliedAt: now.toISOString(),
      });
    }
    return {
      registry: nextRegistry,
      event: buildRolloutEvent(
        input.cycleId,
        buildRolloutRecord({
          incumbentVariantId: nextRegistry.incumbentVariantId,
          challengerVariantId: input.variantId,
          stage: nextStage,
          appliedReason: input.decision.reasonCodes.join(','),
          appliedAt: now.toISOString(),
        }),
        now,
      ),
    };
  }

  applyRollback(input: {
    registry: StrategyDeploymentRegistryState;
    rollback: StrategyRollbackRecord;
    cycleId: string;
    now?: Date;
  }): StrategyRolloutMutationResult {
    const now = input.now ?? new Date();
    const nextRegistry = cloneRegistry(input.registry, now);
    const targetVariant =
      input.rollback.toVariantId != null
        ? nextRegistry.variants[input.rollback.toVariantId] ?? null
        : null;
    const failedVariant = nextRegistry.variants[input.rollback.fromVariantId] ?? null;

    if (failedVariant) {
      nextRegistry.variants[failedVariant.variantId] = updateVariant(failedVariant, {
        status: failedVariant.status === 'quarantined' ? 'quarantined' : 'shadow',
        evaluationMode: 'shadow_only',
        rolloutStage: 'shadow_only',
        capitalAllocationPct: 0,
        updatedAt: now.toISOString(),
      });
    }
    if (targetVariant) {
      nextRegistry.incumbentVariantId = targetVariant.variantId;
      nextRegistry.variants[targetVariant.variantId] = updateVariant(targetVariant, {
        status: 'incumbent',
        evaluationMode: 'full',
        rolloutStage: 'scaled_live',
        capitalAllocationPct: 1,
        updatedAt: now.toISOString(),
      });
    }
    nextRegistry.activeRollout = null;
    nextRegistry.lastRollback = input.rollback;

    return {
      registry: nextRegistry,
      event: {
        id: `${input.cycleId}:rollback:${input.rollback.rollbackId}`,
        type: 'strategy_rollback_triggered',
        severity: 'critical',
        createdAt: now.toISOString(),
        cycleId: input.cycleId,
        strategyVariantId: input.rollback.fromVariantId,
        contextKey: null,
        summary: `Strategy rollback triggered for ${input.rollback.fromVariantId}.`,
        details: input.rollback as unknown as Record<string, unknown>,
      },
    };
  }
}

export function stageAllocationPct(stage: StrategyRolloutStage): number {
  switch (normalizeStage(stage)) {
    case 'shadow_only':
      return 0;
    case 'paper':
      return 0;
    case 'canary':
      return 0.05;
    case 'cautious_live':
      return 0.25;
    case 'scaled_live':
      return 1;
  }
  return 0;
}

function evaluationModeForStage(stage: StrategyRolloutStage): StrategyVariantEvaluationMode {
  switch (normalizeStage(stage)) {
    case 'shadow_only':
    case 'paper':
      return 'shadow_only';
    case 'canary':
      return 'canary';
    case 'cautious_live':
      return 'partial';
    case 'scaled_live':
      return 'full';
  }
  return 'shadow_only';
}

function buildRolloutRecord(input: {
  incumbentVariantId: string | null;
  challengerVariantId: string;
  stage: StrategyRolloutStage;
  appliedReason: string;
  appliedAt: string;
}): StrategyRolloutRecord {
  const normalizedStage = normalizeStage(input.stage);
  return {
    incumbentVariantId: input.incumbentVariantId,
    challengerVariantId: input.challengerVariantId,
    stage: normalizedStage,
    challengerAllocationPct: stageAllocationPct(normalizedStage),
    rolloutSalt: createHash('sha256')
      .update(`${input.challengerVariantId}:${input.appliedAt}:${normalizedStage}`)
      .digest('hex')
      .slice(0, 16),
    appliedReason: input.appliedReason,
    appliedAt: input.appliedAt,
  };
}

function buildRolloutEvent(
  cycleId: string,
  rollout: StrategyRolloutRecord | null,
  now: Date,
): LearningEvent | null {
  if (!rollout) {
    return null;
  }
  return {
    id: `${cycleId}:rollout:${rollout.challengerVariantId}:${rollout.stage}`,
    type: 'strategy_rollout_changed',
    severity: normalizeStage(rollout.stage) === 'scaled_live' ? 'warning' : 'info',
    createdAt: now.toISOString(),
    cycleId,
    strategyVariantId: rollout.challengerVariantId,
    contextKey: null,
    summary: `Strategy rollout moved to ${rollout.stage}.`,
    details: rollout as unknown as Record<string, unknown>,
  };
}

function stableUnitInterval(salt: string, bucketKey: string): number {
  const hash = createHash('sha256').update(`${salt}:${bucketKey}`).digest('hex');
  const sample = Number.parseInt(hash.slice(0, 8), 16);
  return sample / 0xffffffff;
}

function updateVariant(
  variant: StrategyVariantRecord,
  next: Partial<StrategyVariantRecord>,
): StrategyVariantRecord {
  return {
    ...variant,
    ...next,
  };
}

function cloneRegistry(
  registry: StrategyDeploymentRegistryState,
  now: Date,
): StrategyDeploymentRegistryState {
  return {
    ...registry,
    variants: { ...registry.variants },
    quarantines: { ...registry.quarantines },
    retiredVariantIds: [...registry.retiredVariantIds],
    updatedAt: now.toISOString(),
  };
}

function variantIsBlocked(variant: StrategyVariantRecord, now: Date): boolean {
  return variant.status === 'quarantined' || variant.status === 'retired' || isQuarantineActive(variant, now);
}

function effectiveAllocationPct(variant: StrategyVariantRecord): number {
  const stageAllocation = stageAllocationPct(variant.rolloutStage);
  const explicitAllocation =
    typeof variant.capitalAllocationPct === 'number' && Number.isFinite(variant.capitalAllocationPct)
      ? variant.capitalAllocationPct
      : stageAllocation;
  return Math.min(1, Math.max(0, explicitAllocation));
}

function isQuarantineActive(variant: StrategyVariantRecord, now: Date): boolean {
  if (variant.quarantineUntil == null || variant.status !== 'quarantined') {
    return false;
  }
  const timestamp = new Date(variant.quarantineUntil).getTime();
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function isProbationActive(variant: StrategyVariantRecord, now: Date): boolean {
  if (variant.status !== 'probation' || variant.quarantineUntil == null) {
    return false;
  }
  const timestamp = new Date(variant.quarantineUntil).getTime();
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function normalizeStage(stage: StrategyRolloutStage): StrategyRolloutStage {
  switch (stage) {
    case 'canary_1pct':
      return 'paper';
    case 'canary_5pct':
      return 'canary';
    case 'partial':
      return 'cautious_live';
    case 'full':
      return 'scaled_live';
    default:
      return stage;
  }
}

function nextAllowedStage(
  current: StrategyRolloutStage,
  requested: StrategyRolloutStage,
): StrategyRolloutStage {
  const ladder: StrategyRolloutStage[] = [
    'shadow_only',
    'paper',
    'canary',
    'cautious_live',
    'scaled_live',
  ];
  const normalizedCurrent = normalizeStage(current);
  const normalizedRequested = normalizeStage(requested);
  const currentIndex = ladder.indexOf(normalizedCurrent);
  const requestedIndex = ladder.indexOf(normalizedRequested);
  if (requestedIndex <= currentIndex + 1) {
    return normalizedRequested;
  }
  return ladder[Math.min(currentIndex + 1, ladder.length - 1)] ?? normalizedRequested;
}

function previousAllowedStage(current: StrategyRolloutStage): StrategyRolloutStage {
  const ladder: StrategyRolloutStage[] = [
    'shadow_only',
    'paper',
    'canary',
    'cautious_live',
    'scaled_live',
  ];
  const normalizedCurrent = normalizeStage(current);
  const currentIndex = ladder.indexOf(normalizedCurrent);
  if (currentIndex <= 0) {
    return 'shadow_only';
  }
  return ladder[currentIndex - 1] ?? 'shadow_only';
}

function clampProbationStage(current: StrategyRolloutStage): StrategyRolloutStage {
  const normalizedCurrent = normalizeStage(current);
  if (normalizedCurrent === 'scaled_live') {
    return 'cautious_live';
  }
  if (normalizedCurrent === 'cautious_live') {
    return 'canary';
  }
  return normalizedCurrent;
}
