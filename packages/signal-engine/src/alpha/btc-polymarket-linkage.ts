export interface BtcPolymarketLinkageInput {
  lastReturnPct: number;
  rollingReturnPct: number;
  midpointDriftPct: number;
  topLevelImbalance: number;
  micropriceBias: number;
  flowImbalanceProxy: number;
  bookUpdateStress: number;
}

export interface BtcPolymarketLinkageOutput {
  btcMoveTransmission: number;
  btcLinkageConfidence: number;
}

export class BtcPolymarketLinkage {
  evaluate(input: BtcPolymarketLinkageInput): BtcPolymarketLinkageOutput {
    const btcImpulse = input.rollingReturnPct * 0.65 + input.lastReturnPct * 0.35;
    const impliedMove = input.midpointDriftPct + input.micropriceBias * 0.2;
    const alignment = direction(btcImpulse) * direction(impliedMove);
    const relativeTransmission =
      Math.abs(btcImpulse) > 1e-6
        ? Math.min(1, Math.abs(impliedMove) / Math.max(Math.abs(btcImpulse), 1e-6))
        : 0;
    const btcMoveTransmission = clamp(
      alignment * relativeTransmission +
        input.flowImbalanceProxy * 0.18 -
        input.bookUpdateStress * 0.12,
      -1,
      1,
    );
    const btcLinkageConfidence = clamp01(
      0.28 +
        Math.min(0.35, Math.abs(btcImpulse) * 65) +
        Math.min(
          0.2,
          Math.abs(input.topLevelImbalance) * 0.4 + Math.abs(input.micropriceBias) * 2.6,
        ) -
        input.bookUpdateStress * 0.2,
    );

    return {
      btcMoveTransmission,
      btcLinkageConfidence,
    };
  }
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
