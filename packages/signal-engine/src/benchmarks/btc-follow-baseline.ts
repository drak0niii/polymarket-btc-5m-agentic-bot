export type BenchmarkTradeSide = 'UP' | 'DOWN' | 'NO_TRADE';
export type BenchmarkOpportunityClass =
  | 'strong_edge'
  | 'tradable_edge'
  | 'marginal_edge'
  | 'weak_edge';

export interface BenchmarkReplayCase {
  observationId: string;
  observedAt: string;
  regime: string;
  marketImpliedProbabilityUp: number;
  realizedOutcomeUp: number;
  fillRate: number;
  spreadCost: number;
  slippageCost: number;
  feeCost: number;
  latencyCost: number;
  timeoutCancelCost: number;
  timeBucket: string;
  marketStructureBucket: string;
  featureSnapshot: {
    rollingReturnPct: number;
    lastReturnPct: number;
    realizedVolatility: number;
    spread: number;
    topLevelDepth: number;
    combinedDepth: number;
    orderbookNoiseScore: number;
    timeToExpirySeconds: number | null;
  };
}

export interface BenchmarkTradeRecord {
  observationId: string;
  observedAt: string;
  regime: string;
  side: BenchmarkTradeSide;
  expectedEv: number;
  realizedEv: number;
  opportunityClass: BenchmarkOpportunityClass;
  traded: boolean;
}

export interface BenchmarkRegimeBreakdown {
  regime: string;
  sampleCount: number;
  tradeCount: number;
  expectedEv: number;
  realizedEv: number;
  realizedVsExpected: number | null;
  opportunityClassDistribution: Record<BenchmarkOpportunityClass, number>;
}

export interface BenchmarkSummary {
  benchmarkId: string;
  benchmarkName: string;
  sampleCount: number;
  tradeCount: number;
  expectedEv: number;
  realizedEv: number;
  realizedVsExpected: number | null;
  opportunityClassDistribution: Record<BenchmarkOpportunityClass, number>;
  regimeBreakdown: BenchmarkRegimeBreakdown[];
  assumptions: string[];
  generatedAt: string;
}

export interface BenchmarkEvaluationConfig {
  benchmarkId: string;
  benchmarkName: string;
  cases: BenchmarkReplayCase[];
  assumptions: string[];
  evaluateCase: (input: BenchmarkReplayCase) => {
    side: Exclude<BenchmarkTradeSide, 'NO_TRADE'> | 'NO_TRADE';
    probabilityOffset: number;
  };
}

export class BtcFollowBaseline {
  evaluate(cases: BenchmarkReplayCase[]): BenchmarkSummary {
    return runBenchmarkEvaluation({
      benchmarkId: 'btc_follow_baseline',
      benchmarkName: 'BTC Follow Baseline',
      assumptions: [
        'Trades in the direction of recent BTC-linked return pressure.',
        'Uses only rolling and short-horizon return features plus simple liquidity moderation.',
      ],
      cases,
      evaluateCase: (input) => {
        const returnSignal =
          input.featureSnapshot.rollingReturnPct * 85 +
          input.featureSnapshot.lastReturnPct * 55;
        const liquidityPenalty =
          input.featureSnapshot.topLevelDepth < 20 ? 0.08 : 0;
        const score = clamp(returnSignal - liquidityPenalty, -1, 1);
        return {
          side: resolveSide(score, 0.12),
          probabilityOffset: clamp(Math.abs(score) * 0.09, 0, 0.12),
        };
      },
    });
  }
}

export function runBenchmarkEvaluation(
  config: BenchmarkEvaluationConfig,
): BenchmarkSummary {
  const tradeRecords = config.cases.map((input) =>
    buildTradeRecord(input, config.evaluateCase(input)),
  );

  const opportunityClassDistribution = createOpportunityClassDistribution();
  for (const record of tradeRecords) {
    opportunityClassDistribution[record.opportunityClass] += 1;
  }

  const regimeGroups = new Map<string, BenchmarkTradeRecord[]>();
  for (const record of tradeRecords) {
    const group = regimeGroups.get(record.regime) ?? [];
    group.push(record);
    regimeGroups.set(record.regime, group);
  }

  return {
    benchmarkId: config.benchmarkId,
    benchmarkName: config.benchmarkName,
    sampleCount: tradeRecords.length,
    tradeCount: tradeRecords.filter((record) => record.traded).length,
    expectedEv: average(tradeRecords.map((record) => record.expectedEv)),
    realizedEv: average(tradeRecords.map((record) => record.realizedEv)),
    realizedVsExpected: ratio(
      sum(tradeRecords.map((record) => record.realizedEv)),
      sum(tradeRecords.map((record) => record.expectedEv)),
    ),
    opportunityClassDistribution,
    regimeBreakdown: Array.from(regimeGroups.entries())
      .map(([regime, records]) => ({
        regime,
        sampleCount: records.length,
        tradeCount: records.filter((record) => record.traded).length,
        expectedEv: average(records.map((record) => record.expectedEv)),
        realizedEv: average(records.map((record) => record.realizedEv)),
        realizedVsExpected: ratio(
          sum(records.map((record) => record.realizedEv)),
          sum(records.map((record) => record.expectedEv)),
        ),
        opportunityClassDistribution: records.reduce(
          (distribution, record) => {
            distribution[record.opportunityClass] += 1;
            return distribution;
          },
          createOpportunityClassDistribution(),
        ),
      }))
      .sort((left, right) => left.regime.localeCompare(right.regime)),
    assumptions: config.assumptions,
    generatedAt: new Date().toISOString(),
  };
}

export function buildTradeRecord(
  input: BenchmarkReplayCase,
  decision: {
    side: Exclude<BenchmarkTradeSide, 'NO_TRADE'> | 'NO_TRADE';
    probabilityOffset: number;
  },
): BenchmarkTradeRecord {
  if (decision.side === 'NO_TRADE') {
    return {
      observationId: input.observationId,
      observedAt: input.observedAt,
      regime: input.regime,
      side: 'NO_TRADE',
      expectedEv: 0,
      realizedEv: 0,
      opportunityClass: 'weak_edge',
      traded: false,
    };
  }

  const marketProbability =
    decision.side === 'UP'
      ? input.marketImpliedProbabilityUp
      : 1 - input.marketImpliedProbabilityUp;
  const predictedProbability = clamp(
    marketProbability + decision.probabilityOffset,
    0.01,
    0.99,
  );
  const totalCost =
    input.feeCost +
    input.slippageCost +
    input.spreadCost +
    input.latencyCost +
    input.timeoutCancelCost;
  const expectedEv = (predictedProbability - marketProbability) * input.fillRate - totalCost;
  const realizedOutcome =
    decision.side === 'UP' ? input.realizedOutcomeUp : 1 - input.realizedOutcomeUp;
  const realizedEv =
    (realizedOutcome > 0.5 ? 1 - marketProbability : -marketProbability) - totalCost;

  return {
    observationId: input.observationId,
    observedAt: input.observedAt,
    regime: input.regime,
    side: decision.side,
    expectedEv,
    realizedEv,
    opportunityClass: classifyOpportunity(expectedEv),
    traded: true,
  };
}

export function resolveSide(
  score: number,
  minimumMagnitude: number,
): Exclude<BenchmarkTradeSide, 'NO_TRADE'> | 'NO_TRADE' {
  if (Math.abs(score) < minimumMagnitude) {
    return 'NO_TRADE';
  }

  return score >= 0 ? 'UP' : 'DOWN';
}

export function classifyOpportunity(expectedEv: number): BenchmarkOpportunityClass {
  if (expectedEv >= 0.012) {
    return 'strong_edge';
  }
  if (expectedEv >= 0.006) {
    return 'tradable_edge';
  }
  if (expectedEv > 0) {
    return 'marginal_edge';
  }
  return 'weak_edge';
}

export function createOpportunityClassDistribution(): Record<
  BenchmarkOpportunityClass,
  number
> {
  return {
    strong_edge: 0,
    tradable_edge: 0,
    marginal_edge: 0,
    weak_edge: 0,
  };
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return sum(values) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= 1e-9) {
    return null;
  }

  return numerator / denominator;
}
