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

    if (incumbent.status === 'quarantined') {
      return {
        variantId: null,
        strategyVersionId: null,
        stage: activeRollout?.stage ?? 'shadow_only',
        allocationPct: 0,
        bucketKey,
        reasonCodes: ['incumbent_variant_quarantined'],
      };
    }

    if (!activeRollout || !activeRollout.challengerVariantId) {
      return {
        variantId: incumbent.variantId,
        strategyVersionId: incumbent.strategyVersionId,
        stage: 'full',
        allocationPct: 1,
        bucketKey,
        reasonCodes: ['incumbent_only'],
      };
    }

    const challenger = registry.variants[activeRollout.challengerVariantId] ?? null;
    if (
      !challenger ||
      challenger.status === 'quarantined' ||
      activeRollout.stage === 'shadow_only' ||
      activeRollout.challengerAllocationPct <= 0
    ) {
      return {
        variantId: incumbent.variantId,
        strategyVersionId: incumbent.strategyVersionId,
        stage: activeRollout.stage,
        allocationPct: 0,
        bucketKey,
        reasonCodes: ['challenger_not_live'],
      };
    }

    if (activeRollout.stage === 'full') {
      return {
        variantId: challenger.variantId,
        strategyVersionId: challenger.strategyVersionId,
        stage: activeRollout.stage,
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
        stage: activeRollout.stage,
        allocationPct: activeRollout.challengerAllocationPct,
        bucketKey,
        reasonCodes: ['bounded_challenger_assignment'],
      };
    }

    return {
      variantId: incumbent.variantId,
      strategyVersionId: incumbent.strategyVersionId,
      stage: activeRollout.stage,
      allocationPct: 1 - activeRollout.challengerAllocationPct,
      bucketKey,
      reasonCodes: ['incumbent_retained_for_bucket'],
    };
  }

  getExecutionControls(
    registry: StrategyDeploymentRegistryState,
    input: { strategyVersionId: string | null },
  ): StrategyExecutionRolloutControls {
    const variant =
      input.strategyVersionId == null
        ? null
        : Object.values(registry.variants).find(
            (candidate) => candidate.strategyVersionId === input.strategyVersionId,
          ) ?? null;
    if (!variant) {
      return {
        variantId: null,
        stage: 'full',
        sizeMultiplier: 1,
        blocked: false,
        reasonCodes: ['strategy_variant_untracked'],
      };
    }

    if (variant.status === 'quarantined' || variant.status === 'retired') {
      return {
        variantId: variant.variantId,
        stage: variant.rolloutStage,
        sizeMultiplier: 0,
        blocked: true,
        reasonCodes: [`strategy_variant_${variant.status}`],
      };
    }

    const activeRollout = registry.activeRollout;
    if (
      activeRollout &&
      activeRollout.challengerVariantId === variant.variantId &&
      activeRollout.stage === 'shadow_only'
    ) {
      return {
        variantId: variant.variantId,
        stage: activeRollout.stage,
        sizeMultiplier: 0,
        blocked: true,
        reasonCodes: ['shadow_only_variant_not_live'],
      };
    }

    if (activeRollout && activeRollout.challengerVariantId === variant.variantId) {
      return {
        variantId: variant.variantId,
        stage: activeRollout.stage,
        sizeMultiplier: activeRollout.challengerAllocationPct,
        blocked: false,
        reasonCodes: ['challenger_rollout_size_bound'],
      };
    }

    return {
      variantId: variant.variantId,
      stage: variant.rolloutStage,
      sizeMultiplier: 1,
      blocked: false,
      reasonCodes: ['incumbent_or_shadow_variant'],
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
        updatedAt: now.toISOString(),
      });
      if (nextRegistry.activeRollout?.challengerVariantId === candidate.variantId) {
        nextRegistry.activeRollout = null;
      }
      return { registry: nextRegistry, event: null };
    }

    if (input.decision.verdict === 'canary') {
      const incumbentVariantId = nextRegistry.incumbentVariantId;
      nextRegistry.activeRollout = buildRolloutRecord({
        incumbentVariantId,
        challengerVariantId: candidate.variantId,
        stage: input.decision.targetRolloutStage,
        appliedReason: input.decision.reasons.join(','),
        appliedAt: now.toISOString(),
      });
      nextRegistry.variants[candidate.variantId] = updateVariant(candidate, {
        status: 'canary',
        evaluationMode: evaluationModeForStage(input.decision.targetRolloutStage),
        rolloutStage: input.decision.targetRolloutStage,
        capitalAllocationPct: stageAllocationPct(input.decision.targetRolloutStage),
        updatedAt: now.toISOString(),
      });
      return {
        registry: nextRegistry,
        event: buildRolloutEvent(input.cycleId, nextRegistry.activeRollout, now),
      };
    }

    if (input.decision.verdict === 'promote') {
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
        evaluationMode: 'full',
        rolloutStage: 'full',
        capitalAllocationPct: 1,
        updatedAt: now.toISOString(),
      });
      nextRegistry.activeRollout = buildRolloutRecord({
        incumbentVariantId: previousIncumbentId,
        challengerVariantId: candidate.variantId,
        stage: 'full',
        appliedReason: input.decision.reasons.join(','),
        appliedAt: now.toISOString(),
      });
      return {
        registry: nextRegistry,
        event: buildRolloutEvent(input.cycleId, nextRegistry.activeRollout, now),
      };
    }

    return { registry: nextRegistry, event: null };
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
        rolloutStage: 'full',
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
  switch (stage) {
    case 'shadow_only':
      return 0;
    case 'canary_1pct':
      return 0.01;
    case 'canary_5pct':
      return 0.05;
    case 'partial':
      return 0.25;
    case 'full':
      return 1;
  }
}

function evaluationModeForStage(stage: StrategyRolloutStage): StrategyVariantEvaluationMode {
  switch (stage) {
    case 'shadow_only':
      return 'shadow_only';
    case 'canary_1pct':
    case 'canary_5pct':
      return 'canary';
    case 'partial':
      return 'partial';
    case 'full':
      return 'full';
  }
}

function buildRolloutRecord(input: {
  incumbentVariantId: string | null;
  challengerVariantId: string;
  stage: StrategyRolloutStage;
  appliedReason: string;
  appliedAt: string;
}): StrategyRolloutRecord {
  return {
    incumbentVariantId: input.incumbentVariantId,
    challengerVariantId: input.challengerVariantId,
    stage: input.stage,
    challengerAllocationPct: stageAllocationPct(input.stage),
    rolloutSalt: createHash('sha256')
      .update(`${input.challengerVariantId}:${input.appliedAt}:${input.stage}`)
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
    severity: rollout.stage === 'full' ? 'warning' : 'info',
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
