export interface ExpectedExecutionCostBreakdown {
  feeCost: number;
  slippageCost: number;
  adverseSelectionCost: number;
  fillDecayCost: number;
  cancelReplaceOverheadCost: number;
  missedOpportunityCost: number;
  venuePenalty: number;
  totalCost: number;
}

export interface RealizedExecutionCostBreakdown {
  feeCost: number;
  slippageCost: number;
  adverseSelectionCost: number;
  fillDecayCost: number;
  cancelReplaceOverheadCost: number;
  missedOpportunityCost: number;
  venuePenalty: number;
  totalCost: number;
}

export interface AlphaAttributionInput {
  rawForecastProbability: number;
  marketImpliedProbability: number;
  confidenceAdjustedEdge?: number | null;
  paperEdge?: number | null;
  expectedExecutionCost?: Partial<ExpectedExecutionCostBreakdown> | null;
  expectedNetEdge?: number | null;
  realizedExecutionCost?: Partial<RealizedExecutionCostBreakdown> | null;
  realizedNetEdge?: number | null;
  capturedAt?: string | Date | null;
}

export interface AlphaAttributionOutput {
  rawForecastProbability: number;
  marketImpliedProbability: number;
  rawForecastEdge: number;
  confidenceAdjustedEdge: number;
  paperEdge: number;
  expectedExecutionCost: ExpectedExecutionCostBreakdown;
  expectedNetEdge: number;
  realizedExecutionCost: RealizedExecutionCostBreakdown | null;
  realizedNetEdge: number | null;
  retentionRatio: number | null;
  capturedAt: string;
}

export function createAlphaAttribution(
  input: AlphaAttributionInput,
): AlphaAttributionOutput {
  const rawForecastProbability = clampProbability(input.rawForecastProbability);
  const marketImpliedProbability = clampProbability(input.marketImpliedProbability);
  const rawForecastEdge = rawForecastProbability - marketImpliedProbability;
  const confidenceAdjustedEdge = normalizeNumber(
    input.confidenceAdjustedEdge,
    rawForecastEdge,
  );
  const paperEdge = normalizeNumber(input.paperEdge, confidenceAdjustedEdge);
  const expectedExecutionCost = normalizeCostBreakdown(input.expectedExecutionCost);
  const expectedNetEdge = normalizeNumber(
    input.expectedNetEdge,
    paperEdge - expectedExecutionCost.totalCost,
  );
  const realizedExecutionCost =
    input.realizedExecutionCost != null
      ? normalizeCostBreakdown(input.realizedExecutionCost)
      : null;
  const realizedNetEdge =
    realizedExecutionCost != null
      ? normalizeNullableNumber(
          input.realizedNetEdge,
          paperEdge - realizedExecutionCost.totalCost,
        )
      : normalizeNullableNumber(input.realizedNetEdge, null);

  return {
    rawForecastProbability,
    marketImpliedProbability,
    rawForecastEdge,
    confidenceAdjustedEdge,
    paperEdge,
    expectedExecutionCost,
    expectedNetEdge,
    realizedExecutionCost,
    realizedNetEdge,
    retentionRatio: calculateRetentionRatio(expectedNetEdge, realizedNetEdge),
    capturedAt: normalizeTimestamp(input.capturedAt),
  };
}

function normalizeCostBreakdown(
  input: Partial<ExpectedExecutionCostBreakdown> | Partial<RealizedExecutionCostBreakdown> | null | undefined,
): ExpectedExecutionCostBreakdown {
  const feeCost = nonNegative(input?.feeCost);
  const slippageCost = nonNegative(input?.slippageCost);
  const adverseSelectionCost = nonNegative(input?.adverseSelectionCost);
  const fillDecayCost = nonNegative(input?.fillDecayCost);
  const cancelReplaceOverheadCost = nonNegative(input?.cancelReplaceOverheadCost);
  const missedOpportunityCost = nonNegative(input?.missedOpportunityCost);
  const venuePenalty = nonNegative(input?.venuePenalty);
  const explicitTotal = normalizeNullableNumber(input?.totalCost, null);
  const totalCost =
    explicitTotal ??
    feeCost +
      slippageCost +
      adverseSelectionCost +
      fillDecayCost +
      cancelReplaceOverheadCost +
      missedOpportunityCost +
      venuePenalty;

  return {
    feeCost,
    slippageCost,
    adverseSelectionCost,
    fillDecayCost,
    cancelReplaceOverheadCost,
    missedOpportunityCost,
    venuePenalty,
    totalCost,
  };
}

function calculateRetentionRatio(
  expectedNetEdge: number,
  realizedNetEdge: number | null,
): number | null {
  if (realizedNetEdge == null) {
    return null;
  }

  if (Math.abs(expectedNetEdge) <= 1e-9) {
    return Math.abs(realizedNetEdge) <= 1e-9 ? 1 : null;
  }

  return realizedNetEdge / expectedNetEdge;
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

function nonNegative(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return 0;
  }

  return Math.max(0, value ?? 0);
}

function normalizeNumber(value: number | null | undefined, fallback: number): number {
  return normalizeNullableNumber(value, fallback) ?? fallback;
}

function normalizeNullableNumber(
  value: number | null | undefined,
  fallback: number | null,
): number | null {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return fallback;
  }

  return value ?? fallback;
}

function normalizeTimestamp(value: string | Date | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}
