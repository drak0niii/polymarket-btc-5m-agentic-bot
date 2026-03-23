export interface FillTrackerInput {
  orderSize: number;
  filledSize: number;
  averageFillPrice: number | null;
  fee: number | null;
}

export interface FillTrackerResult {
  fillFraction: number;
  fullyFilled: boolean;
  partiallyFilled: boolean;
  remainingSize: number;
  averageFillPrice: number | null;
  fee: number | null;
  capturedAt: string;
}

export class FillTracker {
  track(input: FillTrackerInput): FillTrackerResult {
    const safeOrderSize = input.orderSize > 0 ? input.orderSize : 0;
    const safeFilledSize = Math.max(0, Math.min(input.filledSize, safeOrderSize));

    const fillFraction =
      safeOrderSize > 0 ? safeFilledSize / safeOrderSize : 0;

    return {
      fillFraction,
      fullyFilled: safeOrderSize > 0 && safeFilledSize === safeOrderSize,
      partiallyFilled:
        safeOrderSize > 0 && safeFilledSize > 0 && safeFilledSize < safeOrderSize,
      remainingSize: Math.max(0, safeOrderSize - safeFilledSize),
      averageFillPrice: input.averageFillPrice,
      fee: input.fee,
      capturedAt: new Date().toISOString(),
    };
  }
}