import type {
  HealthLabel,
  LearningState,
  PortfolioAllocationDecisionRecord,
  PortfolioLearningState,
  StrategyDeploymentRegistryState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { AllocationPromotionGate } from './allocation-promotion-gate';
import { buildPortfolioDrawdownKey, buildPortfolioSliceKey } from './portfolio-learning-state';

export interface CapitalAllocationEngineResult {
  decisions: Record<string, PortfolioAllocationDecisionRecord>;
}

export class CapitalAllocationEngine {
  constructor(private readonly promotionGate = new AllocationPromotionGate()) {}

  evaluate(input: {
    learningState: LearningState;
    portfolioLearning: PortfolioLearningState;
    registry: StrategyDeploymentRegistryState;
    correlationPenaltyByVariant?: Record<string, number>;
    now?: Date;
  }): CapitalAllocationEngineResult {
    const now = input.now ?? new Date();
    const decisions: Record<string, PortfolioAllocationDecisionRecord> = {};
    const variantIds = new Set([
      ...Object.keys(input.learningState.strategyVariants),
      ...Object.values(input.registry.variants).map((variant) => variant.variantId),
      ...Object.values(input.portfolioLearning.allocationByVariant).map((slice) => slice.sleeveValue),
    ]);

    for (const strategyVariantId of [...variantIds].sort()) {
      const variantState = input.learningState.strategyVariants[strategyVariantId] ?? null;
      const variantRecord = input.registry.variants[strategyVariantId] ?? null;
      const allocationSlice =
        input.portfolioLearning.allocationByVariant[
          buildPortfolioSliceKey('variant', strategyVariantId)
        ] ?? null;
      const drawdown =
        input.portfolioLearning.drawdownBySleeve[
          buildPortfolioDrawdownKey('variant', strategyVariantId)
        ] ?? null;
      const calibrationHealth = worstHealth(
        Object.values(input.learningState.calibration)
          .filter((calibration) => calibration.strategyVariantId === strategyVariantId)
          .map((calibration) => calibration.health),
      );
      const executionHealth = worstHealth(
        Object.values(variantState?.executionLearning.contexts ?? {}).map(
          (context) => context.health,
        ),
      );
      const sampleCount =
        allocationSlice?.sampleCount ??
        Object.values(variantState?.regimeSnapshots ?? {}).reduce(
          (sum, snapshot) => sum + snapshot.sampleCount,
          0,
        );
      const realizedVsExpected =
        allocationSlice?.realizedVsExpected ??
        inferRealizedVsExpected(variantState ?? null);
      const realizedEvSum =
        allocationSlice?.realizedEvSum ??
        Object.values(variantState?.regimeSnapshots ?? {}).reduce(
          (sum, snapshot) => sum + snapshot.realizedEvSum,
          0,
        );
      const concentrationPenaltyMultiplier =
        input.portfolioLearning.concentrationSignals[
          `concentration:${buildPortfolioSliceKey('variant', strategyVariantId)}`
        ]?.penaltyMultiplier ?? 1;
      const correlationPenaltyMultiplier =
        input.correlationPenaltyByVariant?.[strategyVariantId] ??
        inferCorrelationPenalty(input.portfolioLearning, strategyVariantId);

      const reasons: string[] = [];
      let targetMultiplier =
        performanceMultiplier(realizedVsExpected, realizedEvSum, reasons) *
        healthMultiplier('calibration', calibrationHealth, reasons) *
        healthMultiplier('execution', executionHealth, reasons) *
        sampleMultiplier(sampleCount, reasons) *
        drawdownMultiplier(drawdown?.currentDrawdown ?? 0, drawdown?.maxDrawdown ?? 0, reasons) *
        concentrationPenaltyMultiplier *
        correlationPenaltyMultiplier;

      if (concentrationPenaltyMultiplier < 1) {
        reasons.push(`concentration_penalty_${concentrationPenaltyMultiplier.toFixed(2)}`);
      }
      if (correlationPenaltyMultiplier < 1) {
        reasons.push(`correlation_penalty_${correlationPenaltyMultiplier.toFixed(2)}`);
      }

      if (variantRecord?.status === 'quarantined' || variantRecord?.status === 'retired') {
        targetMultiplier = 0;
        reasons.push(`variant_status_${variantRecord.status}`);
      } else if (variantRecord?.rolloutStage === 'shadow_only') {
        targetMultiplier = 0;
        reasons.push('shadow_only_variants_do_not_receive_live_capital');
      }

      targetMultiplier = clamp(targetMultiplier, 0, 1.5);
      const gate = this.promotionGate.evaluate({
        targetMultiplier,
        sampleCount,
        calibrationHealth,
        executionHealth,
        currentDrawdown: drawdown?.currentDrawdown ?? 0,
        concentrationPenaltyMultiplier,
        correlationPenaltyMultiplier,
      });
      const gatedTargetMultiplier = gate.allowScale ? targetMultiplier : Math.min(targetMultiplier, 1);
      const status =
        !gate.allowScale && targetMultiplier > 1
          ? 'block_scale'
          : gatedTargetMultiplier > 1.02
            ? 'increase'
            : gatedTargetMultiplier < 0.98
              ? 'reduce'
              : 'hold';
      decisions[strategyVariantId] = {
        decisionKey: `capital-allocation:${strategyVariantId}:${now.toISOString()}`,
        strategyVariantId,
        targetMultiplier: gatedTargetMultiplier,
        status,
        reasons: [...reasons, ...gate.reasons],
        evidence: {
          sampleCount,
          realizedVsExpected,
          realizedEvSum,
          calibrationHealth,
          executionHealth,
          currentDrawdown: drawdown?.currentDrawdown ?? 0,
          maxDrawdown: drawdown?.maxDrawdown ?? 0,
          concentrationPenaltyMultiplier,
          correlationPenaltyMultiplier,
          rolloutStage: variantRecord?.rolloutStage ?? null,
          variantStatus: variantRecord?.status ?? null,
        },
        decidedAt: now.toISOString(),
      };
    }

    return { decisions };
  }
}

function performanceMultiplier(
  realizedVsExpected: number | null,
  realizedEvSum: number,
  reasons: string[],
): number {
  if (realizedVsExpected == null) {
    reasons.push('performance_quality_unavailable');
    return 0.9;
  }
  if (realizedVsExpected < 0.8 || realizedEvSum < -0.02) {
    reasons.push('performance_quality_degraded');
    return 0.65;
  }
  if (realizedVsExpected > 1.05 && realizedEvSum > 0) {
    reasons.push('performance_quality_supportive');
    return 1.15;
  }
  reasons.push('performance_quality_neutral');
  return 1;
}

function healthMultiplier(
  label: 'calibration' | 'execution',
  health: HealthLabel,
  reasons: string[],
): number {
  if (health === 'quarantine_candidate') {
    reasons.push(`${label}_health_quarantine_candidate`);
    return 0.25;
  }
  if (health === 'degraded') {
    reasons.push(`${label}_health_degraded`);
    return 0.65;
  }
  if (health === 'watch') {
    reasons.push(`${label}_health_watch`);
    return 0.9;
  }
  return 1;
}

function sampleMultiplier(sampleCount: number, reasons: string[]): number {
  if (sampleCount >= 10) {
    reasons.push('sample_sufficiency_strong');
    return 1.05;
  }
  if (sampleCount >= 5) {
    reasons.push('sample_sufficiency_moderate');
    return 1;
  }
  reasons.push('sample_sufficiency_weak');
  return 0.75;
}

function drawdownMultiplier(
  currentDrawdown: number,
  maxDrawdown: number,
  reasons: string[],
): number {
  const effectiveDrawdown = Math.max(currentDrawdown, maxDrawdown);
  if (effectiveDrawdown >= 0.08) {
    reasons.push('drawdown_severe');
    return 0.4;
  }
  if (effectiveDrawdown >= 0.04) {
    reasons.push('drawdown_elevated');
    return 0.75;
  }
  return 1;
}

function inferRealizedVsExpected(
  variantState: LearningState['strategyVariants'][string] | null,
): number | null {
  const expectedEvSum = Object.values(variantState?.regimeSnapshots ?? {}).reduce(
    (sum, snapshot) => sum + snapshot.expectedEvSum,
    0,
  );
  const realizedEvSum = Object.values(variantState?.regimeSnapshots ?? {}).reduce(
    (sum, snapshot) => sum + snapshot.realizedEvSum,
    0,
  );
  return Math.abs(expectedEvSum) > 1e-9 ? realizedEvSum / expectedEvSum : null;
}

function inferCorrelationPenalty(
  portfolioLearning: PortfolioLearningState,
  strategyVariantId: string,
): number {
  return Object.values(portfolioLearning.correlationSignals)
    .filter(
      (signal) =>
        signal.leftVariantId === strategyVariantId ||
        signal.rightVariantId === strategyVariantId,
    )
    .reduce((penalty, signal) => Math.min(penalty, signal.penaltyMultiplier), 1);
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
