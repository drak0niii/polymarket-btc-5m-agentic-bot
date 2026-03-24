import type { HealthLabel } from '@polymarket-btc-5m-agentic-bot/domain';

export interface MakerExecutionObservation {
  fillRatio: number;
  fillDelayMs: number | null;
  slippage: number;
}

export interface TakerExecutionObservation {
  fillRatio: number;
  slippage: number;
}

export interface AdverseSelectionAssessment {
  punished: boolean;
  score: number;
  health: HealthLabel;
  reasons: string[];
}

export class AdverseSelectionMonitor {
  assess(input: {
    makerObservations: MakerExecutionObservation[];
    takerObservations: TakerExecutionObservation[];
  }): AdverseSelectionAssessment {
    if (input.makerObservations.length < 3) {
      return {
        punished: false,
        score: 0,
        health: 'healthy',
        reasons: ['maker_sample_insufficient_for_adverse_selection'],
      };
    }

    const makerFillRate = average(input.makerObservations.map((item) => item.fillRatio));
    const takerFillRate = average(input.takerObservations.map((item) => item.fillRatio));
    const makerDelayMs = averageNullable(
      input.makerObservations.map((item) => item.fillDelayMs),
    );
    const makerSlippage = average(input.makerObservations.map((item) => item.slippage));
    const takerSlippage = average(input.takerObservations.map((item) => item.slippage));

    const fillPenalty = Math.max(0, 0.55 - makerFillRate);
    const delayPenalty =
      makerDelayMs == null ? 0 : Math.max(0, makerDelayMs - 12_000) / 20_000;
    const slippagePenalty = Math.max(0, makerSlippage - takerSlippage);
    const score = fillPenalty * 0.5 + delayPenalty * 0.3 + slippagePenalty * 20;
    const reasons: string[] = [];

    if (makerFillRate < 0.55) {
      reasons.push('maker_fill_rate_deterioration');
    }
    if (makerDelayMs != null && makerDelayMs > 12_000) {
      reasons.push('maker_fill_delay_excessive');
    }
    if (makerSlippage > takerSlippage + 0.003) {
      reasons.push('maker_slippage_exceeds_taker_baseline');
    }
    if (takerFillRate > makerFillRate + 0.2) {
      reasons.push('taker_fill_rate_materially_better');
    }

    if (score >= 0.45) {
      return {
        punished: true,
        score,
        health: score >= 0.7 ? 'quarantine_candidate' : 'degraded',
        reasons: reasons.length > 0 ? reasons : ['maker_adverse_selection_detected'],
      };
    }

    return {
      punished: false,
      score,
      health: score >= 0.25 ? 'watch' : 'healthy',
      reasons: reasons.length > 0 ? reasons : ['maker_flow_stable'],
    };
  }
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageNullable(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (usable.length === 0) {
    return null;
  }
  return average(usable);
}
