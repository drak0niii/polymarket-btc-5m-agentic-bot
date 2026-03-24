export interface SizeVsLiquidityPolicyInput {
  desiredNotional: number;
  desiredSizeUnits: number;
  price: number;
  topLevelDepth: number;
  spread: number | null;
  expectedSlippage: number;
  route: 'maker' | 'taker';
}

export interface SizeVsLiquidityPolicyDecision {
  allowedNotional: number;
  allowedSizeUnits: number;
  liquidityMultiplier: number;
  blockTrade: boolean;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class SizeVsLiquidityPolicy {
  evaluate(input: SizeVsLiquidityPolicyInput): SizeVsLiquidityPolicyDecision {
    if (
      !Number.isFinite(input.price) ||
      input.price <= 0 ||
      !Number.isFinite(input.topLevelDepth) ||
      input.topLevelDepth <= 0
    ) {
      return {
        allowedNotional: 0,
        allowedSizeUnits: 0,
        liquidityMultiplier: 0,
        blockTrade: true,
        reasons: ['liquidity_reference_missing'],
        evidence: {
          ...input,
        },
      };
    }

    const participationCap =
      input.route === 'maker'
        ? 0.35
        : input.expectedSlippage >= 0.01 || (input.spread ?? 0) >= 0.04
          ? 0.4
          : 0.6;
    const depthCapUnits = input.topLevelDepth * participationCap;
    const sizeRatio = input.desiredSizeUnits / Math.max(1e-9, input.topLevelDepth);
    let liquidityMultiplier = input.desiredSizeUnits > 0 ? depthCapUnits / input.desiredSizeUnits : 1;

    if (input.expectedSlippage >= 0.02 || (input.spread ?? 0) >= 0.06) {
      liquidityMultiplier = 0;
    } else if (input.expectedSlippage >= 0.01 || sizeRatio > 0.6) {
      liquidityMultiplier = Math.min(liquidityMultiplier, 0.35);
    } else if (input.expectedSlippage >= 0.006 || sizeRatio > 0.4) {
      liquidityMultiplier = Math.min(liquidityMultiplier, 0.6);
    } else if (input.expectedSlippage >= 0.003 || sizeRatio > 0.25) {
      liquidityMultiplier = Math.min(liquidityMultiplier, 0.8);
    }

    liquidityMultiplier = clamp(liquidityMultiplier, 0, 1);
    const requestedNotional = Math.max(0, input.desiredNotional);
    const requestedSizeUnits = Math.max(0, input.desiredSizeUnits);
    const cappedSizeUnits = Math.max(
      0,
      Math.min(requestedSizeUnits, requestedSizeUnits * liquidityMultiplier),
    );
    const cappedNotional = cappedSizeUnits * input.price;
    const allowedNotional = Math.max(0, Math.min(requestedNotional, cappedNotional));
    const allowedSizeUnits = Math.max(0, Math.min(cappedSizeUnits, allowedNotional / input.price));
    const reasons: string[] = [];
    if (liquidityMultiplier <= 0) {
      reasons.push('liquidity_blocked_size');
    } else if (liquidityMultiplier < 1) {
      reasons.push('liquidity_reduced_size');
    }
    if (sizeRatio > 0.5) {
      reasons.push('nonlinear_slippage_detected');
    }
    if (input.expectedSlippage >= 0.01) {
      reasons.push('expected_slippage_high');
    }

    return {
      allowedNotional,
      allowedSizeUnits,
      liquidityMultiplier,
      blockTrade: allowedSizeUnits <= 0,
      reasons,
      evidence: {
        desiredNotional: input.desiredNotional,
        desiredSizeUnits: input.desiredSizeUnits,
        price: input.price,
        topLevelDepth: input.topLevelDepth,
        spread: input.spread ?? null,
        expectedSlippage: input.expectedSlippage,
        participationCap,
        sizeRatio,
      },
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
