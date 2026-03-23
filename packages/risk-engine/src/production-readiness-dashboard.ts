import type { ReadinessDashboard, ReadinessSection } from '@polymarket-btc-5m-agentic-bot/domain';

type ReadinessKey =
  | 'startup'
  | 'streams'
  | 'observer'
  | 'governance'
  | 'robustness'
  | 'auditability'
  | 'replay'
  | 'chaos'
  | 'tier'
  | 'capitalRamp'
  | 'capitalEvidence';

export class ProductionReadinessDashboardService {
  private readonly labels: Record<ReadinessKey, string> = {
    startup: 'Startup',
    streams: 'Live Truth',
    observer: 'Observer',
    governance: 'Research Governance',
    robustness: 'Robustness',
    auditability: 'Auditability',
    replay: 'Replay',
    chaos: 'Chaos',
    tier: 'Deployment Tier',
    capitalRamp: 'Capital Ramp',
    capitalEvidence: 'Capital Evidence',
  };

  evaluate(input: {
    deploymentTier: string;
    capitalMultiplier: number;
    checks: Record<ReadinessKey, boolean>;
    reasons: Partial<Record<ReadinessKey, string>>;
    observedAt?: Partial<Record<ReadinessKey, string | null>>;
  }): ReadinessDashboard {
    const sections: ReadinessSection[] = (
      Object.keys(this.labels) as ReadinessKey[]
    ).map((key) => this.buildSection(key, input));
    const failures = sections.filter((section) => section.status === 'fail').length;
    const warns = sections.filter((section) => section.status === 'warn').length;

    return {
      ready: failures === 0 && warns === 0,
      status: failures > 0 ? 'blocked' : warns > 0 ? 'degraded' : 'ready',
      deploymentTier: input.deploymentTier,
      capitalMultiplier: input.capitalMultiplier,
      sections,
      summary: {
        auditCoverageHealthy: input.checks.auditability,
        replayHealthy: input.checks.replay,
        robustnessHealthy: input.checks.robustness,
        governanceHealthy: input.checks.governance,
        observerHealthy: input.checks.observer,
        capitalEvidenceHealthy: input.checks.capitalEvidence,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  private buildSection(
    key: ReadinessKey,
    input: {
      checks: Record<ReadinessKey, boolean>;
      reasons: Partial<Record<ReadinessKey, string>>;
      observedAt?: Partial<Record<ReadinessKey, string | null>>;
    },
  ): ReadinessSection {
    return {
      key,
      label: this.labels[key],
      status: input.checks[key] ? 'pass' : 'fail',
      checks: [
        {
          key,
          label: this.labels[key],
          status: input.checks[key] ? 'pass' : 'fail',
          reason: input.reasons[key] ?? (input.checks[key] ? 'healthy' : 'not_ready'),
          observedAt: input.observedAt?.[key] ?? null,
        },
      ],
    };
  }
}
