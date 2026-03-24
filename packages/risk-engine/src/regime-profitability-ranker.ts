import type {
  ExecutionLearningContext,
  HealthLabel,
  RegimePerformanceSnapshot,
  TradeQualityScore,
} from '@polymarket-btc-5m-agentic-bot/domain';

export type RegimeProfitabilityRank =
  | 'strong_regime'
  | 'tradable_regime'
  | 'marginal_regime'
  | 'avoid_regime';

export interface RegimeProfitabilityRankerInput {
  strategyVariantId: string | null;
  regime: string | null;
  regimeSnapshot: RegimePerformanceSnapshot | null;
  calibrationHealth: HealthLabel | null;
  executionContext: ExecutionLearningContext | null;
  recentTradeQualityScores: TradeQualityScore[];
  currentDrawdownPct: number | null;
  maxDrawdownPct: number | null;
  recentLeakShare: number | null;
}

export interface RegimeProfitabilityMetrics {
  netEv: number;
  realizedEvRetention: number | null;
  drawdownScore: number;
  calibrationScore: number;
  executionQualityScore: number;
  sampleSufficiencyScore: number;
  sampleCount: number;
  averageTradeQualityScore: number | null;
  destructiveTradeShare: number;
  recentLeakShare: number | null;
}

export interface RegimeProfitabilityAssessment {
  strategyVariantId: string | null;
  regime: string | null;
  rank: RegimeProfitabilityRank;
  score: number;
  reasons: string[];
  metrics: RegimeProfitabilityMetrics;
  evidence: Record<string, unknown>;
}

export class RegimeProfitabilityRanker {
  rank(input: RegimeProfitabilityRankerInput): RegimeProfitabilityAssessment {
    const sampleCount = Math.max(
      input.regimeSnapshot?.sampleCount ?? 0,
      input.executionContext?.sampleCount ?? 0,
      input.recentTradeQualityScores.length,
    );
    const netEv =
      input.regimeSnapshot?.avgRealizedEv ??
      safeAverage(
        input.recentTradeQualityScores.map((score) =>
          readNumber(score.breakdown.realizedOutcomeQuality.evidence.realizedEv),
        ),
      ) ??
      0;
    const realizedEvRetention =
      input.regimeSnapshot?.realizedVsExpected ??
      inferRealizedEvRetention(input.regimeSnapshot) ??
      null;
    const drawdownComponent = scoreDrawdown(
      input.currentDrawdownPct ?? null,
      input.maxDrawdownPct ?? null,
    );
    const calibrationScore = healthScore(input.calibrationHealth, 1);
    const executionQualityComponent = scoreExecutionQuality(
      input.executionContext,
      input.recentTradeQualityScores,
    );
    const sampleSufficiencyScore = sampleScore(sampleCount);
    const averageTradeQualityScore =
      safeAverage(input.recentTradeQualityScores.map((score) => score.breakdown.overallScore)) ??
      null;
    const destructiveTradeShareRatio = calculateDestructiveTradeShare(
      input.recentTradeQualityScores,
    );

    const components = [
      netEvScore(netEv),
      retentionScore(realizedEvRetention),
      drawdownComponent,
      calibrationScore,
      executionQualityComponent,
      sampleSufficiencyScore,
      leakScore(input.recentLeakShare),
      qualityScore(averageTradeQualityScore, destructiveTradeShareRatio),
    ];
    const score = clamp(
      components.reduce((sum, component) => sum + component, 0) / components.length,
      0,
      1,
    );
    const reasons = buildReasons({
      netEv,
      realizedEvRetention,
      sampleCount,
      calibrationHealth: input.calibrationHealth,
      executionContext: input.executionContext,
      currentDrawdownPct: input.currentDrawdownPct,
      maxDrawdownPct: input.maxDrawdownPct,
      averageTradeQualityScore,
      destructiveTradeShare: destructiveTradeShareRatio,
      recentLeakShare: input.recentLeakShare,
    });

    return {
      strategyVariantId: input.strategyVariantId,
      regime: input.regime,
      rank: classifyRank({
        score,
        netEv,
        realizedEvRetention,
        sampleCount,
        calibrationHealth: input.calibrationHealth,
        executionHealth: input.executionContext?.health ?? null,
        destructiveTradeShare: destructiveTradeShareRatio,
      }),
      score,
      reasons,
      metrics: {
        netEv,
        realizedEvRetention,
        drawdownScore: drawdownComponent,
        calibrationScore,
        executionQualityScore: executionQualityComponent,
        sampleSufficiencyScore,
        sampleCount,
        averageTradeQualityScore,
        destructiveTradeShare: destructiveTradeShareRatio,
        recentLeakShare: input.recentLeakShare,
      },
      evidence: {
        regimeSnapshot: input.regimeSnapshot,
        calibrationHealth: input.calibrationHealth,
        executionContext: input.executionContext,
        currentDrawdownPct: input.currentDrawdownPct,
        maxDrawdownPct: input.maxDrawdownPct,
        recentTradeQualityCount: input.recentTradeQualityScores.length,
        recentLeakShare: input.recentLeakShare,
      },
    };
  }
}

function classifyRank(input: {
  score: number;
  netEv: number;
  realizedEvRetention: number | null;
  sampleCount: number;
  calibrationHealth: HealthLabel | null;
  executionHealth: HealthLabel | null;
  destructiveTradeShare: number;
}): RegimeProfitabilityRank {
  if (
    input.score < 0.38 ||
    (input.sampleCount >= 5 &&
      input.netEv <= 0 &&
      (input.realizedEvRetention ?? 0) < 0.7) ||
    input.calibrationHealth === 'quarantine_candidate' ||
    input.executionHealth === 'quarantine_candidate' ||
    input.destructiveTradeShare >= 0.5
  ) {
    return 'avoid_regime';
  }

  if (
    input.score < 0.6 ||
    input.netEv <= 0 ||
    (input.realizedEvRetention != null && input.realizedEvRetention < 0.85)
  ) {
    return 'marginal_regime';
  }

  if (
    input.score >= 0.82 &&
    input.netEv > 0 &&
    (input.realizedEvRetention ?? 0) >= 0.95 &&
    input.sampleCount >= 8
  ) {
    return 'strong_regime';
  }

  return 'tradable_regime';
}

function buildReasons(input: {
  netEv: number;
  realizedEvRetention: number | null;
  sampleCount: number;
  calibrationHealth: HealthLabel | null;
  executionContext: ExecutionLearningContext | null;
  currentDrawdownPct: number | null;
  maxDrawdownPct: number | null;
  averageTradeQualityScore: number | null;
  destructiveTradeShare: number;
  recentLeakShare: number | null;
}): string[] {
  const reasons: string[] = [];

  if (input.netEv > 0.01) {
    reasons.push('regime_net_ev_strong');
  } else if (input.netEv > 0) {
    reasons.push('regime_net_ev_positive');
  } else {
    reasons.push('regime_net_ev_non_positive');
  }

  if ((input.realizedEvRetention ?? 0) >= 0.95) {
    reasons.push('regime_ev_retention_strong');
  } else if ((input.realizedEvRetention ?? 0) >= 0.8) {
    reasons.push('regime_ev_retention_tradable');
  } else {
    reasons.push('regime_ev_retention_weak');
  }

  if (Math.max(input.currentDrawdownPct ?? 0, input.maxDrawdownPct ?? 0) >= 0.08) {
    reasons.push('regime_drawdown_severe');
  } else if (Math.max(input.currentDrawdownPct ?? 0, input.maxDrawdownPct ?? 0) >= 0.04) {
    reasons.push('regime_drawdown_elevated');
  } else {
    reasons.push('regime_drawdown_stable');
  }

  if (input.calibrationHealth) {
    reasons.push(`regime_calibration_${input.calibrationHealth}`);
  }
  if (input.executionContext?.health) {
    reasons.push(`regime_execution_${input.executionContext.health}`);
  }
  if (input.sampleCount >= 10) {
    reasons.push('regime_sample_sufficiency_strong');
  } else if (input.sampleCount >= 5) {
    reasons.push('regime_sample_sufficiency_moderate');
  } else {
    reasons.push('regime_sample_sufficiency_weak');
  }
  if ((input.averageTradeQualityScore ?? 1) < 0.55) {
    reasons.push('recent_trade_quality_weak');
  }
  if (input.destructiveTradeShare >= 0.4) {
    reasons.push('recent_trade_quality_destructive_share_elevated');
  }
  if ((input.recentLeakShare ?? 0) >= 0.35) {
    reasons.push('recent_capital_leak_elevated');
  }

  return reasons;
}

function netEvScore(netEv: number): number {
  if (netEv >= 0.02) {
    return 1;
  }
  if (netEv > 0) {
    return 0.7;
  }
  if (netEv > -0.01) {
    return 0.4;
  }
  return 0.1;
}

function retentionScore(retention: number | null): number {
  if (retention == null) {
    return 0.45;
  }
  if (retention >= 1) {
    return 1;
  }
  if (retention >= 0.9) {
    return 0.8;
  }
  if (retention >= 0.75) {
    return 0.6;
  }
  if (retention >= 0.5) {
    return 0.35;
  }
  return 0.1;
}

function scoreDrawdown(currentDrawdownPct: number | null, maxDrawdownPct: number | null): number {
  const drawdown = Math.max(currentDrawdownPct ?? 0, maxDrawdownPct ?? 0);
  if (drawdown >= 0.1) {
    return 0.1;
  }
  if (drawdown >= 0.06) {
    return 0.35;
  }
  if (drawdown >= 0.03) {
    return 0.6;
  }
  return 0.9;
}

function healthScore(health: HealthLabel | null, healthyValue: number): number {
  if (health === 'quarantine_candidate') {
    return 0.05;
  }
  if (health === 'degraded') {
    return 0.35;
  }
  if (health === 'watch') {
    return 0.65;
  }
  return healthyValue;
}

function scoreExecutionQuality(
  executionContext: ExecutionLearningContext | null,
  recentTradeQualityScores: TradeQualityScore[],
): number {
  const qualityAverage = safeAverage(
    recentTradeQualityScores.map((score) => score.breakdown.executionQuality.score),
  );
  if (qualityAverage != null) {
    return qualityAverage;
  }

  const healthComponent = healthScore(executionContext?.health ?? null, 0.85);
  const fillRate =
    executionContext != null
      ? Math.max(executionContext.makerFillRate, executionContext.takerFillRate)
      : null;
  const slippagePenalty =
    executionContext?.averageSlippage != null && executionContext.averageSlippage > 0.004
      ? 0.2
      : executionContext?.averageSlippage != null && executionContext.averageSlippage > 0.0025
        ? 0.1
        : 0;
  const fillPenalty =
    fillRate != null && fillRate < 0.65 ? 0.2 : fillRate != null && fillRate < 0.8 ? 0.1 : 0;

  return clamp(healthComponent - slippagePenalty - fillPenalty, 0, 1);
}

function sampleScore(sampleCount: number): number {
  if (sampleCount >= 12) {
    return 1;
  }
  if (sampleCount >= 8) {
    return 0.8;
  }
  if (sampleCount >= 5) {
    return 0.6;
  }
  if (sampleCount >= 3) {
    return 0.4;
  }
  return 0.15;
}

function leakScore(leakShare: number | null): number {
  if (leakShare == null) {
    return 0.55;
  }
  if (leakShare >= 0.45) {
    return 0.15;
  }
  if (leakShare >= 0.3) {
    return 0.35;
  }
  if (leakShare >= 0.15) {
    return 0.6;
  }
  return 0.85;
}

function qualityScore(
  averageTradeQualityScore: number | null,
  destructiveTradeShare: number,
): number {
  const base = averageTradeQualityScore ?? 0.55;
  const penalty =
    destructiveTradeShare >= 0.5
      ? 0.35
      : destructiveTradeShare >= 0.3
        ? 0.2
        : destructiveTradeShare >= 0.15
          ? 0.1
          : 0;
  return clamp(base - penalty, 0, 1);
}

function inferRealizedEvRetention(snapshot: RegimePerformanceSnapshot | null): number | null {
  if (!snapshot) {
    return null;
  }
  return Math.abs(snapshot.expectedEvSum) > 1e-9
    ? snapshot.realizedEvSum / snapshot.expectedEvSum
    : null;
}

function calculateDestructiveTradeShare(scores: TradeQualityScore[]): number {
  if (scores.length === 0) {
    return 0;
  }
  const destructiveCount = scores.filter((score) => score.label === 'destructive').length;
  return destructiveCount / scores.length;
}

function safeAverage(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value ?? Number.NaN));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
