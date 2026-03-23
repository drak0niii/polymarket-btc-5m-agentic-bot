import type { LifecycleValidationSuiteResult } from '@worker/validation/live-order-lifecycle-validation';

export interface ReadinessObserverCheck {
  key:
    | 'market_stream_freshness'
    | 'user_stream_freshness'
    | 'auth_validity'
    | 'heartbeat_continuity'
    | 'external_truth_freshness'
    | 'open_order_divergence'
    | 'readiness_evidence_freshness';
  healthy: boolean;
  reasonCode: string;
  observedAt: string | null;
  details: Record<string, unknown>;
}

export interface ReadinessObserverVerdict {
  internalHealthy: boolean;
  observerHealthy: boolean;
  materialDiscrepancy: boolean;
  discrepancyFlags: string[];
  reasonCodes: string[];
  checks: ReadinessObserverCheck[];
  observedAt: string;
}

function ageMs(timestamp: string | null, nowMs: number): number | null {
  if (!timestamp) {
    return null;
  }

  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, nowMs - parsed);
}

function buildCheck(
  check: ReadinessObserverCheck,
): ReadinessObserverCheck {
  return check;
}

export function evaluateReadinessObserver(input: {
  internalSteps: Array<{ name: string; ok: boolean }>;
  marketHealth: { lastEventAt: string | null; lastTrafficAt?: string | null };
  userHealth: {
    lastEventAt: string | null;
    lastTrafficAt?: string | null;
    divergenceDetected?: boolean | null;
  };
  smokeSuccess: boolean;
  externalFreshness: { overallVerdict?: string | null } | null;
  lifecycleSuite: LifecycleValidationSuiteResult | null;
  marketStaleAfterMs: number;
  userStaleAfterMs: number;
  lifecycleEvidenceMaxAgeMs?: number;
  now?: Date;
}): ReadinessObserverVerdict {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const stepMap = new Map(input.internalSteps.map((step) => [step.name, step.ok]));

  const marketEventAgeMs = ageMs(input.marketHealth.lastEventAt, nowMs);
  const userEventAgeMs = ageMs(input.userHealth.lastEventAt, nowMs);
  const marketTrafficAgeMs = ageMs(input.marketHealth.lastTrafficAt ?? null, nowMs);
  const userTrafficAgeMs = ageMs(input.userHealth.lastTrafficAt ?? null, nowMs);
  const lifecycleAgeMs = ageMs(input.lifecycleSuite?.executedAt ?? null, nowMs);
  const lifecycleEvidenceMaxAgeMs = input.lifecycleEvidenceMaxAgeMs ?? 6 * 60 * 60 * 1000;

  const checks: ReadinessObserverCheck[] = [
    buildCheck({
      key: 'market_stream_freshness',
      healthy:
        marketEventAgeMs !== null && marketEventAgeMs <= input.marketStaleAfterMs,
      reasonCode:
        marketEventAgeMs !== null && marketEventAgeMs <= input.marketStaleAfterMs
          ? 'market_stream_fresh'
          : 'market_stream_stale',
      observedAt: input.marketHealth.lastEventAt,
      details: {
        marketEventAgeMs,
        staleAfterMs: input.marketStaleAfterMs,
      },
    }),
    buildCheck({
      key: 'user_stream_freshness',
      healthy: userEventAgeMs !== null && userEventAgeMs <= input.userStaleAfterMs,
      reasonCode:
        userEventAgeMs !== null && userEventAgeMs <= input.userStaleAfterMs
          ? 'user_stream_fresh'
          : 'user_stream_stale',
      observedAt: input.userHealth.lastEventAt,
      details: {
        userEventAgeMs,
        staleAfterMs: input.userStaleAfterMs,
      },
    }),
    buildCheck({
      key: 'auth_validity',
      healthy: input.smokeSuccess,
      reasonCode: input.smokeSuccess ? 'authenticated_smoke_passed' : 'authenticated_smoke_failed',
      observedAt: now.toISOString(),
      details: {
        smokeSuccess: input.smokeSuccess,
      },
    }),
    buildCheck({
      key: 'heartbeat_continuity',
      healthy:
        marketTrafficAgeMs !== null &&
        userTrafficAgeMs !== null &&
        marketTrafficAgeMs <= input.marketStaleAfterMs * 2 &&
        userTrafficAgeMs <= input.userStaleAfterMs * 2,
      reasonCode:
        marketTrafficAgeMs !== null &&
        userTrafficAgeMs !== null &&
        marketTrafficAgeMs <= input.marketStaleAfterMs * 2 &&
        userTrafficAgeMs <= input.userStaleAfterMs * 2
          ? 'traffic_heartbeat_continuous'
          : 'traffic_heartbeat_stale',
      observedAt: now.toISOString(),
      details: {
        marketTrafficAgeMs,
        userTrafficAgeMs,
      },
    }),
    buildCheck({
      key: 'external_truth_freshness',
      healthy: input.externalFreshness?.overallVerdict !== 'stale',
      reasonCode:
        input.externalFreshness?.overallVerdict !== 'stale'
          ? 'external_truth_fresh'
          : 'external_truth_stale',
      observedAt: now.toISOString(),
      details: {
        externalFreshness: input.externalFreshness,
      },
    }),
    buildCheck({
      key: 'open_order_divergence',
      healthy: input.userHealth.divergenceDetected !== true,
      reasonCode:
        input.userHealth.divergenceDetected !== true
          ? 'open_order_truth_consistent'
          : 'open_order_truth_divergent',
      observedAt: now.toISOString(),
      details: {
        divergenceDetected: input.userHealth.divergenceDetected ?? null,
      },
    }),
    buildCheck({
      key: 'readiness_evidence_freshness',
      healthy:
        Boolean(input.lifecycleSuite?.success) &&
        lifecycleAgeMs !== null &&
        lifecycleAgeMs <= lifecycleEvidenceMaxAgeMs,
      reasonCode:
        Boolean(input.lifecycleSuite?.success) &&
        lifecycleAgeMs !== null &&
        lifecycleAgeMs <= lifecycleEvidenceMaxAgeMs
          ? 'lifecycle_evidence_fresh'
          : 'lifecycle_evidence_stale_or_missing',
      observedAt: input.lifecycleSuite?.executedAt ?? null,
      details: {
        lifecycleAgeMs,
        lifecycleEvidenceMaxAgeMs,
        lifecycleSuiteSuccess: input.lifecycleSuite?.success ?? false,
      },
    }),
  ];

  const discrepancyFlags: string[] = [];
  if ((stepMap.get('market_stream_live_subscription') ?? false) && !checks[0].healthy) {
    discrepancyFlags.push('market_stream_internal_vs_observer_divergence');
  }
  if ((stepMap.get('user_stream_authenticated_subscription') ?? false) && !checks[1].healthy) {
    discrepancyFlags.push('user_stream_internal_vs_observer_divergence');
  }
  if ((stepMap.get('stream_truth_reconciliation') ?? false) && !checks[4].healthy) {
    discrepancyFlags.push('external_truth_internal_vs_observer_divergence');
  }
  if ((stepMap.get('stream_truth_reconciliation') ?? false) && !checks[5].healthy) {
    discrepancyFlags.push('open_order_divergence_internal_vs_observer_divergence');
  }

  const observerHealthy = checks.every((check) => check.healthy);
  const internalHealthy = input.internalSteps.every((step) => step.ok);
  const materialDiscrepancy = discrepancyFlags.length > 0;

  return {
    internalHealthy,
    observerHealthy,
    materialDiscrepancy,
    discrepancyFlags,
    reasonCodes: checks.filter((check) => !check.healthy).map((check) => check.reasonCode),
    checks,
    observedAt: now.toISOString(),
  };
}
