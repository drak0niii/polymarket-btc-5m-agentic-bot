import {
  type CostEstimateBreakdown,
  type HealthLabel,
  type NetEdgeBreakdown,
  type NetEdgeDecision,
  type NetEdgeInput,
  type NetEdgeVenueUncertaintyLabel,
  type UncertaintyPenalty,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  buildNetRealismContext,
  type NetRealismContext,
} from './net-realism-context';

export class NetEdgeEstimator {
  estimate(
    input: NetEdgeInput & {
      realismContext?: NetRealismContext | null;
    },
  ): NetEdgeDecision {
    const missingInputs: string[] = [];

    if (!Number.isFinite(input.grossForecastEdge)) {
      missingInputs.push('gross_forecast_edge');
    }
    if (!Number.isFinite(input.expectedEv ?? Number.NaN)) {
      missingInputs.push('expected_ev');
    }
    if (!Number.isFinite(input.feeRate)) {
      missingInputs.push('fee_rate');
    }
    if (!Number.isFinite(input.signalAgeMs)) {
      missingInputs.push('signal_age_ms');
    }
    if (!Number.isFinite(input.halfLifeMultiplier)) {
      missingInputs.push('half_life_multiplier');
    }

    const grossForecastEdge = Math.max(0, input.grossForecastEdge);
    const realismContext =
      input.realismContext ??
      buildNetRealismContext({
        spreadAtDecision: input.spread ?? null,
        bookDepthAtIntendedPrice: input.topLevelDepth,
        expectedFillFraction: null,
        expectedQueueDelayMs: null,
        expectedPartialFillPenalty: null,
        expectedCancelReplacePenalty: null,
        venueUncertaintyLabel: input.venueUncertaintyLabel,
        feeScheduleLabel: null,
        venueMode: input.venueMode,
      });
    const spread = Math.max(0, realismContext.spreadAtDecision ?? input.spread ?? 0);
    const feeCost = Math.max(0, input.feeRate);
    const spreadComponent = spread * 0.5;
    const sizePressure = this.sizePressure(
      input.estimatedOrderSizeUnits,
      realismContext.bookDepthAtIntendedPrice ?? input.topLevelDepth,
    );
    const liquidityComponent = spread * sizePressure;
    const slippageCost = spreadComponent + liquidityComponent;
    const adverseSelectionCost = this.adverseSelectionCost({
      spread,
      signalAgeMs: input.signalAgeMs,
      halfLifeMultiplier: input.halfLifeMultiplier,
      venueUncertaintyLabel: input.venueUncertaintyLabel,
    });
    const queuePenaltyCost = this.queuePenaltyCost({
      grossForecastEdge,
      expectedFillFraction: realismContext.expectedFillFraction,
      expectedQueueDelayMs: realismContext.expectedQueueDelayMs,
      expectedPartialFillPenalty: realismContext.expectedPartialFillPenalty,
      expectedCancelReplacePenalty: realismContext.expectedCancelReplacePenalty,
      venueUncertaintyLabel: input.venueUncertaintyLabel,
      urgency: realismContext.urgency,
    });
    const venuePenalty = this.venuePenalty(
      input.venueUncertaintyLabel,
      input.venueMode,
    );

    const afterFeesEdge = grossForecastEdge - feeCost;
    const afterSlippageEdge = afterFeesEdge - slippageCost;
    const afterAdverseSelectionEdge = afterSlippageEdge - adverseSelectionCost;
    const afterQueueEdge = afterAdverseSelectionEdge - queuePenaltyCost;
    const uncertaintyPenalty = this.uncertaintyPenalty(input, grossForecastEdge);
    const afterUncertaintyEdge = afterQueueEdge - uncertaintyPenalty.totalPenalty;
    const finalNetEdge = afterUncertaintyEdge - venuePenalty;

    const staleInputs: string[] = [];
    if (input.signalAgeMs > 30_000) {
      staleInputs.push('aged_signal');
    }
    if (input.halfLifeMultiplier < 0.8) {
      staleInputs.push('edge_decay');
    }

    const reasons: string[] = [];
    if (finalNetEdge <= 0) {
      reasons.push('net_edge_non_positive');
      reasons.push(
        this.primaryCostReason({
          feeCost,
          slippageCost,
          adverseSelectionCost,
          queuePenaltyCost,
          uncertaintyPenalty: uncertaintyPenalty.totalPenalty,
          venuePenalty,
        }),
      );
    }
    if (input.venueUncertaintyLabel === 'unsafe') {
      reasons.push('venue_instability_penalty');
    }
    if (uncertaintyPenalty.totalPenalty >= Math.max(0.002, grossForecastEdge * 0.35)) {
      reasons.push('uncertainty_penalty_high');
    }
    if (queuePenaltyCost >= Math.max(0.001, grossForecastEdge * 0.2)) {
      reasons.push('queue_penalty_high');
    }
    if (missingInputs.length > 0) {
      reasons.push('net_edge_inputs_missing');
    }

    const breakdown: NetEdgeBreakdown = {
      grossForecastEdge,
      executionStyle: input.executionStyle,
      costEstimate: {
        feeCost,
        slippageCost,
        adverseSelectionCost,
        queuePenaltyCost,
        venuePenalty,
        spreadComponent,
        liquidityComponent,
        partialFillComponent:
          Math.max(
            0,
            (realismContext.expectedPartialFillPenalty ?? 0) -
              Math.max(0, (realismContext.expectedCancelReplacePenalty ?? 0) * 0.35),
          ),
        cancelReplaceComponent: Math.max(
          0,
          realismContext.expectedCancelReplacePenalty ?? 0,
        ),
        queueDelayComponent:
          Math.max(
            0,
            queuePenaltyCost -
              Math.max(0, realismContext.expectedPartialFillPenalty ?? 0) -
              Math.max(0, realismContext.expectedCancelReplacePenalty ?? 0),
          ),
        feeBps: toBps(feeCost),
        slippageBps: toBps(slippageCost),
        adverseSelectionPenaltyBps: toBps(adverseSelectionCost),
        queuePenaltyBps: toBps(queuePenaltyCost),
        totalCost:
          feeCost +
          slippageCost +
          adverseSelectionCost +
          queuePenaltyCost +
          venuePenalty,
      },
      uncertaintyPenalty,
      grossEdgeBps: toBps(grossForecastEdge),
      feeBps: toBps(feeCost),
      slippageBps: toBps(slippageCost),
      adverseSelectionPenaltyBps: toBps(adverseSelectionCost),
      queuePenaltyBps: toBps(queuePenaltyCost),
      uncertaintyPenaltyBps: toBps(uncertaintyPenalty.totalPenalty),
      netEdgeBps: toBps(finalNetEdge),
      afterFeesEdge,
      afterSlippageEdge,
      afterAdverseSelectionEdge,
      afterQueueEdge,
      afterUncertaintyEdge,
      finalNetEdge,
      missingInputs,
      staleInputs,
      paperEdgeBlocked: grossForecastEdge > 0 && finalNetEdge <= 0,
      confidence: this.confidence(input, grossForecastEdge, uncertaintyPenalty.totalPenalty),
      reasons,
    };

    return {
      recommendation:
        missingInputs.length === 0 && finalNetEdge > 0 && input.venueUncertaintyLabel !== 'unsafe'
          ? 'trade'
          : 'reject',
      reasonCodes:
        reasons.length > 0
          ? reasons
          : ['net_edge_positive'],
      breakdown,
    };
  }

  private sizePressure(
    estimatedOrderSizeUnits: number | null,
    topLevelDepth: number | null,
  ): number {
    if (
      !Number.isFinite(estimatedOrderSizeUnits ?? Number.NaN) ||
      !Number.isFinite(topLevelDepth ?? Number.NaN) ||
      (topLevelDepth ?? 0) <= 0
    ) {
      return 0.25;
    }

    const ratio = Math.max(0, (estimatedOrderSizeUnits ?? 0) / (topLevelDepth ?? 1));
    if (ratio <= 0.1) {
      return 0.15;
    }
    if (ratio <= 0.25) {
      return 0.3;
    }
    if (ratio <= 0.5) {
      return 0.6;
    }
    return 1;
  }

  private adverseSelectionCost(input: {
    spread: number;
    signalAgeMs: number;
    halfLifeMultiplier: number;
    venueUncertaintyLabel: NetEdgeVenueUncertaintyLabel | null;
  }): number {
    const agePenalty = Math.min(0.004, Math.max(0, input.signalAgeMs) / 300_000);
    const decayPenalty = Math.max(0, 1 - input.halfLifeMultiplier) * 0.004;
    const venuePenalty = input.venueUncertaintyLabel === 'degraded'
      ? 0.001
      : input.venueUncertaintyLabel === 'unsafe'
        ? 0.003
        : 0;
    return Math.max(0, input.spread * 0.25 + agePenalty + decayPenalty + venuePenalty);
  }

  private queuePenaltyCost(input: {
    grossForecastEdge: number;
    expectedFillFraction: number | null;
    expectedQueueDelayMs: number | null;
    expectedPartialFillPenalty: number | null;
    expectedCancelReplacePenalty: number | null;
    venueUncertaintyLabel: NetEdgeVenueUncertaintyLabel | null;
    urgency: string;
  }): number {
    const fillFraction = Math.max(0.25, Math.min(1, input.expectedFillFraction ?? 0.8));
    const queueDelayMs = Math.max(0, input.expectedQueueDelayMs ?? 15_000);
    const queueDelayComponent = Math.min(
      0.004,
      Math.max(0.0002, input.grossForecastEdge * 0.08) * (queueDelayMs / 15_000),
    );
    const partialFillComponent = Math.max(
      0,
      input.expectedPartialFillPenalty ??
        input.grossForecastEdge * (1 - fillFraction) * 0.22,
    );
    const cancelReplaceComponent = Math.max(
      0,
      input.expectedCancelReplacePenalty ??
        (input.urgency === 'high' ? 0.0012 : 0.0005),
    );
    const venueComponent =
      input.venueUncertaintyLabel === 'degraded'
        ? 0.0003
        : input.venueUncertaintyLabel === 'unsafe'
          ? 0.001
          : 0;
    return Math.max(
      0,
      queueDelayComponent + partialFillComponent + cancelReplaceComponent + venueComponent,
    );
  }

  private primaryCostReason(input: {
    feeCost: number;
    slippageCost: number;
    adverseSelectionCost: number;
    queuePenaltyCost: number;
    uncertaintyPenalty: number;
    venuePenalty: number;
  }): string {
    const components = [
      { reason: 'killed_by_fee_cost', value: input.feeCost },
      { reason: 'killed_by_slippage_cost', value: input.slippageCost },
      { reason: 'killed_by_adverse_selection', value: input.adverseSelectionCost },
      { reason: 'killed_by_queue_penalty', value: input.queuePenaltyCost },
      { reason: 'killed_by_uncertainty_penalty', value: input.uncertaintyPenalty },
      { reason: 'killed_by_venue_penalty', value: input.venuePenalty },
    ].sort((left, right) => right.value - left.value);
    return components[0]?.reason ?? 'killed_by_cost_stack';
  }

  private uncertaintyPenalty(
    input: NetEdgeInput,
    grossForecastEdge: number,
  ): UncertaintyPenalty {
    const calibrationPenalty =
      this.healthPenalty(input.calibrationHealth, {
        healthy: 0,
        watch: 0.0005,
        degraded: 0.0015,
        quarantine_candidate: 0.003,
      }) +
      Math.max(0, 1 - (input.calibrationShrinkageFactor ?? 1)) * 0.0015;

    const regimePenalty = this.healthPenalty(input.regimeHealth, {
      healthy: 0,
      watch: 0.0004,
      degraded: 0.0012,
      quarantine_candidate: 0.0025,
    });
    const freshnessPenalty = Math.min(0.003, Math.max(0, input.signalAgeMs) / 120_0000);
    const halfLifePenalty = Math.max(0, grossForecastEdge * (1 - input.halfLifeMultiplier));

    const reasons: string[] = [];
    if ((input.calibrationHealth ?? 'healthy') !== 'healthy') {
      reasons.push(`calibration_${input.calibrationHealth}`);
    }
    if ((input.regimeHealth ?? 'healthy') !== 'healthy') {
      reasons.push(`regime_${input.regimeHealth}`);
    }
    if (freshnessPenalty > 0.001) {
      reasons.push('signal_age_penalty');
    }
    if (halfLifePenalty > 0.001) {
      reasons.push('half_life_penalty');
    }

    return {
      calibrationPenalty,
      regimePenalty,
      freshnessPenalty,
      halfLifePenalty,
      totalPenalty:
        calibrationPenalty + regimePenalty + freshnessPenalty + halfLifePenalty,
      reasons,
    };
  }

  private venuePenalty(
    venueUncertaintyLabel: NetEdgeVenueUncertaintyLabel | null,
    venueMode: string | null,
  ): number {
    const labelPenalty =
      venueUncertaintyLabel === 'degraded'
        ? 0.001
        : venueUncertaintyLabel === 'unsafe'
          ? 0.004
          : 0;
    const modePenalty =
      venueMode === 'size-reduced'
        ? 0.0005
        : venueMode === 'cancel-only'
          ? 0.002
          : venueMode === 'reconciliation-only'
            ? 0.004
            : 0;
    return labelPenalty + modePenalty;
  }

  private confidence(
    input: NetEdgeInput,
    grossForecastEdge: number,
    totalUncertaintyPenalty: number,
  ): number {
    const expectedEvConfidence = Number.isFinite(input.expectedEv ?? Number.NaN)
      ? Math.max(0, Math.min(1, (input.expectedEv ?? 0) / Math.max(0.0001, grossForecastEdge)))
      : 0.2;
    const penaltyDrag = Math.max(
      0,
      Math.min(0.6, totalUncertaintyPenalty / Math.max(0.001, grossForecastEdge)),
    );
    return Math.max(0.1, Math.min(0.95, expectedEvConfidence * (1 - penaltyDrag)));
  }

  private healthPenalty(
    health: HealthLabel | null,
    penalties: Record<HealthLabel, number>,
  ): number {
    return penalties[health ?? 'healthy'] ?? 0;
  }
}

function toBps(value: number): number {
  return Math.round(value * 10_000 * 100) / 100;
}
