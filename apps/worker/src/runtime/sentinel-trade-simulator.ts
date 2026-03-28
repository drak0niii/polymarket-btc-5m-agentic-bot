import type {
  SentinelSimulatedTradeRecord,
  TradingOperatingMode,
} from '@polymarket-btc-5m-agentic-bot/domain';

interface SentinelSimulationInput {
  signalId: string;
  marketId: string;
  tokenId: string;
  strategyVersionId: string | null;
  strategyVariantId: string | null;
  regime: string | null;
  side: 'BUY' | 'SELL';
  simulatedAt?: string;
  operatingMode?: TradingOperatingMode;
  expectedFillProbability: number | null;
  expectedFillFraction: number | null;
  expectedQueueDelayMs: number | null;
  expectedFeeBps: number | null;
  expectedSlippageBps: number | null;
  expectedNetEdgeAfterCostsBps: number;
  rationale?: string[];
  evidenceRefs?: string[];
}

export class SentinelTradeSimulator {
  simulate(input: SentinelSimulationInput): SentinelSimulatedTradeRecord {
    const expectedFillProbability = clamp01(input.expectedFillProbability ?? 0.8);
    const expectedFillFraction = clamp01(input.expectedFillFraction ?? 0.95);
    const expectedQueueDelayMs = normalizeNullableNumber(input.expectedQueueDelayMs, 500);
    const expectedFeeBps = Math.max(0, input.expectedFeeBps ?? 20);
    const expectedSlippageBps = Math.max(0, input.expectedSlippageBps ?? 6);
    const expectedNetEdgeAfterCostsBps = roundTo(input.expectedNetEdgeAfterCostsBps, 4);
    const seed = seededUnitInterval(
      [
        input.signalId,
        input.marketId,
        input.tokenId,
        input.strategyVersionId ?? 'none',
        input.regime ?? 'none',
      ].join('|'),
    );

    const realizedFillProbability = clamp01(
      expectedFillProbability - 0.1 + seed * 0.18,
    );
    const realizedFillFraction = clamp01(
      expectedFillFraction - 0.08 + seededUnitInterval(`${input.signalId}:fraction`) * 0.14,
    );
    const realizedQueueDelayMs = expectedQueueDelayMs
      ? Math.max(
          0,
          Math.round(
            expectedQueueDelayMs *
              (0.85 + seededUnitInterval(`${input.signalId}:queue`) * 0.45),
          ),
        )
      : null;
    const realizedFeeBps = roundTo(
      expectedFeeBps * (0.95 + seededUnitInterval(`${input.signalId}:fee`) * 0.1),
      4,
    );
    const realizedSlippageBps = roundTo(
      expectedSlippageBps * (0.8 + seededUnitInterval(`${input.signalId}:slippage`) * 0.7),
      4,
    );
    const fillPenaltyBps = roundTo(
      Math.max(0, 1 - realizedFillFraction) * 6 +
        Math.max(0, expectedFillProbability - realizedFillProbability) * 10,
      4,
    );
    const realizedNetEdgeAfterCostsBps = roundTo(
      expectedNetEdgeAfterCostsBps -
        Math.max(0, realizedFeeBps - expectedFeeBps) -
        Math.max(0, realizedSlippageBps - expectedSlippageBps) -
        fillPenaltyBps,
      4,
    );
    const expectedVsRealizedEdgeGapBps = roundTo(
      Math.abs(expectedNetEdgeAfterCostsBps - realizedNetEdgeAfterCostsBps),
      4,
    );

    return {
      simulationTradeId: `sentinel:${input.signalId}`,
      signalId: input.signalId,
      marketId: input.marketId,
      tokenId: input.tokenId,
      strategyVersionId: input.strategyVersionId,
      strategyVariantId: input.strategyVariantId,
      regime: input.regime,
      simulatedAt: input.simulatedAt ?? new Date().toISOString(),
      side: input.side,
      operatingMode: input.operatingMode ?? 'sentinel_simulation',
      expectedFillProbability,
      realizedFillProbability,
      expectedFillFraction,
      realizedFillFraction,
      expectedQueueDelayMs,
      realizedQueueDelayMs,
      expectedFeeBps: roundTo(expectedFeeBps, 4),
      realizedFeeBps,
      expectedSlippageBps: roundTo(expectedSlippageBps, 4),
      realizedSlippageBps,
      expectedNetEdgeAfterCostsBps,
      realizedNetEdgeAfterCostsBps,
      expectedVsRealizedEdgeGapBps,
      fillQualityPassed:
        realizedFillProbability >= Math.max(0.55, expectedFillProbability - 0.18) &&
        realizedFillFraction >= Math.max(0.6, expectedFillFraction - 0.2) &&
        realizedSlippageBps <= expectedSlippageBps + 8,
      noTradeDisciplinePassed: expectedNetEdgeAfterCostsBps > 0,
      unresolvedAnomalyCount: 0,
      rationale: input.rationale ?? [],
      evidenceRefs: input.evidenceRefs ?? [],
    };
  }
}

function normalizeNullableNumber(value: number | null, fallback: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return value;
}

function seededUnitInterval(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return hash / 0xffffffff;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
