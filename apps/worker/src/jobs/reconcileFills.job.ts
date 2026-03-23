import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { BotRuntimeState } from '@worker/runtime/bot-state';
import { appEnv } from '@worker/config/env';
import { RuntimeControlRepository } from '@worker/runtime/runtime-control.repository';
import { permissionsForRuntimeState } from '@worker/runtime/runtime-state-machine';
import { DecisionLogService } from '@worker/runtime/decision-log.service';
import { ExecutionDiagnostics } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  FillStateService,
  OrderExecutionState,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { TradeAttributionService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { OfficialPolymarketTradingClient } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';

interface VenueTrade {
  id: string;
  orderId: string | null;
  price: number;
  size: number;
  fee: number | null;
  filledAt: string | null;
  status?: string | null;
}

export class ReconcileFillsJob {
  private readonly logger = new AppLogger('ReconcileFillsJob');
  private readonly executionDiagnostics = new ExecutionDiagnostics();
  private readonly fillStateService = new FillStateService();
  private readonly tradeAttributionService = new TradeAttributionService();
  private readonly tradingClient = new OfficialPolymarketTradingClient({
    host: appEnv.POLY_CLOB_HOST,
    chainId: appEnv.POLY_CHAIN_ID,
    privateKey: appEnv.POLY_PRIVATE_KEY ?? '',
    apiKey: appEnv.POLY_API_KEY ?? '',
    apiSecret: appEnv.POLY_API_SECRET ?? '',
    apiPassphrase: appEnv.POLY_API_PASSPHRASE ?? '',
    signatureType: appEnv.POLY_SIGNATURE_TYPE,
    funder: appEnv.POLY_FUNDER ?? null,
    geoBlockToken: appEnv.POLY_GEO_BLOCK_TOKEN ?? null,
    useServerTime: appEnv.POLY_USE_SERVER_TIME,
    maxClockSkewMs: appEnv.POLY_MAX_CLOCK_SKEW_MS,
  });
  private readonly decisionLogService: DecisionLogService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runtimeControl: RuntimeControlRepository,
  ) {
    this.decisionLogService = new DecisionLogService(prisma);
  }

  async run(options?: {
    runtimeState?: BotRuntimeState;
  }): Promise<{ fillsInserted: number; syncFailed: boolean }> {
    if (
      options?.runtimeState &&
      !permissionsForRuntimeState(options.runtimeState).allowReconciliation
    ) {
      return {
        fillsInserted: 0,
        syncFailed: false,
      };
    }

    const cycleKey = `fills-cycle:${Date.now()}`;
    await this.runtimeControl.recordReconciliationCheckpoint({
      cycleKey,
      source: 'fills_reconcile_cycle',
      status: 'processing',
    });

    const venueSync = appEnv.BOT_LIVE_EXECUTION_ENABLED
      ? await this.fetchVenueTrades()
      : {
          ok: true,
          trades: await this.simulateTradesFromSubmittedOrders(),
          error: null,
        };

    if (!venueSync.ok) {
      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey,
        source: 'fills_reconcile_cycle',
        status: 'sync_failed',
        details: {
          error: venueSync.error,
        },
      });
      this.logger.warn('Fill reconciliation skipped because venue trade sync failed.', {
        error: venueSync.error,
      });
      return {
        fillsInserted: 0,
        syncFailed: true,
      };
    }

    let fillsInserted = 0;
    for (const trade of venueSync.trades) {
      const tradeCycleKey = `fill:${trade.id}`;
      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey: tradeCycleKey,
        source: 'fills_reconcile',
        status: 'processing',
      });

      const tradeStatus = await this.applyTrade(trade);
      if (tradeStatus === 'already_processed') {
        await this.runtimeControl.recordReconciliationCheckpoint({
          cycleKey: tradeCycleKey,
          source: 'fills_reconcile',
          status: 'already_processed',
        });
        continue;
      }

      if (tradeStatus === 'orphan_trade') {
        await this.runtimeControl.recordReconciliationCheckpoint({
          cycleKey: tradeCycleKey,
          source: 'fills_reconcile',
          status: 'orphan_trade',
        });
        continue;
      }

      fillsInserted += 1;
      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey: tradeCycleKey,
        source: 'fills_reconcile',
        status: 'applied',
      });
    }

    await this.runtimeControl.recordReconciliationCheckpoint({
      cycleKey,
      source: 'fills_reconcile_cycle',
      status: 'completed',
      details: {
        fillsInserted,
        observedTrades: venueSync.trades.length,
      },
    });

    this.logger.debug('Fill reconciliation completed.', {
      fillsInserted,
    });

    return {
      fillsInserted,
      syncFailed: false,
    };
  }

  private async fetchVenueTrades(): Promise<{
    ok: boolean;
    trades: VenueTrade[];
    error: string | null;
  }> {
    try {
      const trades = await this.tradingClient.getTrades();
      return {
        ok: true,
        trades: trades.map((trade) => ({
          id: trade.id,
          orderId: trade.orderId,
          price: trade.price,
          size: trade.size,
          fee: trade.fee,
          filledAt: trade.filledAt,
        })),
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        trades: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async simulateTradesFromSubmittedOrders(): Promise<VenueTrade[]> {
    const submittedOrders = await this.prisma.order.findMany({
      where: {
        status: {
          in: ['submitted', 'acknowledged', 'partially_filled'],
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: 20,
    });

    const now = Date.now();
    return submittedOrders
      .filter(
        (order: { createdAt: Date }) => now - order.createdAt.getTime() >= 10_000,
      )
      .map((order: { id: string; price: number; size: number }) => ({
        id: `sim-${order.id}`,
        orderId: order.id,
        price: order.price,
        size: order.size,
        fee: order.size * order.price * 0.002,
        filledAt: new Date().toISOString(),
      }));
  }

  private async applyTrade(
    trade: VenueTrade,
  ): Promise<'applied' | 'already_processed' | 'orphan_trade'> {
    return this.withTransaction(async (tx) => {
      const existing = await tx.fill.findUnique({
        where: { id: trade.id },
      });
      if (existing) {
        return 'already_processed';
      }

      const order = trade.orderId
        ? await tx.order.findFirst({
            where: {
              OR: [{ id: trade.orderId }, { venueOrderId: trade.orderId }],
            },
          })
        : null;

      if (!order) {
        return 'orphan_trade';
      }

      await tx.fill.create({
        data: {
          id: trade.id,
          marketId: order.marketId,
          tokenId: order.tokenId,
          orderId: order.id,
          price: trade.price,
          size: trade.size,
          fee: trade.fee,
          realizedPnl: null,
          filledAt: trade.filledAt ? new Date(trade.filledAt) : new Date(),
        },
      });

      const nextState = this.fillStateService.applyFill({
        state: this.buildExecutionState(order),
        fillPrice: trade.price,
        fillSize: trade.size,
        fee: trade.fee,
        venueState: trade.status ?? 'trade_applied',
        observedAt: trade.filledAt ?? new Date().toISOString(),
      });
      const nextStatus =
        nextState.remainingSize <= 1e-8 ? 'filled' : 'partially_filled';

      await tx.order.update({
        where: { id: order.id },
        data: {
          status: nextStatus,
          filledSize: nextState.cumulativeFilledSize,
          remainingSize: nextState.remainingSize,
          avgFillPrice: nextState.averageFillPrice,
          lastVenueStatus: nextState.lastVisibleVenueState,
          lastVenueSyncAt: nextState.lastRestConfirmationAt
            ? new Date(nextState.lastRestConfirmationAt)
            : new Date(),
          acknowledgedAt: order.acknowledgedAt ?? new Date(),
        },
      });

      const txAny = tx as any;
      if (txAny.executionDiagnostic?.create) {
        const expectedPrice = order.price;
        const realizedSlippage = Math.max(
          0,
          order.side === 'BUY' ? trade.price - expectedPrice : expectedPrice - trade.price,
        );
        const realizedFee = Math.max(0, trade.fee ?? 0);
        const realizedEv =
          order.expectedEv != null ? order.expectedEv - realizedFee - realizedSlippage : null;
        const snapshot = this.executionDiagnostics.create({
          orderId: order.id,
          strategyVersionId: order.strategyVersionId ?? null,
          expectedEv: order.expectedEv ?? null,
          realizedEv,
          expectedFee: null,
          realizedFee,
          expectedSlippage: null,
          realizedSlippage,
          edgeAtSignal: null,
          edgeAtFill: realizedEv,
          fillRate:
            order.size > 0 ? nextState.cumulativeFilledSize / order.size : null,
          staleOrder: false,
          regime: null,
        });

        await txAny.executionDiagnostic.create({
          data: {
            orderId: snapshot.orderId,
            strategyVersionId: snapshot.strategyVersionId,
            expectedEv: snapshot.expectedEv,
            realizedEv: snapshot.realizedEv,
            evDrift: snapshot.evDrift,
            expectedFee: snapshot.expectedFee,
            realizedFee: snapshot.realizedFee,
            expectedSlippage: snapshot.expectedSlippage,
            realizedSlippage: snapshot.realizedSlippage,
            edgeAtSignal: snapshot.edgeAtSignal,
            edgeAtFill: snapshot.edgeAtFill,
            fillRate: snapshot.fillRate,
            staleOrder: snapshot.staleOrder,
            regime: snapshot.regime,
            capturedAt: new Date(snapshot.capturedAt),
          },
        });

        const signalAuditEvent = order.signalId
          ? await txAny.auditEvent?.findFirst?.({
              where: {
                signalId: order.signalId,
                eventType: 'signal.admission_decision',
              },
              orderBy: { createdAt: 'desc' },
            })
          : null;
        const metadata =
          signalAuditEvent?.metadata && typeof signalAuditEvent.metadata === 'object'
            ? (signalAuditEvent.metadata as Record<string, unknown>)
            : {};
        const noTradeZone =
          metadata.noTradeZone &&
          typeof metadata.noTradeZone === 'object' &&
          Array.isArray((metadata.noTradeZone as Record<string, unknown>).reasons)
            ? (((metadata.noTradeZone as Record<string, unknown>).reasons as unknown[]).filter(
                (value): value is string => typeof value === 'string',
              ))
            : [];
        const setup =
          metadata.strategyFamily && typeof metadata.strategyFamily === 'object'
            ? (metadata.strategyFamily as Record<string, unknown>)
            : {};
        const attribution = this.tradeAttributionService.attribute({
          signal: {
            expectedEdge: snapshot.edgeAtSignal,
            expectedEv: snapshot.expectedEv,
            marketEligible: true,
            signalAgeMs:
              order.createdAt instanceof Date
                ? Math.max(0, new Date(snapshot.capturedAt).getTime() - order.createdAt.getTime())
                : null,
          },
          execution: {
            expectedEntryPrice: expectedPrice,
            actualEntryPrice: trade.price,
            realizedSlippage,
            expectedSlippage: null,
            fillDelayMs:
              order.createdAt instanceof Date
                ? Math.max(0, new Date(snapshot.capturedAt).getTime() - order.createdAt.getTime())
                : null,
            fees: realizedFee,
            grossPnl: snapshot.realizedEv != null ? snapshot.realizedEv + realizedFee : null,
            netPnl: snapshot.realizedEv,
          },
          staleData: false,
          inventoryManagedExit: this.readStringField(order, 'inventoryEffect') === 'DECREASE',
          setup: {
            strategyFamily:
              typeof setup.family === 'string'
                ? setup.family
                : typeof setup.strategyFamily === 'string'
                  ? setup.strategyFamily
                  : null,
            edgeDefinitionVersion:
              metadata.edgeDefinition &&
              typeof metadata.edgeDefinition === 'object' &&
              typeof (metadata.edgeDefinition as Record<string, unknown>).version === 'string'
                ? ((metadata.edgeDefinition as Record<string, unknown>).version as string)
                : null,
            admissibleNetEdge:
              typeof metadata.executableEdge === 'object' &&
              metadata.executableEdge !== null &&
              typeof (metadata.executableEdge as Record<string, unknown>).finalNetEdge ===
                'number'
                ? ((metadata.executableEdge as Record<string, unknown>).finalNetEdge as number)
                : null,
            halfLifeExpired:
              typeof metadata.halfLife === 'object' &&
              metadata.halfLife !== null &&
              Boolean((metadata.halfLife as Record<string, unknown>).expired),
            noTradeZones: noTradeZone,
          },
        });
        await this.decisionLogService.record({
          category: 'post_trade',
          eventType: 'trade.post_trade_attribution',
          summary: `Post-trade attribution recorded for order ${order.id}.`,
          marketId: order.marketId,
          signalId: order.signalId,
          orderId: order.id,
          payload: {
            attribution,
            executionDiagnostic: snapshot,
          },
          createdAt: snapshot.capturedAt,
        });
      }

      return 'applied';
    });
  }

  private buildExecutionState(order: {
    size: number;
    filledSize: number | null;
    avgFillPrice: number | null;
    remainingSize: number | null;
    lastVenueStatus: string | null;
    lastVenueSyncAt: Date | null;
  }): OrderExecutionState {
    const cumulativeFilledSize = Math.max(0, order.filledSize ?? 0);
    const intendedSize = Math.max(order.size, cumulativeFilledSize);
    return {
      intendedSize,
      cumulativeFilledSize,
      averageFillPrice: order.avgFillPrice ?? null,
      remainingSize:
        order.remainingSize != null
          ? Math.max(0, order.remainingSize)
          : Math.max(0, intendedSize - cumulativeFilledSize),
      cumulativeFees: 0,
      lastVisibleVenueState: order.lastVenueStatus ?? 'working',
      lastUserStreamUpdateAt: order.lastVenueSyncAt?.toISOString() ?? null,
      lastRestConfirmationAt: order.lastVenueSyncAt?.toISOString() ?? null,
    };
  }

  private readStringField(source: unknown, key: string): string | null {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private async withTransaction<T>(
    fn: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> {
    const prismaAny = this.prisma as PrismaClient & {
      $transaction?: <R>(
        callback: (tx: PrismaClient) => Promise<R>,
      ) => Promise<R>;
    };

    if (typeof prismaAny.$transaction === 'function') {
      try {
        return await prismaAny.$transaction((tx) => fn(tx as PrismaClient));
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes('unique constraint')
        ) {
          return 'already_processed' as T;
        }
        throw error;
      }
    }

    try {
      return await fn(this.prisma);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.toLowerCase().includes('unique constraint')
      ) {
        return 'already_processed' as T;
      }
      throw error;
    }
  }
}
