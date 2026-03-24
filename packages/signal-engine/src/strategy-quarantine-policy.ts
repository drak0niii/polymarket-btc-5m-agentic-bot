import type {
  HealthLabel,
  LearningState,
  QuarantineDecision,
  ShadowEvaluationEvidence,
  StrategyQuarantineRecord,
  StrategyVariantRecord,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  createDefaultQuarantineDecision,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface StrategyQuarantineAssessment {
  records: StrategyQuarantineRecord[];
  decision: QuarantineDecision;
}

export class StrategyQuarantinePolicy {
  evaluate(input: {
    variant: StrategyVariantRecord;
    evidence: ShadowEvaluationEvidence;
    learningState: LearningState;
    now?: Date;
  }): StrategyQuarantineAssessment {
    const now = input.now ?? new Date();
    const variantState =
      input.learningState.strategyVariants[input.variant.variantId] ??
      createDefaultStrategyVariantState(input.variant.variantId);
    const records: StrategyQuarantineRecord[] = [];
    const reasons: string[] = [];
    const regimeHealth = new Map<string, HealthLabel>();

    for (const snapshot of Object.values(variantState.regimeSnapshots)) {
      const current = regimeHealth.get(snapshot.regime) ?? 'healthy';
      regimeHealth.set(snapshot.regime, worstHealth([current, snapshot.health]));
    }

    for (const [regime, health] of [...regimeHealth.entries()].sort((left, right) =>
      left[0].localeCompare(right[0]),
    )) {
      if (health !== 'quarantine_candidate') {
        continue;
      }
      records.push(
        buildRecord({
          variantId: input.variant.variantId,
          regime,
          marketContext: 'regime_snapshot',
          severity: 'high',
          reasonCode: 'regime_edge_decay',
          details: { health },
          now,
        }),
      );
      reasons.push(`regime_${regime}_quarantine_candidate`);
    }

    for (const calibration of Object.values(input.learningState.calibration)) {
      if (calibration.strategyVariantId !== input.variant.variantId) {
        continue;
      }
      if (calibration.health !== 'quarantine_candidate') {
        continue;
      }
      const regime = calibration.regime ?? null;
      records.push(
        buildRecord({
          variantId: input.variant.variantId,
          regime,
          marketContext: 'calibration',
          severity: 'high',
          reasonCode: 'calibration_collapse',
          details: {
            contextKey: calibration.contextKey,
            driftSignals: calibration.driftSignals,
          },
          now,
        }),
      );
      reasons.push(`calibration_${regime ?? 'all'}_quarantine_candidate`);
    }

    if (input.evidence.executionHealth === 'quarantine_candidate') {
      records.push(
        buildRecord({
          variantId: input.variant.variantId,
          regime: null,
          marketContext: 'execution',
          severity: 'high',
          reasonCode: 'execution_deterioration',
          details: {
            executionHealth: input.evidence.executionHealth,
          },
          now,
        }),
      );
      reasons.push('execution_quarantine_candidate');
    }

    const dedupedRecords = dedupeRecords(records);
    if (dedupedRecords.length > 0) {
      return {
        records: dedupedRecords,
        decision: {
          status: 'quarantined',
          severity: 'high',
          reasons,
          scope: {
            strategyVariantId: input.variant.variantId,
            regime: dedupedRecords[0]?.scope.regime ?? null,
            marketContext: dedupedRecords[0]?.scope.marketContext ?? null,
          },
          decidedAt: now.toISOString(),
        },
      };
    }

    if (
      input.evidence.calibrationHealth === 'degraded' ||
      input.evidence.executionHealth === 'degraded'
    ) {
      return {
        records: [],
        decision: {
          status: 'watch',
          severity: 'medium',
          reasons: ['variant_on_watch_for_degraded_health'],
          scope: {
            strategyVariantId: input.variant.variantId,
          },
          decidedAt: now.toISOString(),
        },
      };
    }

    return {
      records: [],
      decision: createDefaultQuarantineDecision(),
    };
  }
}

function buildRecord(input: {
  variantId: string;
  regime: string | null;
  marketContext: string | null;
  severity: StrategyQuarantineRecord['severity'];
  reasonCode: string;
  details: Record<string, unknown>;
  now: Date;
}): StrategyQuarantineRecord {
  return {
    quarantineId: [
      'quarantine',
      input.variantId,
      input.regime ?? 'all',
      input.marketContext ?? 'all',
      input.now.toISOString(),
    ].join(':'),
    scope: {
      variantId: input.variantId,
      regime: input.regime,
      marketContext: input.marketContext,
    },
    severity: input.severity,
    reasonCode: input.reasonCode,
    details: input.details,
    createdAt: input.now.toISOString(),
  };
}

function dedupeRecords(records: StrategyQuarantineRecord[]): StrategyQuarantineRecord[] {
  const deduped = new Map<string, StrategyQuarantineRecord>();
  for (const record of records) {
    const key = [
      record.scope.variantId,
      record.scope.regime ?? 'all',
      record.scope.marketContext ?? 'all',
      record.reasonCode,
    ].join(':');
    if (!deduped.has(key)) {
      deduped.set(key, record);
    }
  }
  return [...deduped.values()];
}

function worstHealth(healths: HealthLabel[]): HealthLabel {
  const priority: Record<HealthLabel, number> = {
    healthy: 0,
    watch: 1,
    degraded: 2,
    quarantine_candidate: 3,
  };
  return [...healths].sort((left, right) => priority[right] - priority[left])[0] ?? 'healthy';
}
