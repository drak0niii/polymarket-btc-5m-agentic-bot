import { CanonicalAccountState } from '@polymarket-btc-5m-agentic-bot/domain';
import { ExecutionQualityKillSwitches } from './execution-quality-kill-switches';
import {
  type ExecutionStateAnomaly,
  type ExecutionAnomalyRuntimeState,
} from './execution-state-anomaly-detector';
import { KillSwitchTrigger } from './kill-switch';
import { SafetyState, maxSafetyState } from './safety-state';

export interface PortfolioKillSwitchVenueInstabilityInput {
  postFailureCount: number;
  cancelFailureCount: number;
  cancelFailuresWithWorkingOrders: number;
  heartbeatFailuresWithOpenOrders: number;
  divergenceStatus: 'none' | 'warning' | 'critical';
  staleBookRejectCount: number;
  totalRecentDecisions: number;
  abnormalCancelLatencyCount?: number;
  repeatedPartialFillToxicityCount?: number;
  fillQualityDriftCount?: number;
  realizedVsExpectedCostBlowoutCount?: number;
}

export interface PortfolioKillSwitchInput {
  accountState: CanonicalAccountState;
  diagnostics: Array<{
    expectedSlippage: number | null;
    realizedSlippage: number | null;
    expectedEv: number | null;
    realizedEv: number | null;
    staleOrder: boolean;
  }>;
  venueInstability: PortfolioKillSwitchVenueInstabilityInput;
  executionStateAnomalies?: ExecutionStateAnomaly[];
  limits?: {
    maxIntradayDrawdownPct?: number;
    maxHourlyDrawdownPct?: number;
    maxConsecutiveLosses?: number;
    maxLargestMarketRatio?: number;
    maxLargestTokenRatio?: number;
  };
}

export interface PortfolioKillSwitchResult {
  triggers: KillSwitchTrigger[];
  blockNewEntries: boolean;
  forceReduction: boolean;
  recommendedState: SafetyState;
  recommendedRuntimeState: ExecutionAnomalyRuntimeState;
  runtimeReasonChain: string[];
  reasonCodes: string[];
}

export class PortfolioKillSwitchService {
  private readonly executionQuality = new ExecutionQualityKillSwitches();

  evaluate(input: PortfolioKillSwitchInput): PortfolioKillSwitchResult {
    const triggers: KillSwitchTrigger[] = [];
    const bankroll = Math.max(input.accountState.bankroll, 1);
    const maxIntradayDrawdownPct = input.limits?.maxIntradayDrawdownPct ?? 5;
    const maxHourlyDrawdownPct = input.limits?.maxHourlyDrawdownPct ?? 2.5;
    const maxConsecutiveLosses = input.limits?.maxConsecutiveLosses ?? 2;
    const maxLargestMarketRatio = input.limits?.maxLargestMarketRatio ?? 0.35;
    const maxLargestTokenRatio = input.limits?.maxLargestTokenRatio ?? 0.3;

    const intradayDrawdownPct =
      (Math.abs(Math.min(0, input.accountState.realizedPnlDay + input.accountState.unrealizedPnl)) /
        bankroll) *
      100;
    if (intradayDrawdownPct >= maxIntradayDrawdownPct) {
      triggers.push({
        family: 'intraday_drawdown',
        reasonCode: 'intraday_drawdown_limit_reached',
        severity: intradayDrawdownPct >= maxIntradayDrawdownPct * 1.5 ? 5 : 4,
        recommendedState:
          intradayDrawdownPct >= maxIntradayDrawdownPct * 1.5 ? 'halt' : 'no_new_entries',
        blockNewEntries: true,
        forceReduction: intradayDrawdownPct >= maxIntradayDrawdownPct * 1.5,
        evidence: {
          intradayDrawdownPct,
          maxIntradayDrawdownPct,
        },
      });
    }

    const hourlyDrawdownPct =
      (Math.abs(Math.min(0, input.accountState.realizedPnlHour)) / bankroll) * 100;
    if (hourlyDrawdownPct >= maxHourlyDrawdownPct) {
      triggers.push({
        family: 'hourly_drawdown',
        reasonCode: 'hourly_drawdown_limit_reached',
        severity: hourlyDrawdownPct >= maxHourlyDrawdownPct * 1.5 ? 4 : 3,
        recommendedState:
          hourlyDrawdownPct >= maxHourlyDrawdownPct * 1.5 ? 'no_new_entries' : 'passive_only',
        blockNewEntries: true,
        forceReduction: false,
        evidence: {
          hourlyDrawdownPct,
          maxHourlyDrawdownPct,
        },
      });
    }

    if (input.accountState.consecutiveLosses >= maxConsecutiveLosses) {
      triggers.push({
        family: 'consecutive_losses',
        reasonCode: 'consecutive_loss_limit_reached',
        severity:
          input.accountState.consecutiveLosses >= maxConsecutiveLosses + 1 ? 5 : 4,
        recommendedState:
          input.accountState.consecutiveLosses >= maxConsecutiveLosses + 1
            ? 'halt'
            : 'no_new_entries',
        blockNewEntries: true,
        forceReduction: input.accountState.consecutiveLosses >= maxConsecutiveLosses + 1,
        evidence: {
          consecutiveLosses: input.accountState.consecutiveLosses,
          maxConsecutiveLosses,
        },
      });
    }

    if (
      input.accountState.concentration.largestMarketRatio >= maxLargestMarketRatio ||
      input.accountState.concentration.largestTokenRatio >= maxLargestTokenRatio
    ) {
      const marketExceeded =
        input.accountState.concentration.largestMarketRatio >= maxLargestMarketRatio;
      const tokenExceeded =
        input.accountState.concentration.largestTokenRatio >= maxLargestTokenRatio;
      triggers.push({
        family: 'exposure_concentration',
        reasonCode: marketExceeded
          ? 'market_concentration_limit_reached'
          : 'token_concentration_limit_reached',
        severity:
          input.accountState.concentration.largestMarketRatio >= maxLargestMarketRatio * 1.25 ||
          input.accountState.concentration.largestTokenRatio >= maxLargestTokenRatio * 1.25
            ? 4
            : 3,
        recommendedState: 'no_new_entries',
        blockNewEntries: true,
        forceReduction:
          input.accountState.concentration.largestMarketRatio >= maxLargestMarketRatio * 1.25 ||
          input.accountState.concentration.largestTokenRatio >= maxLargestTokenRatio * 1.25,
        evidence: {
          largestMarketRatio: input.accountState.concentration.largestMarketRatio,
          largestTokenRatio: input.accountState.concentration.largestTokenRatio,
          largestMarketId: input.accountState.concentration.largestMarketId,
          largestTokenId: input.accountState.concentration.largestTokenId,
        },
      });
    }

    triggers.push(
      ...this.executionQuality.evaluate({
        diagnostics: input.diagnostics,
        ...input.venueInstability,
      }).triggers,
    );

    if (!input.accountState.freshness.allowNewEntries) {
      triggers.push({
        family: 'data_freshness',
        reasonCode:
          input.accountState.freshness.reasonCodes[0] ?? 'account_state_freshness_degraded',
        severity: input.accountState.freshness.state === 'stale' ? 5 : 3,
        recommendedState:
          input.accountState.freshness.state === 'stale' ? 'halt' : 'no_new_entries',
        blockNewEntries: true,
        forceReduction: input.accountState.freshness.state === 'stale',
        evidence: {
          freshnessState: input.accountState.freshness.state,
          reasonCodes: input.accountState.freshness.reasonCodes.join(','),
          marketStreamHealthy: input.accountState.freshness.marketStreamHealthy,
          userStreamHealthy: input.accountState.freshness.userStreamHealthy,
        },
      });
    }

    let recommendedState: SafetyState = 'normal';
    for (const trigger of triggers) {
      recommendedState = maxSafetyState(recommendedState, trigger.recommendedState);
    }

    const anomalyRuntimeState = deriveRuntimeStateFromAnomalies(
      input.executionStateAnomalies ?? [],
    );
    const triggerRuntimeState = deriveRuntimeStateFromTriggers(triggers);
    const recommendedRuntimeState = maxRuntimeState(anomalyRuntimeState, triggerRuntimeState);

    return {
      triggers,
      blockNewEntries:
        triggers.some((trigger) => trigger.blockNewEntries) ||
        recommendedRuntimeState !== 'running',
      forceReduction:
        triggers.some((trigger) => trigger.forceReduction) ||
        recommendedRuntimeState === 'cancel_only' ||
        recommendedRuntimeState === 'halted_hard',
      recommendedState,
      recommendedRuntimeState,
      runtimeReasonChain: [
        ...new Set([
          ...(input.executionStateAnomalies ?? []).map((anomaly) => anomaly.reasonCode),
          ...triggers.map((trigger) => trigger.reasonCode),
        ]),
      ],
      reasonCodes: [
        ...new Set([
          ...(input.executionStateAnomalies ?? []).map((anomaly) => anomaly.reasonCode),
          ...triggers.map((trigger) => trigger.reasonCode),
        ]),
      ],
    };
  }
}

function deriveRuntimeStateFromAnomalies(
  anomalies: ExecutionStateAnomaly[],
): ExecutionAnomalyRuntimeState {
  if (anomalies.length === 0) {
    return 'running';
  }
  if (anomalies.some((anomaly) => anomaly.recommendedRuntimeState === 'halted_hard')) {
    return 'halted_hard';
  }
  if (anomalies.some((anomaly) => anomaly.recommendedRuntimeState === 'cancel_only')) {
    return 'cancel_only';
  }
  if (anomalies.some((anomaly) => anomaly.recommendedRuntimeState === 'reconciliation_only')) {
    return 'reconciliation_only';
  }
  return 'degraded';
}

function deriveRuntimeStateFromTriggers(
  triggers: KillSwitchTrigger[],
): ExecutionAnomalyRuntimeState {
  const highestSeverity = Math.max(0, ...triggers.map((trigger) => trigger.severity));
  if (highestSeverity >= 5) {
    return 'halted_hard';
  }
  if (highestSeverity >= 4) {
    return 'cancel_only';
  }
  if (highestSeverity >= 3) {
    return 'reconciliation_only';
  }
  return triggers.length > 0 ? 'degraded' : 'running';
}

function maxRuntimeState(
  left: ExecutionAnomalyRuntimeState,
  right: ExecutionAnomalyRuntimeState,
): ExecutionAnomalyRuntimeState {
  const priority: Record<ExecutionAnomalyRuntimeState, number> = {
    running: 0,
    degraded: 1,
    reconciliation_only: 2,
    cancel_only: 3,
    halted_hard: 4,
  };
  return priority[left] >= priority[right] ? left : right;
}
