import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LearningEventLog } from '../runtime/learning-event-log';

async function testLearningEventLogRoundTripsCanonicalEventDetails(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase11-learning-events-'));
  const log = new LearningEventLog(rootDir);

  await log.append([
    {
      id: 'event-start',
      type: 'learning_cycle_started',
      severity: 'info',
      createdAt: '2026-03-27T00:00:00.000Z',
      cycleId: 'cycle-11-3',
      strategyVariantId: null,
      contextKey: null,
      summary: 'Learning cycle started.',
      details: {
        payload: {
          phase: 'wave1',
        },
      },
    },
    {
      id: 'event-calibration',
      type: 'calibration_updated',
      severity: 'warning',
      createdAt: '2026-03-27T00:05:00.000Z',
      cycleId: 'cycle-11-3',
      strategyVariantId: 'variant:phase11-learning',
      contextKey: 'variant:phase11-learning|regime:trend_burst',
      summary: 'Calibration updated.',
      details: {
        evidenceRefs: [
          {
            source: 'resolved_trade_ledger',
            sourceId: 'ledger-window-1',
            strategyVariantId: 'variant:phase11-learning',
            regime: 'trend_burst',
            window: {
              from: '2026-03-20T00:00:00.000Z',
              to: '2026-03-27T00:00:00.000Z',
              sampleCount: 9,
            },
          },
        ],
        metricSnapshot: {
          liveTradeCount: 9,
          shrinkageFactor: 0.86,
        },
        changeSet: [
          {
            parameter: 'regime_confidence_threshold',
            previousValue: 0.58,
            nextValue: 0.62,
            rationale: ['calibration_drift_detected'],
            boundedBy: ['confidence_shrinkage_policy'],
            rollbackCriteria: [
              {
                trigger: 'calibration_gap_normalized',
                comparator: 'lte',
                threshold: 0.04,
                rationale: 'Undo threshold raise after calibration recovers.',
              },
            ],
            changedAt: '2026-03-27T00:05:00.000Z',
          },
        ],
        warnings: ['live_evidence_thin'],
        payload: {
          review: {
            generatedBy: 'daily_review',
          },
        },
      },
    },
    {
      id: 'event-complete',
      type: 'learning_cycle_completed',
      severity: 'info',
      createdAt: '2026-03-27T00:10:00.000Z',
      cycleId: 'cycle-11-3',
      strategyVariantId: null,
      contextKey: null,
      summary: 'Learning cycle completed.',
      details: {
        metricSnapshot: {
          realizedOutcomeCount: 9,
        },
      },
    },
  ]);

  const latest = await log.readLatest(10);
  const calibrationEvent = latest.find((event) => event.id === 'event-calibration');
  const windowEvents = await log.loadWindow(
    {
      start: '2026-03-27T00:04:00.000Z',
      end: '2026-03-27T00:06:00.000Z',
    },
    {
      types: ['calibration_updated'],
    },
  );
  const summary = await log.summarizeWindow({
    start: '2026-03-27T00:00:00.000Z',
    end: '2026-03-27T00:10:00.000Z',
  });

  assert.strictEqual(latest.length, 3);
  assert.strictEqual(calibrationEvent?.details.evidenceRefs?.[0]?.source, 'resolved_trade_ledger');
  assert.strictEqual(calibrationEvent?.details.changeSet?.[0]?.parameter, 'regime_confidence_threshold');
  assert.strictEqual(
    calibrationEvent?.details.changeSet?.[0]?.rollbackCriteria?.[0]?.trigger,
    'calibration_gap_normalized',
  );
  assert.strictEqual(windowEvents.length, 1);
  assert.strictEqual(windowEvents[0]?.id, 'event-calibration');
  assert.strictEqual(summary.totalCount, 3);
  assert.strictEqual(summary.byType.calibration_updated, 1);
  assert.strictEqual(summary.bySeverity.warning, 1);
  assert.strictEqual(summary.byStrategyVariantId['variant:phase11-learning'], 1);
}

async function testLearningEventLogLoadsLegacyLinesAndSkipsCorruptOnes(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase11-learning-events-legacy-'));
  const log = new LearningEventLog(rootDir);
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    log.getPath(),
    [
      JSON.stringify({
        id: 'legacy-1',
        type: 'learning_cycle_completed',
        severity: 'info',
        createdAt: '2026-03-26T00:00:00.000Z',
        cycleId: 'legacy-cycle',
        strategyVariantId: null,
        contextKey: null,
        summary: 'Legacy event',
        details: {
          analyzedWindow: {
            from: '2026-03-25T00:00:00.000Z',
            to: '2026-03-26T00:00:00.000Z',
          },
        },
      }),
      '{"id":"broken"',
      JSON.stringify({
        id: 'legacy-2',
        type: 'strategy_quarantined',
        severity: 'critical',
        createdAt: '2026-03-26T01:00:00.000Z',
        cycleId: 'legacy-cycle',
        strategyVariantId: 'variant:legacy',
        contextKey: 'variant:legacy|regime:noisy',
        summary: 'Legacy quarantine event',
        details: {
          errors: ['execution_quality_failure'],
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  const latest = await log.readLatest(10);
  const legacyWindowSummary = await log.summarizeWindow({
    start: '2026-03-26T00:00:00.000Z',
    end: '2026-03-26T02:00:00.000Z',
  });

  assert.strictEqual(latest.length, 2);
  assert.strictEqual(latest[0]?.id, 'legacy-1');
  assert.deepStrictEqual(latest[0]?.details.warnings, []);
  assert.deepStrictEqual(latest[0]?.details.errors, []);
  assert.strictEqual(
    ((latest[0]?.details as Record<string, unknown>).analyzedWindow as Record<string, unknown>).from,
    '2026-03-25T00:00:00.000Z',
  );
  assert.strictEqual(legacyWindowSummary.totalCount, 2);
  assert.strictEqual(legacyWindowSummary.bySeverity.critical, 1);
  assert.strictEqual(legacyWindowSummary.byCycleId['legacy-cycle'], 2);
}

export const phaseElevenLearningEventLogTests = [
  {
    name: 'phase11 learning event log round-trips canonical event details',
    fn: testLearningEventLogRoundTripsCanonicalEventDetails,
  },
  {
    name: 'phase11 learning event log loads legacy lines and skips corrupt ones',
    fn: testLearningEventLogLoadsLegacyLinesAndSkipsCorruptOnes,
  },
];
