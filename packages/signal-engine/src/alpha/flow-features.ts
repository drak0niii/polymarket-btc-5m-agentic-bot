export interface FlowFeaturesInput {
  lastReturnPct: number;
  rollingReturnPct: number;
  volumeTrend: number;
  topLevelImbalance: number;
  micropriceBias: number;
  spreadToDepthRatio: number;
  depthConcentration: number;
  orderbookNoiseScore: number;
}

export interface FlowFeaturesOutput {
  flowImbalanceProxy: number;
  flowIntensity: number;
  bookUpdateStress: number;
}

export class FlowFeaturesCalculator {
  derive(input: FlowFeaturesInput): FlowFeaturesOutput {
    const directionalFlow = signedVolumeImpulse(
      input.lastReturnPct,
      input.rollingReturnPct,
      input.volumeTrend,
    );
    const bookPressure = clamp(
      input.topLevelImbalance * 0.7 + input.micropriceBias * 4,
      -1,
      1,
    );
    const flowImbalanceProxy = clamp(
      directionalFlow * 0.45 + bookPressure * 0.55,
      -1,
      1,
    );
    const flowIntensity = clamp01(
      Math.abs(input.volumeTrend) * 0.45 +
        Math.abs(input.lastReturnPct) * 28 +
        Math.abs(input.rollingReturnPct) * 14 +
        Math.abs(bookPressure) * 0.2,
    );
    const bookUpdateStress = clamp01(
      input.spreadToDepthRatio * 1_500 +
        Math.abs(input.topLevelImbalance - input.micropriceBias) * 1.4 +
        Math.max(0, input.depthConcentration - 0.35) * 1.15 +
        input.orderbookNoiseScore * 0.75,
    );

    return {
      flowImbalanceProxy,
      flowIntensity,
      bookUpdateStress,
    };
  }
}

function signedVolumeImpulse(
  lastReturnPct: number,
  rollingReturnPct: number,
  volumeTrend: number,
): number {
  const directionalReturn = Math.abs(lastReturnPct) >= Math.abs(rollingReturnPct)
    ? lastReturnPct
    : rollingReturnPct;
  const direction =
    directionalReturn > 0 ? 1 : directionalReturn < 0 ? -1 : 0;
  return clamp(direction * Math.min(1, Math.abs(volumeTrend)), -1, 1);
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
