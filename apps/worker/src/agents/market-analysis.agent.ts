import { BuildSignalsJob } from '@worker/jobs/buildSignals.job';
import { DiscoverActiveBtcMarketsJob } from '@worker/jobs/discoverActiveBtcMarkets.job';
import { BotRuntimeState } from '@worker/runtime/bot-state';
import {
  BtcReferenceSnapshot,
  SyncBtcReferenceJob,
} from '@worker/jobs/syncBtcReference.job';
import { SyncOrderbooksJob } from '@worker/jobs/syncOrderbooks.job';
import { appEnv } from '@worker/config/env';

interface MarketAnalysisChecks {
  btcSnapshotPresent: boolean;
  btcSnapshotFresh: boolean;
  discoveredMarketsPositive: boolean;
  syncedOrderbooksPositive: boolean;
}

export interface MarketAnalysisAgentResult {
  discoveredMarkets: number;
  syncedOrderbooks: number;
  createdSignals: number;
  btcSnapshot: BtcReferenceSnapshot | null;
  checks: MarketAnalysisChecks;
  marketAuthorityPassed: boolean;
  marketAuthorityReason: string | null;
}

export class MarketAnalysisAgent {
  constructor(
    private readonly discoverMarketsJob: DiscoverActiveBtcMarketsJob,
    private readonly syncBtcReferenceJob: SyncBtcReferenceJob,
    private readonly syncOrderbooksJob: SyncOrderbooksJob,
    private readonly buildSignalsJob: BuildSignalsJob,
  ) {}

  async run(runtimeState?: BotRuntimeState): Promise<MarketAnalysisAgentResult> {
    const { discovered } = await this.discoverMarketsJob.run();
    const btcSnapshot = await this.syncBtcReferenceJob.run({ runtimeState });
    const { synced } = await this.syncOrderbooksJob.run({ runtimeState });
    const { created } = await this.buildSignalsJob.run(btcSnapshot, { runtimeState });
    const checks = this.evaluateChecks({
      discoveredMarkets: discovered,
      syncedOrderbooks: synced,
      btcSnapshot,
    });
    const authority = this.marketAuthorityVerdict(checks);

    return {
      discoveredMarkets: discovered,
      syncedOrderbooks: synced,
      createdSignals: created,
      btcSnapshot,
      checks,
      marketAuthorityPassed: authority.passed,
      marketAuthorityReason: authority.reason,
    };
  }

  private evaluateChecks(input: {
    discoveredMarkets: number;
    syncedOrderbooks: number;
    btcSnapshot: BtcReferenceSnapshot | null;
  }): MarketAnalysisChecks {
    const snapshotAgeMs = input.btcSnapshot
      ? Date.now() - new Date(input.btcSnapshot.observedAt).getTime()
      : Number.POSITIVE_INFINITY;

    return {
      btcSnapshotPresent: input.btcSnapshot !== null,
      btcSnapshotFresh: snapshotAgeMs <= appEnv.BOT_MAX_BTC_SNAPSHOT_AGE_MS,
      discoveredMarketsPositive: input.discoveredMarkets > 0,
      syncedOrderbooksPositive: input.syncedOrderbooks > 0,
    };
  }

  private marketAuthorityVerdict(checks: MarketAnalysisChecks): {
    passed: boolean;
    reason: string | null;
  } {
    if (!checks.btcSnapshotPresent) {
      return {
        passed: false,
        reason: 'market_analysis_snapshot_missing',
      };
    }
    if (!checks.btcSnapshotFresh) {
      return {
        passed: false,
        reason: 'market_analysis_snapshot_stale',
      };
    }
    if (!checks.syncedOrderbooksPositive) {
      return {
        passed: false,
        reason: 'market_analysis_orderbooks_missing',
      };
    }
    if (!checks.discoveredMarketsPositive) {
      return {
        passed: false,
        reason: 'market_analysis_markets_missing',
      };
    }

    return {
      passed: true,
      reason: null,
    };
  }
}
