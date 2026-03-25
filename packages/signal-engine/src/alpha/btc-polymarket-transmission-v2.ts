export interface BtcPolymarketTransmissionV2Input {
  recentBtcReturns: number[];
  lastReturnPct: number;
  rollingReturnPct: number;
  midpointDriftPct: number;
  micropriceBias: number;
  flowImbalanceProxy: number;
  bookUpdateStress: number;
}

export interface BtcPolymarketTransmissionV2Output {
  laggedBtcMoveTransmission: number;
  nonlinearBtcMoveSensitivity: number;
  btcPathDivergence: number;
  transmissionConsistency: number;
}

export class BtcPolymarketTransmissionV2 {
  evaluate(
    input: BtcPolymarketTransmissionV2Input,
  ): BtcPolymarketTransmissionV2Output {
    const recentReturns =
      input.recentBtcReturns.filter((value) => Number.isFinite(value)) ?? [];
    const laggedWindow = recentReturns.slice(-4, -1);
    const laggedImpulse = weightedAverage(
      laggedWindow.length > 0 ? laggedWindow : recentReturns.slice(-3),
    );
    const currentImpulse = input.rollingReturnPct * 0.58 + input.lastReturnPct * 0.42;
    const marketProbabilityResponse =
      input.midpointDriftPct +
      input.micropriceBias * 0.22 +
      input.flowImbalanceProxy * 0.012;
    const laggedBtcMoveTransmission = clamp(
      signedTransmissionRatio(laggedImpulse, marketProbabilityResponse) -
        input.bookUpdateStress * 0.08,
      -1,
      1,
    );
    const moveMagnitude = Math.max(Math.abs(currentImpulse), Math.abs(laggedImpulse));
    const nonlinearBtcMoveSensitivity = clamp01(
      Math.tanh(moveMagnitude * 140) *
        (0.62 +
          Math.min(0.2, Math.abs(marketProbabilityResponse) * 70) +
          Math.max(0, 0.18 - input.bookUpdateStress) * 0.55),
    );
    const directionMismatch =
      direction(currentImpulse) !== 0 &&
      direction(marketProbabilityResponse) !== 0 &&
      direction(currentImpulse) !== direction(marketProbabilityResponse)
        ? 0.38
        : 0;
    const btcPathDivergence = clamp01(
      Math.abs(currentImpulse - marketProbabilityResponse) * 90 +
        Math.abs(laggedImpulse - marketProbabilityResponse) * 45 +
        directionMismatch +
        input.bookUpdateStress * 0.12,
    );
    const transmissionConsistency = clamp01(
      0.18 +
        alignmentShare(recentReturns, marketProbabilityResponse) * 0.52 +
        Math.min(0.18, averageAbsolute(recentReturns) * 80) -
        btcPathDivergence * 0.24 -
        dispersionPenalty(recentReturns) * 0.22 -
        input.bookUpdateStress * 0.12,
    );

    return {
      laggedBtcMoveTransmission,
      nonlinearBtcMoveSensitivity,
      btcPathDivergence,
      transmissionConsistency,
    };
  }
}

function weightedAverage(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const weights = values.map((_, index) => index + 1);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) {
    return 0;
  }

  return values.reduce((sum, value, index) => sum + value * weights[index]!, 0) / totalWeight;
}

function signedTransmissionRatio(btcMove: number, marketResponse: number): number {
  if (Math.abs(btcMove) <= 1e-9 || Math.abs(marketResponse) <= 1e-9) {
    return 0;
  }

  return (
    direction(btcMove) *
    direction(marketResponse) *
    Math.min(1, Math.abs(marketResponse) / Math.max(Math.abs(btcMove), 1e-9))
  );
}

function alignmentShare(values: number[], marketResponse: number): number {
  const informative = values.filter((value) => Math.abs(value) > 1e-9);
  if (informative.length === 0 || Math.abs(marketResponse) <= 1e-9) {
    return 0.5;
  }

  const alignedCount = informative.filter(
    (value) => direction(value) === direction(marketResponse),
  ).length;
  return alignedCount / informative.length;
}

function averageAbsolute(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
}

function dispersionPenalty(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return clamp01(Math.sqrt(variance) * 220);
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
