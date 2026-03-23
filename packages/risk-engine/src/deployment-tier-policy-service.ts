import type { DeploymentTier, DeploymentTierVerdict } from '@polymarket-btc-5m-agentic-bot/domain';

export class DeploymentTierPolicyService {
  evaluate(input: {
    tier: DeploymentTier;
    liveExecutionEnabled: boolean;
    robustnessPassed: boolean;
    auditCoverageHealthy: boolean;
    readinessReady: boolean;
  }): DeploymentTierVerdict {
    const reasons: string[] = [];

    if (!input.readinessReady) {
      reasons.push('readiness_not_green');
    }
    if (
      (input.tier === 'cautious_live' || input.tier === 'scaled_live') &&
      !input.robustnessPassed
    ) {
      reasons.push('robustness_evidence_missing');
    }
    if (
      (input.tier === 'cautious_live' || input.tier === 'scaled_live') &&
      !input.auditCoverageHealthy
    ) {
      reasons.push('audit_coverage_missing');
    }
    if (
      (input.tier === 'canary' ||
        input.tier === 'cautious_live' ||
        input.tier === 'scaled_live') &&
      !input.liveExecutionEnabled
    ) {
      reasons.push('live_execution_disabled');
    }

    const configByTier: Record<
      DeploymentTier,
      Pick<
        DeploymentTierVerdict,
        'allowLiveOrders' | 'allowNewEntries' | 'maxOpenPositionsMultiplier' | 'perTradeRiskMultiplier'
      >
    > = {
      research: {
        allowLiveOrders: false,
        allowNewEntries: false,
        maxOpenPositionsMultiplier: 0,
        perTradeRiskMultiplier: 0,
      },
      paper: {
        allowLiveOrders: false,
        allowNewEntries: true,
        maxOpenPositionsMultiplier: 0.25,
        perTradeRiskMultiplier: 0.1,
      },
      canary: {
        allowLiveOrders: true,
        allowNewEntries: true,
        maxOpenPositionsMultiplier: 0.35,
        perTradeRiskMultiplier: 0.2,
      },
      cautious_live: {
        allowLiveOrders: true,
        allowNewEntries: true,
        maxOpenPositionsMultiplier: 0.65,
        perTradeRiskMultiplier: 0.5,
      },
      scaled_live: {
        allowLiveOrders: true,
        allowNewEntries: true,
        maxOpenPositionsMultiplier: 1,
        perTradeRiskMultiplier: 1,
      },
    };

    const selected = configByTier[input.tier];
    const blocked = reasons.length > 0 && input.tier !== 'paper' && input.tier !== 'research';

    return {
      tier: input.tier,
      allowLiveOrders: selected.allowLiveOrders && !blocked,
      allowNewEntries: selected.allowNewEntries && !blocked,
      maxOpenPositionsMultiplier: blocked ? 0 : selected.maxOpenPositionsMultiplier,
      perTradeRiskMultiplier: blocked ? 0 : selected.perTradeRiskMultiplier,
      requiresRobustnessEvidence:
        input.tier === 'cautious_live' || input.tier === 'scaled_live',
      requiresAuditability:
        input.tier === 'canary' ||
        input.tier === 'cautious_live' ||
        input.tier === 'scaled_live',
      reasons,
    };
  }
}
