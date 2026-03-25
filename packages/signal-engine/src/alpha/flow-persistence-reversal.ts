export interface FlowPersistenceReversalInput {
  recentReturns: number[];
  topLevelImbalance: number;
  micropriceBias: number;
  flowImbalanceProxy: number;
  flowIntensity: number;
  spreadToDepthRatio: number;
  depthConcentration: number;
  orderbookNoiseScore: number;
  bidLevels: Array<{ price: number; size: number }>;
  askLevels: Array<{ price: number; size: number }>;
}

export interface FlowPersistenceReversalOutput {
  imbalancePersistence: number;
  imbalanceReversalProbability: number;
  quoteInstabilityBeforeMove: number;
  depthDepletionAsymmetry: number;
}

export class FlowPersistenceReversal {
  evaluate(
    input: FlowPersistenceReversalInput,
  ): FlowPersistenceReversalOutput {
    const returns = input.recentReturns.filter((value) => Number.isFinite(value));
    const flowAnchor =
      input.topLevelImbalance * 0.42 +
      input.micropriceBias * 0.28 +
      input.flowImbalanceProxy * 0.3;
    const returnAlignment = directionalAlignment(returns, flowAnchor);
    const oppositionShare = directionalOpposition(returns, flowAnchor);
    const quoteInstabilityBeforeMove = clamp01(
      input.orderbookNoiseScore * 0.46 +
        Math.min(0.24, input.spreadToDepthRatio * 120) +
        Math.max(0, input.depthConcentration - 0.46) * 0.32 +
        Math.abs(input.topLevelImbalance - input.micropriceBias) * 0.34,
    );
    const depthDepletionAsymmetry = computeDepthDepletionAsymmetry({
      bidLevels: input.bidLevels,
      askLevels: input.askLevels,
    });
    const imbalancePersistence = clamp01(
      0.16 +
        returnAlignment * 0.44 +
        Math.min(0.2, Math.abs(flowAnchor) * 0.45) +
        input.flowIntensity * 0.12 -
        quoteInstabilityBeforeMove * 0.2 -
        oppositionShare * 0.08,
    );
    const imbalanceReversalProbability = clamp01(
      0.12 +
        oppositionShare * 0.42 +
        quoteInstabilityBeforeMove * 0.24 +
        Math.max(0, 0.58 - imbalancePersistence) * 0.34 +
        Math.abs(depthDepletionAsymmetry) * 0.08,
    );

    return {
      imbalancePersistence,
      imbalanceReversalProbability,
      quoteInstabilityBeforeMove,
      depthDepletionAsymmetry,
    };
  }
}

function directionalAlignment(values: number[], anchor: number): number {
  const informative = values.filter((value) => Math.abs(value) > 1e-9);
  if (informative.length === 0 || Math.abs(anchor) <= 1e-9) {
    return 0.5;
  }

  const aligned = informative.filter(
    (value) => direction(value) === direction(anchor),
  ).length;
  return aligned / informative.length;
}

function directionalOpposition(values: number[], anchor: number): number {
  const informative = values.filter((value) => Math.abs(value) > 1e-9);
  if (informative.length === 0 || Math.abs(anchor) <= 1e-9) {
    return 0.25;
  }

  const opposed = informative.filter(
    (value) => direction(value) !== direction(anchor),
  ).length;
  return opposed / informative.length;
}

function computeDepthDepletionAsymmetry(input: {
  bidLevels: Array<{ price: number; size: number }>;
  askLevels: Array<{ price: number; size: number }>;
}): number {
  const totalBidDepth = input.bidLevels.reduce((sum, level) => sum + level.size, 0);
  const totalAskDepth = input.askLevels.reduce((sum, level) => sum + level.size, 0);
  const combinedDepth = totalBidDepth + totalAskDepth;
  const topBidShare =
    totalBidDepth > 0 ? (input.bidLevels[0]?.size ?? 0) / totalBidDepth : 0;
  const topAskShare =
    totalAskDepth > 0 ? (input.askLevels[0]?.size ?? 0) / totalAskDepth : 0;
  const depthSkew =
    combinedDepth > 0 ? (totalBidDepth - totalAskDepth) / combinedDepth : 0;

  return clamp(
    (topAskShare - topBidShare) * 0.62 + depthSkew * 0.38,
    -1,
    1,
  );
}

function direction(value: number): number {
  if (!Number.isFinite(value) || value === 0) {
    return 0;
  }

  return value > 0 ? 1 : -1;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
