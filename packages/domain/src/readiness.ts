export type ReadinessCheckStatus = 'pass' | 'warn' | 'fail';

export interface ReadinessCheck {
  key: string;
  label: string;
  status: ReadinessCheckStatus;
  reason: string;
  observedAt: string | null;
}

export interface ReadinessSection {
  key: string;
  label: string;
  status: ReadinessCheckStatus;
  checks: ReadinessCheck[];
}

export interface ReadinessDashboard {
  ready: boolean;
  status: 'ready' | 'degraded' | 'blocked';
  deploymentTier: string;
  capitalMultiplier: number;
  sections: ReadinessSection[];
  summary: {
    auditCoverageHealthy: boolean;
    replayHealthy: boolean;
    robustnessHealthy: boolean;
    governanceHealthy: boolean;
    observerHealthy: boolean;
    capitalEvidenceHealthy: boolean;
  };
  generatedAt: string;
}
