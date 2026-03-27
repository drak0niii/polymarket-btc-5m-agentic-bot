import type {
  LearningEvent,
  StrategyDeploymentRegistryState,
  StrategyVariantRecord,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { createStrategyVariantRecord } from '@polymarket-btc-5m-agentic-bot/domain';

export interface StrategyVersionRegistration {
  strategyVersionId: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChampionChallengerSyncResult {
  registry: StrategyDeploymentRegistryState;
  registeredVariants: StrategyVariantRecord[];
  retiredVariantIds: string[];
  events: LearningEvent[];
}

export interface LivePromotionCandidateFilterDecision {
  variantId: string;
  eligible: boolean;
  reasonCodes: string[];
}

export class ChampionChallengerManager {
  sync(input: {
    registry: StrategyDeploymentRegistryState;
    versions: StrategyVersionRegistration[];
    cycleId: string;
    now?: Date;
  }): ChampionChallengerSyncResult {
    const now = input.now ?? new Date();
    const nextRegistry: StrategyDeploymentRegistryState = {
      ...input.registry,
      variants: { ...input.registry.variants },
      quarantines: { ...input.registry.quarantines },
      retiredVariantIds: [...input.registry.retiredVariantIds],
      updatedAt: now.toISOString(),
    };
    const events: LearningEvent[] = [];
    const registeredVariants: StrategyVariantRecord[] = [];
    const retiredVariantIds: string[] = [];
    const versions = [...input.versions].sort(compareStrategyVersions);
    const activeVersion = versions.find((version) => version.isActive) ?? versions[0] ?? null;
    const seenVariantIds = new Set<string>();

    if (!nextRegistry.incumbentVariantId && activeVersion) {
      const incumbent = createStrategyVariantRecord({
        strategyVersionId: activeVersion.strategyVersionId,
        status: 'incumbent',
        evaluationMode: 'full',
        rolloutStage: 'full',
        capitalAllocationPct: 1,
        now,
        createdReason: 'initialized_from_active_strategy_version',
      });
      nextRegistry.incumbentVariantId = incumbent.variantId;
      nextRegistry.variants[incumbent.variantId] = incumbent;
      registeredVariants.push(incumbent);
      events.push(buildRegistrationEvent(input.cycleId, incumbent, now, 'registered_as_incumbent'));
    }

    for (const version of versions) {
      const existing = Object.values(nextRegistry.variants).find(
        (variant) => variant.strategyVersionId === version.strategyVersionId,
      );
      if (existing) {
        seenVariantIds.add(existing.variantId);
        continue;
      }

      const shouldBeIncumbent =
        nextRegistry.incumbentVariantId == null &&
        activeVersion?.strategyVersionId === version.strategyVersionId;
      const variant = createStrategyVariantRecord({
        strategyVersionId: version.strategyVersionId,
        status: shouldBeIncumbent ? 'incumbent' : 'shadow',
        evaluationMode: shouldBeIncumbent ? 'full' : 'shadow_only',
        rolloutStage: shouldBeIncumbent ? 'full' : 'shadow_only',
        capitalAllocationPct: shouldBeIncumbent ? 1 : 0,
        now,
        createdReason: 'registered_from_strategy_version',
      });
      if (shouldBeIncumbent) {
        nextRegistry.incumbentVariantId = variant.variantId;
      }
      nextRegistry.variants[variant.variantId] = variant;
      seenVariantIds.add(variant.variantId);
      registeredVariants.push(variant);
      events.push(buildRegistrationEvent(input.cycleId, variant, now, 'registered_as_challenger'));
    }

    for (const [variantId, variant] of Object.entries(nextRegistry.variants)) {
      if (seenVariantIds.has(variantId)) {
        continue;
      }
      if (nextRegistry.retiredVariantIds.includes(variantId)) {
        continue;
      }
      nextRegistry.variants[variantId] = {
        ...variant,
        status: 'retired',
        evaluationMode: 'shadow_only',
        rolloutStage: 'shadow_only',
        capitalAllocationPct: 0,
        updatedAt: now.toISOString(),
      };
      nextRegistry.retiredVariantIds.push(variantId);
      retiredVariantIds.push(variantId);
    }

    return {
      registry: nextRegistry,
      registeredVariants,
      retiredVariantIds,
      events,
    };
  }

  filterPromotionCandidates(input: {
    registry: StrategyDeploymentRegistryState;
    liveGateDecisions: Record<
      string,
      {
        passed: boolean;
        reasonCodes: string[];
      }
    >;
  }): LivePromotionCandidateFilterDecision[] {
    return Object.values(input.registry.variants)
      .filter((variant) => variant.variantId !== input.registry.incumbentVariantId)
      .filter((variant) => variant.status !== 'retired')
      .map((variant) => {
        const liveGate = input.liveGateDecisions[variant.variantId] ?? null;
        if (liveGate == null) {
          return {
            variantId: variant.variantId,
            eligible: false,
            reasonCodes: ['live_promotion_gate_missing'],
          };
        }
        if (!liveGate.passed) {
          return {
            variantId: variant.variantId,
            eligible: false,
            reasonCodes: [...liveGate.reasonCodes],
          };
        }
        return {
          variantId: variant.variantId,
          eligible: true,
          reasonCodes: ['live_promotion_gate_passed'],
        };
      });
  }
}

function buildRegistrationEvent(
  cycleId: string,
  variant: StrategyVariantRecord,
  now: Date,
  registrationMode: string,
): LearningEvent {
  return {
    id: `${cycleId}:strategy-register:${variant.variantId}`,
    type: 'strategy_variant_registered',
    severity: 'info',
    createdAt: now.toISOString(),
    cycleId,
    strategyVariantId: variant.variantId,
    contextKey: null,
    summary: `Strategy variant ${variant.variantId} registered.`,
    details: {
      strategyVersionId: variant.strategyVersionId,
      status: variant.status,
      registrationMode,
    },
  };
}

function compareStrategyVersions(
  left: StrategyVersionRegistration,
  right: StrategyVersionRegistration,
): number {
  if (left.isActive !== right.isActive) {
    return left.isActive ? -1 : 1;
  }
  return right.updatedAt.localeCompare(left.updatedAt);
}
