export interface RealizedCostModelInput {
  grossEdge: number | null;
  feeCost: number;
  slippageCost: number;
  adverseSelectionCost: number;
  fillDelayMs: number | null;
  expectedFillDelayMs: number | null;
  cancelReplaceOverheadCost: number;
  missedOpportunityCost: number;
}

export interface RealizedCostBreakdown {
  feeCost: number;
  slippageCost: number;
  adverseSelectionCost: number;
  queueDelayCost: number;
  fillDecayCost: number;
  cancelReplaceOverheadCost: number;
  missedOpportunityCost: number;
  realizedFeeBps: number;
  realizedSlippageBps: number;
  realizedAdverseSelectionBps: number;
  realizedQueueDelayCostBps: number;
  totalCost: number;
}

export interface RealizedCostModelResult {
  retainedEdge: number | null;
  retainedEdgeBps: number | null;
  breakdown: RealizedCostBreakdown;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class RealizedCostModel {
  evaluate(input: RealizedCostModelInput): RealizedCostModelResult {
    const grossEdge =
      input.grossEdge != null && Number.isFinite(input.grossEdge) ? input.grossEdge : null;
    const fillDelayMs =
      input.fillDelayMs != null && Number.isFinite(input.fillDelayMs)
        ? Math.max(0, input.fillDelayMs)
        : null;
    const expectedFillDelayMs =
      input.expectedFillDelayMs != null && Number.isFinite(input.expectedFillDelayMs)
        ? Math.max(0, input.expectedFillDelayMs)
        : null;
    const fillDecayCost = this.fillDecayCost({
      grossEdge,
      fillDelayMs,
      expectedFillDelayMs,
    });
    const queueDelayCost = this.queueDelayCost({
      grossEdge,
      fillDelayMs,
      expectedFillDelayMs,
    });
    const breakdown: RealizedCostBreakdown = {
      feeCost: Math.max(0, input.feeCost),
      slippageCost: Math.max(0, input.slippageCost),
      adverseSelectionCost: Math.max(0, input.adverseSelectionCost),
      queueDelayCost,
      fillDecayCost,
      cancelReplaceOverheadCost: Math.max(0, input.cancelReplaceOverheadCost),
      missedOpportunityCost: Math.max(0, input.missedOpportunityCost),
      realizedFeeBps: 0,
      realizedSlippageBps: 0,
      realizedAdverseSelectionBps: 0,
      realizedQueueDelayCostBps: 0,
      totalCost: 0,
    };
    breakdown.totalCost =
      breakdown.feeCost +
      breakdown.slippageCost +
      breakdown.adverseSelectionCost +
      breakdown.queueDelayCost +
      breakdown.fillDecayCost +
      breakdown.cancelReplaceOverheadCost +
      breakdown.missedOpportunityCost;
    breakdown.realizedFeeBps = toBps(breakdown.feeCost);
    breakdown.realizedSlippageBps = toBps(breakdown.slippageCost);
    breakdown.realizedAdverseSelectionBps = toBps(breakdown.adverseSelectionCost);
    breakdown.realizedQueueDelayCostBps = toBps(breakdown.queueDelayCost);

    const reasons: string[] = [];
    if (breakdown.slippageCost >= 0.006) {
      reasons.push('slippage_cost_high');
    }
    if (breakdown.adverseSelectionCost >= 0.004) {
      reasons.push('adverse_selection_cost_high');
    }
    if (breakdown.fillDecayCost >= 0.002) {
      reasons.push('fill_decay_cost_high');
    }
    if (breakdown.queueDelayCost >= 0.0015) {
      reasons.push('queue_delay_cost_high');
    }
    if (breakdown.cancelReplaceOverheadCost >= 0.0015) {
      reasons.push('cancel_replace_cost_high');
    }
    if (breakdown.missedOpportunityCost >= 0.002) {
      reasons.push('missed_opportunity_cost_high');
    }
    if (grossEdge != null && grossEdge - breakdown.totalCost <= 0) {
      reasons.push('cost_adjusted_edge_non_positive');
    }

    const retainedEdge = grossEdge != null ? grossEdge - breakdown.totalCost : null;

    return {
      retainedEdge,
      retainedEdgeBps: retainedEdge != null ? toBps(retainedEdge) : null,
      breakdown,
      reasons,
      evidence: {
        grossEdge,
        fillDelayMs,
        expectedFillDelayMs,
      },
    };
  }

  private fillDecayCost(input: {
    grossEdge: number | null;
    fillDelayMs: number | null;
    expectedFillDelayMs: number | null;
  }): number {
    const referenceDelayMs = Math.max(10_000, input.expectedFillDelayMs ?? 20_000);
    const observedDelayMs = input.fillDelayMs ?? input.expectedFillDelayMs ?? referenceDelayMs;
    const delayRatio = Math.max(0, observedDelayMs - referenceDelayMs) / referenceDelayMs;
    const baseline = input.grossEdge != null ? Math.max(0.0004, input.grossEdge * 0.08) : 0.0008;
    return Math.min(0.006, baseline * Math.min(4, 1 + delayRatio));
  }

  private queueDelayCost(input: {
    grossEdge: number | null;
    fillDelayMs: number | null;
    expectedFillDelayMs: number | null;
  }): number {
    const expectedDelayMs = Math.max(5_000, input.expectedFillDelayMs ?? 12_000);
    const observedDelayMs = Math.max(expectedDelayMs, input.fillDelayMs ?? expectedDelayMs);
    const excessDelayMs = Math.max(0, observedDelayMs - expectedDelayMs);
    const baseline = input.grossEdge != null ? Math.max(0.0002, input.grossEdge * 0.04) : 0.0006;
    return Math.min(0.004, baseline * (excessDelayMs / expectedDelayMs));
  }
}

function toBps(value: number): number {
  return Math.round(value * 10_000 * 100) / 100;
}
