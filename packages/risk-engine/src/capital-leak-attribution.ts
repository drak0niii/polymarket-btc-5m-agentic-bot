import type { HealthLabel, NetEdgeVenueUncertaintyLabel } from '@polymarket-btc-5m-agentic-bot/domain';

export type CapitalLeakCategory =
  | 'false_positive_forecast'
  | 'calibration_error'
  | 'slippage'
  | 'adverse_selection'
  | 'missed_fills'
  | 'overtrading'
  | 'poor_sizing'
  | 'degraded_regime_trading'
  | 'venue_degradation_cost';

export interface CapitalLeakAttributionInput {
  tradeId: string;
  orderId: string | null;
  signalId: string | null;
  marketId: string | null;
  strategyVariantId: string | null;
  regime: string | null;
  marketContext: string | null;
  executionStyle: string | null;
  observedAt: string;
  expectedEv: number | null;
  realizedEv: number | null;
  expectedSlippage: number | null;
  realizedSlippage: number | null;
  edgeAtSignal: number | null;
  edgeAtFill: number | null;
  fillRate: number | null;
  allocatedNotional: number | null;
  recommendedNotional: number | null;
  calibrationHealth: HealthLabel | null;
  regimeHealth: HealthLabel | null;
  venueUncertaintyLabel: NetEdgeVenueUncertaintyLabel | null;
  netEdgeAtDecision: number | null;
  netEdgeThreshold: number | null;
  policyBreaches: string[];
}

export interface CapitalLeakContribution {
  category: CapitalLeakCategory;
  leakAmount: number;
  share: number;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export interface CapitalLeakAttributionResult {
  tradeId: string;
  orderId: string | null;
  signalId: string | null;
  marketId: string | null;
  strategyVariantId: string | null;
  regime: string | null;
  marketContext: string | null;
  executionStyle: string | null;
  observedAt: string;
  expectedEv: number | null;
  realizedEv: number | null;
  totalLeak: number;
  contributions: CapitalLeakContribution[];
  dominantCategory: CapitalLeakCategory | null;
  dominantShare: number;
  reasons: string[];
}

export class CapitalLeakAttribution {
  attribute(input: CapitalLeakAttributionInput): CapitalLeakAttributionResult {
    const expectedEv = input.expectedEv ?? 0;
    const realizedEv = input.realizedEv ?? 0;
    const totalLeak = Math.max(0, expectedEv - realizedEv);
    if (totalLeak <= 0) {
      return {
        tradeId: input.tradeId,
        orderId: input.orderId,
        signalId: input.signalId,
        marketId: input.marketId,
        strategyVariantId: input.strategyVariantId,
        regime: input.regime,
        marketContext: input.marketContext,
        executionStyle: input.executionStyle,
        observedAt: input.observedAt,
        expectedEv: input.expectedEv,
        realizedEv: input.realizedEv,
        totalLeak,
        contributions: [],
        dominantCategory: null,
        dominantShare: 0,
        reasons: [],
      };
    }

    const raw = new Map<CapitalLeakCategory, { weight: number; reasons: string[]; evidence: Record<string, unknown> }>();

    this.pushRaw(raw, 'slippage', Math.max(0, (input.realizedSlippage ?? 0) - (input.expectedSlippage ?? 0)), [
      'realized_slippage_exceeded_expected',
    ], {
      expectedSlippage: input.expectedSlippage,
      realizedSlippage: input.realizedSlippage,
    });

    this.pushRaw(
      raw,
      'adverse_selection',
      Math.max(0, (input.edgeAtSignal ?? 0) - (input.edgeAtFill ?? input.edgeAtSignal ?? 0)),
      ['edge_decay_between_signal_and_fill'],
      {
        edgeAtSignal: input.edgeAtSignal,
        edgeAtFill: input.edgeAtFill,
      },
    );

    this.pushRaw(
      raw,
      'missed_fills',
      expectedEv * Math.max(0, 1 - (input.fillRate ?? 1)),
      ['fill_rate_below_full_capture'],
      {
        fillRate: input.fillRate,
        expectedEv,
      },
    );

    this.pushRaw(
      raw,
      'poor_sizing',
      this.sizingLeak(input),
      ['allocated_notional_diverged_from_recommended'],
      {
        allocatedNotional: input.allocatedNotional,
        recommendedNotional: input.recommendedNotional,
      },
    );

    this.pushRaw(
      raw,
      'degraded_regime_trading',
      this.healthLeak(input.regimeHealth, {
        watch: totalLeak * 0.15,
        degraded: totalLeak * 0.3,
        quarantine_candidate: totalLeak * 0.45,
      }),
      input.regimeHealth ? [`regime_${input.regimeHealth}`] : [],
      {
        regimeHealth: input.regimeHealth,
      },
    );

    this.pushRaw(
      raw,
      'calibration_error',
      this.healthLeak(input.calibrationHealth, {
        watch: totalLeak * 0.12,
        degraded: totalLeak * 0.25,
        quarantine_candidate: totalLeak * 0.4,
      }),
      input.calibrationHealth ? [`calibration_${input.calibrationHealth}`] : [],
      {
        calibrationHealth: input.calibrationHealth,
      },
    );

    this.pushRaw(
      raw,
      'venue_degradation_cost',
      input.venueUncertaintyLabel === 'degraded'
        ? totalLeak * 0.2
        : input.venueUncertaintyLabel === 'unsafe'
          ? totalLeak * 0.45
          : 0,
      input.venueUncertaintyLabel && input.venueUncertaintyLabel !== 'healthy'
        ? [`venue_${input.venueUncertaintyLabel}`]
        : [],
      {
        venueUncertaintyLabel: input.venueUncertaintyLabel,
      },
    );

    const overtradingTriggered =
      (input.netEdgeAtDecision ?? 0) < (input.netEdgeThreshold ?? 0) ||
      input.policyBreaches.some((breach) =>
        ['no_trade_zone', 'weak_net_edge', 'low_margin_opportunity'].includes(breach),
      );
    this.pushRaw(
      raw,
      'overtrading',
      overtradingTriggered ? totalLeak * 0.35 : 0,
      overtradingTriggered ? ['trade_taken_despite_marginal_or_blocked_conditions'] : [],
      {
        netEdgeAtDecision: input.netEdgeAtDecision,
        netEdgeThreshold: input.netEdgeThreshold,
        policyBreaches: input.policyBreaches,
      },
    );

    const forecastResidual =
      expectedEv > 0 && realizedEv <= 0 ? totalLeak * 0.5 : totalLeak * 0.15;
    this.pushRaw(
      raw,
      'false_positive_forecast',
      forecastResidual,
      ['forecast_edge_not_realized'],
      {
        expectedEv,
        realizedEv,
      },
    );

    const contributions = this.normalize(raw, totalLeak);
    const dominant = contributions[0] ?? null;

    return {
      tradeId: input.tradeId,
      orderId: input.orderId,
      signalId: input.signalId,
      marketId: input.marketId,
      strategyVariantId: input.strategyVariantId,
      regime: input.regime,
      marketContext: input.marketContext,
      executionStyle: input.executionStyle,
      observedAt: input.observedAt,
      expectedEv: input.expectedEv,
      realizedEv: input.realizedEv,
      totalLeak,
      contributions,
      dominantCategory: dominant?.category ?? null,
      dominantShare: dominant?.share ?? 0,
      reasons: contributions.flatMap((contribution) => contribution.reasons),
    };
  }

  private pushRaw(
    raw: Map<CapitalLeakCategory, { weight: number; reasons: string[]; evidence: Record<string, unknown> }>,
    category: CapitalLeakCategory,
    weight: number,
    reasons: string[],
    evidence: Record<string, unknown>,
  ): void {
    if (!Number.isFinite(weight) || weight <= 0) {
      return;
    }

    raw.set(category, {
      weight,
      reasons,
      evidence,
    });
  }

  private normalize(
    raw: Map<CapitalLeakCategory, { weight: number; reasons: string[]; evidence: Record<string, unknown> }>,
    totalLeak: number,
  ): CapitalLeakContribution[] {
    const totalWeight = Array.from(raw.values()).reduce((sum, entry) => sum + entry.weight, 0);
    if (totalWeight <= 0) {
      return [];
    }

    return Array.from(raw.entries())
      .map(([category, entry]) => {
        const leakAmount = totalLeak * (entry.weight / totalWeight);
        const share = leakAmount / totalLeak;
        return {
          category,
          leakAmount,
          share,
          reasons: entry.reasons,
          evidence: entry.evidence,
        };
      })
      .sort((left, right) => right.leakAmount - left.leakAmount);
  }

  private healthLeak(
    health: HealthLabel | null,
    weights: Record<'watch' | 'degraded' | 'quarantine_candidate', number>,
  ): number {
    if (health === 'watch') {
      return weights.watch;
    }
    if (health === 'degraded') {
      return weights.degraded;
    }
    if (health === 'quarantine_candidate') {
      return weights.quarantine_candidate;
    }
    return 0;
  }

  private sizingLeak(input: CapitalLeakAttributionInput): number {
    if (
      !Number.isFinite(input.allocatedNotional ?? Number.NaN) ||
      !Number.isFinite(input.recommendedNotional ?? Number.NaN) ||
      (input.recommendedNotional ?? 0) <= 0
    ) {
      return 0;
    }

    const divergence =
      Math.abs((input.allocatedNotional ?? 0) - (input.recommendedNotional ?? 0)) /
      (input.recommendedNotional ?? 1);
    if (divergence <= 0.2) {
      return 0;
    }
    return Math.max(0, (input.expectedEv ?? 0) * Math.min(1, divergence));
  }
}
