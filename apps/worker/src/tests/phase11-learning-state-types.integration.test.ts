import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createDefaultLearningDecisionEvidence,
  createDefaultLearningEventDetails,
  createDefaultLearningState,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { LearningStateStore } from '../runtime/learning-state-store';

async function testCanonicalLearningDecisionTypesExposeEvidenceAndRollbackSurfaces(): Promise<void> {
  const state = createDefaultLearningState(new Date('2026-03-27T00:00:00.000Z'));
  const variant = createDefaultStrategyVariantState('variant:phase11-learning');

  assert.deepStrictEqual(createDefaultLearningDecisionEvidence(), {
    summary: null,
    evidenceRefs: [],
    metricSnapshot: {},
    changeSet: [],
    warnings: [],
    payload: {},
  });
  assert.deepStrictEqual(createDefaultLearningEventDetails(), {
    evidenceRefs: [],
    metricSnapshot: {},
    changeSet: [],
    warnings: [],
    errors: [],
    payload: {},
  });
  assert.deepStrictEqual(variant.lastPromotionDecision.rollbackCriteria, []);
  assert.deepStrictEqual(variant.lastQuarantineDecision.rollbackCriteria, []);
  assert.deepStrictEqual(variant.lastCapitalAllocationDecision.rollbackCriteria, []);
  assert.deepStrictEqual(state.executionLearning.contexts, {});
}

async function testLearningStateStoreRoundTripsCanonicalEvidencePackets(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase11-learning-types-'));
  const store = new LearningStateStore(rootDir);
  const strategyVariantId = 'variant:phase11-learning';
  const state = createDefaultLearningState(new Date('2026-03-27T00:00:00.000Z'));
  state.strategyVariants[strategyVariantId] = createDefaultStrategyVariantState(strategyVariantId);
  state.lastCycleSummary = {
    cycleId: 'cycle-phase11-1',
    startedAt: '2026-03-27T00:00:00.000Z',
    completedAt: '2026-03-27T00:10:00.000Z',
    status: 'completed_with_warnings',
    analyzedWindow: {
      from: '2026-03-26T00:00:00.000Z',
      to: '2026-03-27T00:00:00.000Z',
    },
    realizedOutcomeCount: 4,
    attributionSliceCount: 4,
    calibrationUpdates: 1,
    shrinkageActions: 1,
    degradedContexts: ['regime:illiquid_noisy_book'],
    warnings: ['sample_sufficiency_not_met'],
    errors: [],
    reviewOutputs: {
      decisionEvidence: {
        evidenceRefs: [
          {
            source: 'validation_artifact',
            artifactPath: 'artifacts/validation/latest.json',
          },
        ],
        warnings: ['review_pending'],
        payload: {
          allowPromotion: false,
        },
      },
      eventDetails: {
        evidenceRefs: [
          {
            source: 'audit_event',
            sourceId: 'audit-1',
          },
        ],
        metricSnapshot: {
          realizedNetEdgeBps: 14,
        },
        changeSet: [
          {
            parameter: 'entry_threshold_bps',
            previousValue: 12,
            nextValue: 14,
          },
        ],
        warnings: ['threshold_raised'],
        errors: [],
        payload: {
          cycleReview: true,
        },
      },
    },
  };
  state.strategyVariants[strategyVariantId]!.lastPromotionDecision = {
    decision: 'shadow_only',
    reasons: ['sample_sufficiency_not_met'],
    evidence: {
      summary: 'Sample too small for rollout advancement.',
      evidenceRefs: [
        {
          source: 'resolved_trade_ledger',
          sourceId: 'ledger-window-1',
          strategyVariantId,
          regime: 'trend_burst',
          window: {
            from: '2026-03-20T00:00:00.000Z',
            to: '2026-03-27T00:00:00.000Z',
            sampleCount: 4,
          },
          metricSnapshot: {
            realizedNetEdgeBps: 12,
            benchmarkGapBps: -4,
          },
          notes: ['insufficient live evidence'],
        },
      ],
      metricSnapshot: {
        liveTradeCount: 4,
        liveTrustScore: 0.41,
      },
      changeSet: [
        {
          parameter: 'deployment_tier',
          previousValue: 'paper',
          nextValue: 'paper',
          rationale: ['promotion gate did not pass'],
          boundedBy: ['no tier skips'],
          rollbackCriteria: [
            {
              trigger: 'live_trade_count_below_threshold',
              comparator: 'lte',
              threshold: 5,
              rationale: 'Require more live evidence before rollout.',
            },
          ],
          changedAt: '2026-03-27T00:00:00.000Z',
        },
      ],
      warnings: ['promotion deferred'],
      payload: {
        promotionAllowed: false,
      },
    },
    rollbackCriteria: [
      {
        trigger: 'benchmark_underperformance',
        comparator: 'contains',
        threshold: 'no_trade_baseline',
        rationale: 'Do not promote without baseline proof.',
      },
    ],
    decidedAt: '2026-03-27T00:00:00.000Z',
  };

  await store.save(state);
  const loaded = await store.load();
  const decision = loaded.strategyVariants[strategyVariantId]?.lastPromotionDecision;

  assert.strictEqual(decision?.evidence.summary, 'Sample too small for rollout advancement.');
  assert.strictEqual(decision?.evidence.evidenceRefs?.[0]?.source, 'resolved_trade_ledger');
  assert.strictEqual(
    decision?.evidence.changeSet?.[0]?.rollbackCriteria?.[0]?.trigger,
    'live_trade_count_below_threshold',
  );
  assert.strictEqual(decision?.rollbackCriteria?.[0]?.trigger, 'benchmark_underperformance');
  assert.strictEqual(
    (loaded.lastCycleSummary?.reviewOutputs as Record<string, unknown> | null)?.decisionEvidence !=
      null,
    true,
  );
  const eventDetails =
    loaded.lastCycleSummary?.reviewOutputs &&
    typeof loaded.lastCycleSummary.reviewOutputs === 'object'
      ? ((loaded.lastCycleSummary.reviewOutputs as Record<string, unknown>).eventDetails as
          | Record<string, unknown>
          | undefined)
      : undefined;
  assert.strictEqual(
    ((eventDetails?.changeSet as Array<Record<string, unknown>> | undefined)?.[0]?.parameter ??
      null) === 'entry_threshold_bps',
    true,
  );
}

async function testLearningStateStoreLoadsLegacySnapshotsSafely(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase11-learning-legacy-'));
  const store = new LearningStateStore(rootDir);
  const legacySnapshot = {
    schemaVersion: 1,
    updatedAt: '2026-03-20T00:00:00.000Z',
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleSummary: {
      cycleId: 'legacy-cycle',
      startedAt: '2026-03-20T00:00:00.000Z',
      completedAt: '2026-03-20T00:10:00.000Z',
      status: 'completed',
      analyzedWindow: {
        from: '2026-03-19T00:00:00.000Z',
        to: '2026-03-20T00:00:00.000Z',
      },
      realizedOutcomeCount: 1,
      attributionSliceCount: 1,
      calibrationUpdates: 0,
      shrinkageActions: 0,
      degradedContexts: [],
      warnings: [],
      errors: [],
    },
    strategyVariants: {
      'variant:legacy': {
        strategyVariantId: 'variant:legacy',
        health: 'healthy',
        lastLearningAt: null,
        regimeSnapshots: {},
        calibrationContexts: [],
        executionLearning: {
          version: 1,
          updatedAt: null,
          contexts: {},
          policyVersions: {},
          activePolicyVersionIds: {},
          lastPolicyChangeAt: null,
        },
        lastPromotionDecision: {
          decision: 'not_evaluated',
          reasons: [],
          evidence: {},
          decidedAt: null,
        },
        lastQuarantineDecision: {
          status: 'none',
          severity: 'none',
          reasons: [],
          scope: {},
          decidedAt: null,
          until: null,
        },
        lastCapitalAllocationDecision: {
          status: 'unchanged',
          targetMultiplier: 1,
          reasons: [],
          decidedAt: null,
        },
      },
    },
    calibration: {},
    executionLearning: {
      version: 1,
      updatedAt: null,
      contexts: {},
      policyVersions: {},
      activePolicyVersionIds: {},
      lastPolicyChangeAt: null,
    },
    portfolioLearning: {
      version: 1,
      updatedAt: null,
      allocationByVariant: {},
      allocationByRegime: {},
      allocationByOpportunityClass: {},
      drawdownBySleeve: {},
      concentrationSignals: {},
      correlationSignals: {},
      allocationDecisions: {},
      lastCorrelationUpdatedAt: null,
      lastAllocationUpdatedAt: null,
    },
  };

  fs.mkdirSync(store.getPaths().rootDir, { recursive: true });
  fs.writeFileSync(
    store.getPaths().statePath,
    `${JSON.stringify(legacySnapshot, null, 2)}\n`,
    'utf8',
  );

  const loaded = await store.load();
  const legacyVariant = loaded.strategyVariants['variant:legacy'];

  assert.strictEqual(loaded.schemaVersion, 1);
  assert.ok(legacyVariant);
  assert.deepStrictEqual(legacyVariant?.lastPromotionDecision.evidence.evidenceRefs, []);
  assert.deepStrictEqual(legacyVariant?.lastPromotionDecision.rollbackCriteria, []);
  assert.deepStrictEqual(legacyVariant?.lastCapitalAllocationDecision.rollbackCriteria, []);
}

export const phaseElevenLearningStateTypeTests = [
  {
    name: 'phase11 canonical learning-state types expose evidence and rollback surfaces',
    fn: testCanonicalLearningDecisionTypesExposeEvidenceAndRollbackSurfaces,
  },
  {
    name: 'phase11 learning-state store round-trips canonical evidence packets',
    fn: testLearningStateStoreRoundTripsCanonicalEvidencePackets,
  },
  {
    name: 'phase11 learning-state store loads legacy snapshots safely',
    fn: testLearningStateStoreLoadsLegacySnapshotsSafely,
  },
];
