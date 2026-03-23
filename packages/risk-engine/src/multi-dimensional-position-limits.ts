export type PositionLimitReasonCode =
  | 'per_market_position_limit_exceeded'
  | 'per_outcome_position_limit_exceeded'
  | 'per_resolution_bucket_limit_exceeded'
  | 'aggregate_notional_limit_exceeded'
  | 'same_thesis_limit_exceeded'
  | 'passed';

export interface PositionLimitExposure {
  marketId: string;
  outcome: 'YES' | 'NO' | 'UNKNOWN';
  resolutionBucket: string;
  thesisKey: string;
  notional: number;
}

export interface MultiDimensionalPositionLimitInput {
  candidate: PositionLimitExposure;
  openPositions: PositionLimitExposure[];
  workingOrders: PositionLimitExposure[];
  limits: {
    maxPerMarketNotional: number;
    maxPerOutcomeNotional: number;
    maxPerResolutionBucketNotional: number;
    maxAggregateNotional: number;
    maxSameThesisNotional: number;
  };
}

export interface MultiDimensionalPositionLimitResult {
  passed: boolean;
  reasonCode: PositionLimitReasonCode;
  totals: {
    marketNotional: number;
    outcomeNotional: number;
    resolutionBucketNotional: number;
    aggregateNotional: number;
    sameThesisNotional: number;
  };
}

export class MultiDimensionalPositionLimits {
  evaluate(input: MultiDimensionalPositionLimitInput): MultiDimensionalPositionLimitResult {
    const exposures = [...input.openPositions, ...input.workingOrders];
    const aggregateNotional =
      exposures.reduce((sum, exposure) => sum + exposure.notional, 0) + input.candidate.notional;
    const marketNotional =
      exposures
        .filter((exposure) => exposure.marketId === input.candidate.marketId)
        .reduce((sum, exposure) => sum + exposure.notional, 0) + input.candidate.notional;
    const outcomeNotional =
      exposures
        .filter((exposure) => exposure.outcome === input.candidate.outcome)
        .reduce((sum, exposure) => sum + exposure.notional, 0) + input.candidate.notional;
    const resolutionBucketNotional =
      exposures
        .filter((exposure) => exposure.resolutionBucket === input.candidate.resolutionBucket)
        .reduce((sum, exposure) => sum + exposure.notional, 0) + input.candidate.notional;
    const sameThesisNotional =
      exposures
        .filter((exposure) => exposure.thesisKey === input.candidate.thesisKey)
        .reduce((sum, exposure) => sum + exposure.notional, 0) + input.candidate.notional;

    const totals = {
      marketNotional,
      outcomeNotional,
      resolutionBucketNotional,
      aggregateNotional,
      sameThesisNotional,
    };

    if (marketNotional > input.limits.maxPerMarketNotional) {
      return {
        passed: false,
        reasonCode: 'per_market_position_limit_exceeded',
        totals,
      };
    }

    if (outcomeNotional > input.limits.maxPerOutcomeNotional) {
      return {
        passed: false,
        reasonCode: 'per_outcome_position_limit_exceeded',
        totals,
      };
    }

    if (resolutionBucketNotional > input.limits.maxPerResolutionBucketNotional) {
      return {
        passed: false,
        reasonCode: 'per_resolution_bucket_limit_exceeded',
        totals,
      };
    }

    if (aggregateNotional > input.limits.maxAggregateNotional) {
      return {
        passed: false,
        reasonCode: 'aggregate_notional_limit_exceeded',
        totals,
      };
    }

    if (sameThesisNotional > input.limits.maxSameThesisNotional) {
      return {
        passed: false,
        reasonCode: 'same_thesis_limit_exceeded',
        totals,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      totals,
    };
  }
}
