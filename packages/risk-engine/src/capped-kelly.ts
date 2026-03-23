export interface CappedKellyInput {
  probability: number;
  marketPrice: number;
  maxKellyFraction: number;
}

export interface CappedKellyResult {
  rawKellyFraction: number;
  cappedKellyFraction: number;
}

export class CappedKelly {
  calculate(input: CappedKellyInput): CappedKellyResult {
    if (input.marketPrice <= 0 || input.marketPrice >= 1) {
      return {
        rawKellyFraction: 0,
        cappedKellyFraction: 0,
      };
    }

    const rawKellyFraction = Math.max(
      0,
      (input.probability - input.marketPrice) / (1 - input.marketPrice),
    );

    const cappedKellyFraction = Math.min(
      rawKellyFraction,
      input.maxKellyFraction,
    );

    return {
      rawKellyFraction,
      cappedKellyFraction,
    };
  }
}