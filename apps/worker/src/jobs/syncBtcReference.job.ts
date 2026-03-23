import { AppLogger } from '@worker/common/logger';
import { appEnv } from '@worker/config/env';
import { BotRuntimeState } from '@worker/runtime/bot-state';
import { permissionsForRuntimeState } from '@worker/runtime/runtime-state-machine';

export interface BtcCandlePoint {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BtcReferenceSnapshot {
  symbol: string;
  spotPrice: number;
  candles: BtcCandlePoint[];
  observedAt: string;
}

export class SyncBtcReferenceJob {
  private readonly logger = new AppLogger('SyncBtcReferenceJob');

  private lastSnapshot: BtcReferenceSnapshot | null = null;

  async run(options?: { runtimeState?: BotRuntimeState }): Promise<BtcReferenceSnapshot | null> {
    if (
      options?.runtimeState &&
      !permissionsForRuntimeState(options.runtimeState).allowMarketDataReads
    ) {
      return null;
    }

    const [spotPrice, candles] = await Promise.all([
      this.fetchSpotPrice(),
      this.fetchCandles(),
    ]);

    if (spotPrice === null || candles.length === 0) {
      if (this.lastSnapshot && this.isSnapshotFresh(this.lastSnapshot)) {
        this.logger.warn('BTC reference sync failed. Using recent cached snapshot.');
        return this.lastSnapshot;
      }

      this.logger.error('BTC reference sync failed and no fresh cache exists.');
      return null;
    }

    const snapshot: BtcReferenceSnapshot = {
      symbol: 'BTCUSD',
      spotPrice,
      candles,
      observedAt: new Date().toISOString(),
    };

    this.lastSnapshot = snapshot;
    this.logger.debug('BTC reference synced.', {
      price: snapshot.spotPrice,
      candleCount: snapshot.candles.length,
    });

    return snapshot;
  }

  getLastSnapshot(): BtcReferenceSnapshot | null {
    if (!this.lastSnapshot) {
      return null;
    }

    return this.isSnapshotFresh(this.lastSnapshot) ? this.lastSnapshot : null;
  }

  private isSnapshotFresh(snapshot: BtcReferenceSnapshot): boolean {
    const ageMs = Date.now() - new Date(snapshot.observedAt).getTime();
    return ageMs <= appEnv.BOT_MAX_BTC_SNAPSHOT_AGE_MS;
  }

  private async fetchSpotPrice(): Promise<number | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 6_000);

    try {
      const response = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', {
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as {
        data?: { amount?: string };
      };

      const amount = Number(payload.data?.amount ?? Number.NaN);
      if (!Number.isFinite(amount) || amount <= 0) {
        return null;
      }

      return amount;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchCandles(): Promise<BtcCandlePoint[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 8_000);

    try {
      const response = await fetch(
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=60',
        { signal: controller.signal },
      );

      if (!response.ok) {
        return [];
      }

      const rows = (await response.json()) as unknown;
      if (!Array.isArray(rows)) {
        return [];
      }

      return rows
        .map((row) => {
          if (!Array.isArray(row) || row.length < 6) {
            return null;
          }

          const timestamp = Number(row[0]);
          const open = Number(row[1]);
          const high = Number(row[2]);
          const low = Number(row[3]);
          const close = Number(row[4]);
          const volume = Number(row[5]);

          if (
            !Number.isFinite(timestamp) ||
            !Number.isFinite(open) ||
            !Number.isFinite(high) ||
            !Number.isFinite(low) ||
            !Number.isFinite(close) ||
            !Number.isFinite(volume)
          ) {
            return null;
          }

          return {
            timestamp: new Date(timestamp).toISOString(),
            open,
            high,
            low,
            close,
            volume,
          } as BtcCandlePoint;
        })
        .filter((row): row is BtcCandlePoint => row !== null);
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
