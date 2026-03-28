import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { appEnv } from '@worker/config/env';
import { BotRuntimeState } from '@worker/runtime/bot-state';
import { DecisionLogService } from '@worker/runtime/decision-log.service';
import { RuntimeControlRepository } from '@worker/runtime/runtime-control.repository';
import { ResolvedTradeLedger } from '@worker/runtime/resolved-trade-ledger';
import { permissionsForRuntimeState } from '@worker/runtime/runtime-state-machine';
import {
  ExecutionDiagnostics,
  FillStateService,
  FillRealismStore,
  buildFillRealismBucket,
  type FillRealismObservation,
  type OrderExecutionState,
  PostFillToxicityStore,
  type PostFillToxicityObservation,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  buildStrategyVariantId,
  type ResolvedTradeBenchmarkContext,
  type ResolvedTradeLifecycleState,
  type ResolvedTradeRecord,
  type TradingOperatingMode,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { OfficialPolymarketTradingClient } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { TradeAttributionService } from '@polymarket-btc-5m-agentic-bot/risk-engine';

interface VenueTrade {
  id: string;
  orderId: string | null;
  price: number;
  size: number;
  fee: number | null;
  filledAt: string | null;
  status?: string | null;
}

interface ApplyTradeResult {
  status: 'applied' | 'already_processed' | 'orphan_trade';
  postTradeDecisionLog: {
    category: 'post_trade';
    eventType: 'trade.post_trade_attribution';
    summary: string;
    marketId: string;
    signalId: string | null;
    orderId: string;
    payload: Record<string, unknown>;
    createdAt: string;
  } | null;
  resolvedTradeRecord: ResolvedTradeRecord | null;
  fillRealismObservation: FillRealismObservation | null;
  postFillToxicityObservation: PostFillToxicityObservation | null;
}

export class ReconcileFillsJob {
  private readonly logger = new AppLogger('ReconcileFillsJob');
  private readonly executionDiagnostics = new ExecutionDiagnostics();
  private readonly fillStateService = new FillStateService();
  private readonly tradeAttributionService = new TradeAttributionService();
  private readonly resolvedTradeLedger = new ResolvedTradeLedger();
  private readonly fillRealismStore = new FillRealismStore();
  private readonly postFillToxicityStore = new PostFillToxicityStore();
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
    operatingMode?: TradingOperatingMode;
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

    if (options?.operatingMode === 'sentinel_simulation') {
      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey,
        source: 'fills_reconcile_cycle',
        status: 'completed',
        details: {
          operatingMode: options.operatingMode,
          sentinelHandledSeparately: true,
        },
      });
      await this.prisma.auditEvent.create({
        data: {
          eventType: 'sentinel.reconciliation_skipped',
          message:
            'Fill reconciliation skipped because sentinel trades are finalized in sentinel artifacts.',
          metadata: {
            operatingMode: options.operatingMode,
          } as object,
        },
      });
      return {
        fillsInserted: 0,
        syncFailed: false,
      };
    }

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

      const tradeResult = await this.applyTrade(trade);
      if (tradeResult.postTradeDecisionLog) {
        await this.decisionLogService.record(tradeResult.postTradeDecisionLog);
      }
      if (tradeResult.resolvedTradeRecord) {
        const appendResult = await this.resolvedTradeLedger.append(tradeResult.resolvedTradeRecord);
        if (appendResult.appended) {
          if (tradeResult.fillRealismObservation) {
            await this.fillRealismStore.append(tradeResult.fillRealismObservation);
          }
          if (tradeResult.postFillToxicityObservation) {
            await this.postFillToxicityStore.append(tradeResult.postFillToxicityObservation);
          }
          await this.decisionLogService.record({
            category: 'post_trade',
            eventType: 'trade.resolved',
            summary: `Resolved trade recorded for order ${appendResult.record.orderId}.`,
            marketId: appendResult.record.marketId,
            signalId: null,
            orderId: appendResult.record.orderId,
            payload: {
              resolvedTrade: appendResult.record,
            },
            createdAt: appendResult.record.capturedAt,
          });
        }
      }

      if (tradeResult.status === 'already_processed') {
        await this.runtimeControl.recordReconciliationCheckpoint({
          cycleKey: tradeCycleKey,
          source: 'fills_reconcile',
          status: 'already_processed',
        });
        continue;
      }

      if (tradeResult.status === 'orphan_trade') {
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
      .map((order: {
        id: string;
        price: number;
        size: number;
      }) => ({
        id: `sim-${order.id}`,
        orderId: order.id,
        price: order.price,
        size: order.size,
        fee: order.size * order.price * 0.002,
        filledAt: new Date().toISOString(),
      }));
  }

  private async applyTrade(trade: VenueTrade): Promise<ApplyTradeResult> {
    return this.withTransaction(
      async (tx) => {
        const existing = await tx.fill.findUnique({
          where: { id: trade.id },
        });
        if (existing) {
          return {
            status: 'already_processed',
            postTradeDecisionLog: null,
            resolvedTradeRecord: null,
            fillRealismObservation: null,
            postFillToxicityObservation: null,
          };
        }

        const order = trade.orderId
          ? await tx.order.findFirst({
              where: {
                OR: [{ id: trade.orderId }, { venueOrderId: trade.orderId }],
              },
            })
          : null;

        if (!order) {
          return {
            status: 'orphan_trade',
            postTradeDecisionLog: null,
            resolvedTradeRecord: null,
            fillRealismObservation: null,
            postFillToxicityObservation: null,
          };
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
          restConfirmed: true,
        });
        const lifecycleAssessment = this.fillStateService.assessLifecycle({
          state: nextState,
          orderStatus: nextState.remainingSize <= 1e-8 ? 'filled' : 'partially_filled',
          venueState: trade.status ?? nextState.lastVisibleVenueState,
          hasRestConfirmation: true,
          retryCount: nextState.retryCount ?? 0,
          lastError: this.readStringField(order, 'lastError'),
          cancelRequestedAt: readDateField(order, 'canceledAt')?.toISOString() ?? null,
        });
        const nextStatus =
          lifecycleAssessment.lifecycleState === 'retrying'
            ? 'acknowledged'
            : lifecycleAssessment.lifecycleState === 'failed'
              ? 'rejected'
              : nextState.remainingSize <= 1e-8 &&
                  lifecycleAssessment.economicallyFinalEnough
                ? 'filled'
                : 'partially_filled';

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
        const fills = await tx.fill.findMany({
          where: {
            orderId: order.id,
          },
          orderBy: {
            filledAt: 'asc',
          },
        });
        const signal = order.signalId && txAny.signal?.findUnique
          ? await txAny.signal.findUnique({
              where: {
                id: order.signalId,
              },
            })
          : null;
        const signalAuditEvent = order.signalId
          ? await txAny.auditEvent?.findFirst?.({
              where: {
                signalId: order.signalId,
                eventType: 'signal.admission_decision',
              },
              orderBy: { createdAt: 'desc' },
            })
          : null;
        const submitAuditEvent = txAny.auditEvent?.findFirst
          ? await txAny.auditEvent.findFirst({
              where: {
                orderId: order.id,
                eventType: 'order.submitted',
              },
              orderBy: {
                createdAt: 'desc',
              },
            })
          : null;
        const signalMetadata = readObjectField(signalAuditEvent, 'metadata');
        const submitMetadata = readObjectField(submitAuditEvent, 'metadata');

        let postTradeDecisionLog: ApplyTradeResult['postTradeDecisionLog'] = null;
        let resolvedTradeRecord: ResolvedTradeRecord | null = null;
        let fillRealismObservation: FillRealismObservation | null = null;
        let postFillToxicityObservation: PostFillToxicityObservation | null = null;

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
          fillRate: order.size > 0 ? nextState.cumulativeFilledSize / order.size : null,
          staleOrder: false,
          regime: typeof signal?.regime === 'string' ? signal.regime : null,
        });

        if (txAny.executionDiagnostic?.create) {
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
        }

        const noTradeZone =
          signalMetadata.noTradeZone &&
          typeof signalMetadata.noTradeZone === 'object' &&
          Array.isArray((signalMetadata.noTradeZone as Record<string, unknown>).reasons)
            ? (((signalMetadata.noTradeZone as Record<string, unknown>).reasons as unknown[]).filter(
                (value): value is string => typeof value === 'string',
              ))
            : [];
        const setup =
          signalMetadata.strategyFamily && typeof signalMetadata.strategyFamily === 'object'
            ? (signalMetadata.strategyFamily as Record<string, unknown>)
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
              signalMetadata.edgeDefinition &&
              typeof signalMetadata.edgeDefinition === 'object' &&
              typeof (signalMetadata.edgeDefinition as Record<string, unknown>).version ===
                'string'
                ? ((signalMetadata.edgeDefinition as Record<string, unknown>).version as string)
                : null,
            admissibleNetEdge:
              typeof signalMetadata.executableEdge === 'object' &&
              signalMetadata.executableEdge !== null &&
              typeof (signalMetadata.executableEdge as Record<string, unknown>).finalNetEdge ===
                'number'
                ? ((signalMetadata.executableEdge as Record<string, unknown>).finalNetEdge as number)
                : null,
            halfLifeExpired:
              typeof signalMetadata.halfLife === 'object' &&
              signalMetadata.halfLife !== null &&
              Boolean((signalMetadata.halfLife as Record<string, unknown>).expired),
            noTradeZones: noTradeZone,
          },
        });

        postTradeDecisionLog = {
          category: 'post_trade',
          eventType: 'trade.post_trade_attribution',
          summary: `Post-trade attribution recorded for order ${order.id}.`,
          marketId: order.marketId,
          signalId: order.signalId ?? null,
          orderId: order.id,
          payload: {
            attribution,
            executionDiagnostic: snapshot,
          },
          createdAt: snapshot.capturedAt,
        };

        if (this.isEconomicallyResolved(nextState, order.size, lifecycleAssessment)) {
          resolvedTradeRecord = this.buildResolvedTradeRecord({
            order,
            signal,
            fills,
            trade,
            snapshot,
            attribution,
            signalMetadata,
            submitMetadata,
          });
          if (resolvedTradeRecord) {
            fillRealismObservation = this.buildFillRealismObservation({
              resolvedTradeRecord,
              fills,
              submitMetadata,
              orderCanceledAt: readDateField(order, 'canceledAt')?.toISOString() ?? null,
            });
            postFillToxicityObservation = await this.buildPostFillToxicityObservation({
              tx: txAny,
              resolvedTradeRecord,
              submitMetadata,
            });
          }
        }

        return {
          status: 'applied',
          postTradeDecisionLog,
          resolvedTradeRecord,
          fillRealismObservation,
          postFillToxicityObservation,
        };
      },
      () => ({
        status: 'already_processed',
        postTradeDecisionLog: null,
        resolvedTradeRecord: null,
        fillRealismObservation: null,
        postFillToxicityObservation: null,
      }),
    );
  }

  private isEconomicallyResolved(
    nextState: OrderExecutionState,
    intendedSize: number,
    lifecycleAssessment: {
      economicallyFinalEnough: boolean;
      lifecycleState: string;
    },
  ): boolean {
    if (lifecycleAssessment.economicallyFinalEnough) {
      return true;
    }

    if (
      lifecycleAssessment.lifecycleState === 'matched' ||
      lifecycleAssessment.lifecycleState === 'mined' ||
      lifecycleAssessment.lifecycleState === 'retrying' ||
      lifecycleAssessment.lifecycleState === 'cancel_pending'
    ) {
      return false;
    }

    if (nextState.remainingSize <= 1e-8) {
      return true;
    }

    if (intendedSize <= 0) {
      return false;
    }

    return nextState.cumulativeFilledSize / intendedSize >= 0.999;
  }

  private buildFillRealismObservation(input: {
    resolvedTradeRecord: ResolvedTradeRecord;
    fills: Array<{
      size: number;
      filledAt: Date;
    }>;
    submitMetadata: Record<string, unknown>;
    orderCanceledAt: string | null;
  }): FillRealismObservation | null {
    const bucket = this.readExecutionBucketContext(input.submitMetadata);
    if (!bucket) {
      return null;
    }

    const submissionTimestamp = readTimestamp(input.resolvedTradeRecord.submissionTimestamp);
    if (submissionTimestamp == null) {
      return null;
    }

    const totalSize = Math.max(input.resolvedTradeRecord.size, 1e-9);
    const fillProbabilityWithin1s = this.fillFractionWithinHorizon(
      input.fills,
      submissionTimestamp,
      totalSize,
      1_000,
    );
    const fillProbabilityWithin3s = this.fillFractionWithinHorizon(
      input.fills,
      submissionTimestamp,
      totalSize,
      3_000,
    );
    const fillProbabilityWithin5s = this.fillFractionWithinHorizon(
      input.fills,
      submissionTimestamp,
      totalSize,
      5_000,
    );
    const fillProbabilityWithin10s = this.fillFractionWithinHorizon(
      input.fills,
      submissionTimestamp,
      totalSize,
      10_000,
    );

    const cancelLatencyMs = input.orderCanceledAt
      ? Math.max(0, readTimestamp(input.orderCanceledAt)! - submissionTimestamp)
      : null;

    return {
      observationId: `fill-realism:${input.resolvedTradeRecord.orderId}`,
      orderId: input.resolvedTradeRecord.orderId,
      tradeId: input.resolvedTradeRecord.tradeId,
      bucket,
      fillProbabilityWithin1s,
      fillProbabilityWithin3s,
      fillProbabilityWithin5s,
      fillProbabilityWithin10s,
      fillFraction: clampFraction(input.resolvedTradeRecord.fillFraction),
      queueDelayMs: finiteNumberOrNull(input.resolvedTradeRecord.queueDelayMs),
      cancelSuccessLatencyMs: cancelLatencyMs,
      slippageBps: finiteNumberOrNull(input.resolvedTradeRecord.realizedSlippageBps),
      capturedAt: input.resolvedTradeRecord.finalizedTimestamp,
    };
  }

  private async buildPostFillToxicityObservation(input: {
    tx: any;
    resolvedTradeRecord: ResolvedTradeRecord;
    submitMetadata: Record<string, unknown>;
  }): Promise<PostFillToxicityObservation | null> {
    const bucket = this.readExecutionBucketContext(input.submitMetadata);
    const firstFillTimestamp = readTimestamp(input.resolvedTradeRecord.firstFillTimestamp);
    if (!bucket || firstFillTimestamp == null || !input.tx.orderbook?.findMany) {
      return null;
    }

    const orderbooks = await input.tx.orderbook.findMany({
      where: {
        marketId: input.resolvedTradeRecord.marketId,
        tokenId: input.resolvedTradeRecord.tokenId,
      },
      orderBy: {
        observedAt: 'asc',
      },
    });

    const drift1sBps = this.sampleAdverseDriftBps(
      orderbooks,
      input.resolvedTradeRecord,
      firstFillTimestamp,
      1_000,
    );
    const drift3sBps = this.sampleAdverseDriftBps(
      orderbooks,
      input.resolvedTradeRecord,
      firstFillTimestamp,
      3_000,
    );
    const drift10sBps = this.sampleAdverseDriftBps(
      orderbooks,
      input.resolvedTradeRecord,
      firstFillTimestamp,
      10_000,
    );
    const drift30sBps = this.sampleAdverseDriftBps(
      orderbooks,
      input.resolvedTradeRecord,
      firstFillTimestamp,
      30_000,
    );

    if (
      drift1sBps == null &&
      drift3sBps == null &&
      drift10sBps == null &&
      drift30sBps == null
    ) {
      return null;
    }

    return {
      observationId: `post-fill-toxicity:${input.resolvedTradeRecord.orderId}`,
      orderId: input.resolvedTradeRecord.orderId,
      tradeId: input.resolvedTradeRecord.tradeId,
      bucket,
      drift1sBps,
      drift3sBps,
      drift10sBps,
      drift30sBps,
      capturedAt: input.resolvedTradeRecord.finalizedTimestamp,
    };
  }

  private readExecutionBucketContext(
    submitMetadata: Record<string, unknown>,
  ) {
    const context =
      readObjectPath(submitMetadata, ['executionPlannerAssumptions', 'executionBucketContext']) ??
      readObjectPath(submitMetadata, ['executionCostCalibration', 'evidence']);
    if (!context) {
      return null;
    }

    return buildFillRealismBucket({
      spreadBucket: readStringFieldFromRecord(context, 'spreadBucket') as any,
      liquidityBucket: readStringFieldFromRecord(context, 'liquidityBucket') as any,
      orderUrgency:
        readStringFieldFromRecord(context, 'orderUrgency') as 'low' | 'medium' | 'high' | null,
      regime:
        readStringFieldFromRecord(context, 'regime') ??
        readStringFieldFromRecord(context, 'regimeKey') ??
        null,
      executionStyle:
        (readStringFieldFromRecord(context, 'executionStyle') as any) ??
        (readStringFieldFromRecord(context, 'route') === 'maker' ? 'maker' : 'taker'),
      venueUncertaintyLabel:
        (readStringFieldFromRecord(context, 'venueUncertaintyLabel') as any) ??
        (readStringFieldFromRecord(context, 'venueUncertainty') as any) ??
        null,
    });
  }

  private fillFractionWithinHorizon(
    fills: Array<{ size: number; filledAt: Date }>,
    submissionTimestamp: number,
    totalSize: number,
    horizonMs: number,
  ): number {
    const filled = fills.reduce((sum, fill) => {
      if (fill.filledAt.getTime() - submissionTimestamp <= horizonMs) {
        return sum + Math.max(0, fill.size);
      }
      return sum;
    }, 0);
    return clampFraction(filled / totalSize);
  }

  private sampleAdverseDriftBps(
    orderbooks: Array<Record<string, unknown>>,
    resolvedTradeRecord: ResolvedTradeRecord,
    firstFillTimestamp: number,
    horizonMs: number,
  ): number | null {
    const target = firstFillTimestamp + horizonMs;
    const snapshot = orderbooks.find((entry) => {
      const observedAt = readTimestamp(readUnknownDate(entry, 'observedAt'));
      return observedAt != null && observedAt >= target;
    });
    if (!snapshot) {
      return null;
    }

    const bestBid = readNumberFieldFromRecord(snapshot, 'bestBid');
    const bestAsk = readNumberFieldFromRecord(snapshot, 'bestAsk');
    const mark =
      bestBid != null && bestAsk != null
        ? (bestBid + bestAsk) / 2
        : bestBid ?? bestAsk ?? null;
    const fillPrice = finiteNumberOrNull(resolvedTradeRecord.averageFillPrice);
    if (mark == null || fillPrice == null || fillPrice <= 0) {
      return null;
    }

    const adverseMove =
      resolvedTradeRecord.side === 'BUY'
        ? Math.max(0, fillPrice - mark)
        : Math.max(0, mark - fillPrice);
    return (adverseMove / fillPrice) * 10_000;
  }

  private buildResolvedTradeRecord(input: {
    order: {
      id: string;
      venueOrderId: string | null;
      marketId: string;
      tokenId: string | null;
      signalId: string | null;
      strategyVersionId: string | null;
      side: string;
      price: number;
      size: number;
      expectedEv: number | null;
      createdAt: Date;
      postedAt: Date | null;
      acknowledgedAt: Date | null;
    };
    signal: {
      regime?: string | null;
      createdAt?: Date;
      observedAt?: Date;
    } | null;
    fills: Array<{
      price: number;
      size: number;
      fee: number | null;
      realizedPnl: number | null;
      filledAt: Date;
    }>;
    trade: VenueTrade;
    snapshot: {
      expectedEv: number | null;
      realizedEv: number | null;
      expectedFee: number | null;
      realizedFee: number | null;
      expectedSlippage: number | null;
      realizedSlippage: number | null;
      capturedAt: string;
    };
    attribution: {
      bucket: string;
      reasons: string[];
    };
    signalMetadata: Record<string, unknown>;
    submitMetadata: Record<string, unknown>;
  }): ResolvedTradeRecord {
    const firstFill = input.fills[0] ?? null;
    const totalFilledSize = input.fills.reduce((sum, fill) => sum + fill.size, 0);
    const totalFee = input.fills.reduce((sum, fill) => sum + Math.max(0, fill.fee ?? 0), 0);
    const weightedFillNotional = input.fills.reduce(
      (sum, fill) => sum + fill.price * fill.size,
      0,
    );
    const averageFillPrice =
      totalFilledSize > 0 ? weightedFillNotional / totalFilledSize : input.trade.price;
    const intendedNotional = input.order.size * input.order.price;
    const realizedNotional = totalFilledSize * averageFillPrice;
    const notional = realizedNotional > 0 ? realizedNotional : intendedNotional;
    const estimatedFeeAtDecision =
      readNumberPath(input.submitMetadata, ['alphaAttribution', 'expectedExecutionCost', 'feeCost']) ??
      readNumberPath(input.submitMetadata, ['feeModel', 'expectedFee']) ??
      input.snapshot.expectedFee ??
      null;
    const estimatedSlippageBps =
      readBpsPath(
        input.submitMetadata,
        ['alphaAttribution', 'expectedExecutionCost', 'slippageCost'],
        input.order.price,
      ) ??
      bpsFromAbsoluteCost(input.snapshot.expectedSlippage, input.order.price);
    const realizedSlippageBps =
      bpsFromAbsoluteCost(input.snapshot.realizedSlippage, input.order.price) ??
      this.computeRealizedSlippageBps(input.order.side, input.order.price, averageFillPrice);
    const expectedNetEdgeBps =
      readBpsPath(input.submitMetadata, ['alphaAttribution', 'expectedNetEdge'], 1) ??
      bpsFromNotional(input.snapshot.expectedEv ?? input.order.expectedEv, intendedNotional);
    const realizedNetEdgeBps =
      readBpsPath(input.submitMetadata, ['alphaAttribution', 'realizedNetEdge'], 1) ??
      bpsFromNotional(input.snapshot.realizedEv, notional);
    const queueDelayMs = firstFill
      ? Math.max(
          0,
          firstFill.filledAt.getTime() -
            (input.order.postedAt ?? input.order.createdAt).getTime(),
        )
      : null;
    const fillFraction = input.order.size > 0 ? totalFilledSize / input.order.size : 0;
    const toxicityScoreAtDecision =
      readNumberPath(input.submitMetadata, ['toxicity', 'toxicityScore']) ?? null;
    const benchmarkContext = this.buildBenchmarkContext(input.submitMetadata);
    const strategyVersion = input.order.strategyVersionId ?? null;
    const strategyVariantId = strategyVersion ? buildStrategyVariantId(strategyVersion) : null;
    const realizedPnl = input.fills.some((fill) => fill.realizedPnl != null)
      ? input.fills.reduce((sum, fill) => sum + (fill.realizedPnl ?? 0), 0)
      : null;
    const lifecycleState: ResolvedTradeLifecycleState =
      realizedPnl != null
        ? 'economically_resolved_with_portfolio_truth'
        : 'economically_resolved';
    const lossAttributionCategory =
      readStringPath(input.submitMetadata, ['lossAttribution', 'lossCategory']) ?? null;
    const primaryLeakageDriver =
      readStringPath(input.submitMetadata, ['lossAttribution', 'primaryLeakageDriver']) ??
      input.attribution.reasons[0] ??
      null;
    const secondaryLeakageDrivers = (
      readStringArrayPath(input.submitMetadata, ['lossAttribution', 'secondaryLeakageDrivers']) ??
      input.attribution.reasons.slice(1)
    ).slice(0, 8);

    return {
      tradeId: `resolved:${input.order.id}`,
      orderId: input.order.id,
      venueOrderId: input.order.venueOrderId ?? input.trade.orderId ?? null,
      marketId: input.order.marketId,
      tokenId: input.order.tokenId ?? 'unknown_token',
      strategyVariantId,
      strategyVersion,
      regime: readNullableString(input.signal?.regime),
      archetype:
        readStringPath(input.submitMetadata, ['upstreamEvaluationEvidence', 'marketArchetype']) ??
        readStringPath(input.signalMetadata, ['phaseTwoContext', 'marketArchetype']) ??
        readStringPath(input.signalMetadata, ['marketArchetype']) ??
        null,
      decisionTimestamp: (
        input.signal?.observedAt ??
        input.signal?.createdAt ??
        input.order.createdAt
      ).toISOString(),
      submissionTimestamp: (input.order.postedAt ?? input.order.createdAt).toISOString(),
      firstFillTimestamp: firstFill?.filledAt.toISOString() ?? null,
      finalizedTimestamp: firstFill?.filledAt.toISOString() ?? input.snapshot.capturedAt,
      side: input.order.side === 'SELL' ? 'SELL' : 'BUY',
      intendedPrice: input.order.price,
      averageFillPrice,
      size: input.order.size,
      notional,
      estimatedFeeAtDecision,
      realizedFee: totalFee,
      estimatedSlippageBps,
      realizedSlippageBps,
      queueDelayMs,
      fillFraction,
      expectedNetEdgeBps,
      realizedNetEdgeBps,
      maxFavorableExcursionBps: null,
      maxAdverseExcursionBps: null,
      toxicityScoreAtDecision,
      benchmarkContext,
      lossAttributionCategory,
      executionAttributionCategory: input.attribution.bucket,
      lifecycleState,
      attribution: {
        benchmarkContext,
        lossAttributionCategory,
        executionAttributionCategory: input.attribution.bucket,
        primaryLeakageDriver,
        secondaryLeakageDrivers,
        reasonCodes: [...new Set(input.attribution.reasons)],
      },
      executionQuality: {
        intendedPrice: input.order.price,
        averageFillPrice,
        size: input.order.size,
        notional,
        estimatedFeeAtDecision,
        realizedFee: totalFee,
        estimatedSlippageBps,
        realizedSlippageBps,
        queueDelayMs,
        fillFraction,
      },
      netOutcome: {
        expectedNetEdgeBps,
        realizedNetEdgeBps,
        maxFavorableExcursionBps: null,
        maxAdverseExcursionBps: null,
        realizedPnl,
      },
      capturedAt: input.snapshot.capturedAt,
    };
  }

  private buildBenchmarkContext(
    submitMetadata: Record<string, unknown>,
  ): ResolvedTradeBenchmarkContext | null {
    const decision =
      readObjectPath(submitMetadata, ['benchmarkRelativeSizingDecision']) ??
      readObjectPath(submitMetadata, ['upstreamEvaluationEvidence', 'baselineComparisonSummary']);
    if (!decision) {
      return null;
    }

    return {
      benchmarkComparisonState:
        readStringFieldFromRecord(decision, 'benchmarkComparisonState') ??
        readStringFieldFromRecord(decision, 'strategyComparisonState') ??
        null,
      baselinePenaltyMultiplier:
        readFiniteNumberFieldFromRecord(decision, 'baselinePenaltyMultiplier') ?? null,
      regimeBenchmarkGateState:
        readStringFieldFromRecord(decision, 'regimeBenchmarkGateState') ?? null,
      underperformedBenchmarkIds:
        readStringArrayFieldFromRecord(decision, 'underperformedBenchmarkIds') ?? [],
      outperformedBenchmarkIds:
        readStringArrayFieldFromRecord(decision, 'outperformedBenchmarkIds') ?? [],
      reasonCodes:
        readStringArrayFieldFromRecord(decision, 'benchmarkPenaltyReasonCodes') ??
        readStringArrayFieldFromRecord(decision, 'reasonCodes') ??
        [],
    };
  }

  private computeRealizedSlippageBps(
    side: string,
    intendedPrice: number,
    averageFillPrice: number | null,
  ): number | null {
    if (!Number.isFinite(intendedPrice) || intendedPrice <= 0 || averageFillPrice == null) {
      return null;
    }

    const signedDelta =
      side === 'BUY' ? averageFillPrice - intendedPrice : intendedPrice - averageFillPrice;
    return Math.max(0, (signedDelta / intendedPrice) * 10_000);
  }

  private buildExecutionState(order: {
    size: number;
    filledSize: number | null;
    avgFillPrice: number | null;
    remainingSize: number | null;
    lastVenueStatus: string | null;
    lastVenueSyncAt: Date | null;
    status?: string | null;
    lastError?: string | null;
    updatedAt?: Date | null;
  }): OrderExecutionState {
    const cumulativeFilledSize = Math.max(0, order.filledSize ?? 0);
    const intendedSize = Math.max(order.size, cumulativeFilledSize);
    const retryCount =
      typeof order.lastError === 'string' &&
      order.lastError.toLowerCase().includes('retry')
        ? 1
        : 0;
    const lastLifecycleState =
      order.status === 'filled'
        ? 'economically_final_enough'
        : order.lastVenueStatus?.toLowerCase().includes('cancel')
          ? 'cancel_pending'
          : cumulativeFilledSize > 0
            ? 'matched'
            : 'working';
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
      lastUserStreamUpdateAt:
        order.updatedAt?.toISOString() ?? order.lastVenueSyncAt?.toISOString() ?? null,
      lastRestConfirmationAt: order.lastVenueSyncAt?.toISOString() ?? null,
      lastMatchedAt:
        cumulativeFilledSize > 0
          ? order.updatedAt?.toISOString() ?? order.lastVenueSyncAt?.toISOString() ?? null
          : null,
      lastLifecycleState,
      retryCount,
      cancelRequestedAt:
        order.lastVenueStatus?.toLowerCase().includes('cancel')
          ? order.updatedAt?.toISOString() ?? null
          : null,
      cancelConfirmedAt:
        order.status === 'canceled'
          ? order.updatedAt?.toISOString() ?? null
          : null,
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
    onUniqueConstraint: () => T,
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
          return onUniqueConstraint();
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
        return onUniqueConstraint();
      }
      throw error;
    }
  }
}

function readObjectField(source: unknown, key: string): Record<string, unknown> {
  if (!source || typeof source !== 'object') {
    return {};
  }

  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readObjectPath(
  source: Record<string, unknown>,
  pathSegments: string[],
): Record<string, unknown> | null {
  let current: unknown = source;
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current && typeof current === 'object' ? (current as Record<string, unknown>) : null;
}

function readStringPath(source: Record<string, unknown>, pathSegments: string[]): string | null {
  let current: unknown = source;
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' && current.trim().length > 0 ? current.trim() : null;
}

function readStringArrayPath(
  source: Record<string, unknown>,
  pathSegments: string[],
): string[] | null {
  let current: unknown = source;
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return Array.isArray(current)
    ? current.filter((value): value is string => typeof value === 'string')
    : null;
}

function readNumberPath(
  source: Record<string, unknown>,
  pathSegments: string[],
): number | null {
  let current: unknown = source;
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : null;
}

function readBpsPath(
  source: Record<string, unknown>,
  pathSegments: string[],
  referencePrice: number,
): number | null {
  const value = readNumberPath(source, pathSegments);
  if (value == null) {
    return null;
  }

  if (referencePrice === 1) {
    return value * 10_000;
  }

  return bpsFromAbsoluteCost(value, referencePrice);
}

function bpsFromAbsoluteCost(value: number | null, referencePrice: number): number | null {
  if (
    value == null ||
    !Number.isFinite(value) ||
    !Number.isFinite(referencePrice) ||
    referencePrice <= 0
  ) {
    return null;
  }
  return (value / referencePrice) * 10_000;
}

function bpsFromNotional(value: number | null, notional: number): number | null {
  if (value == null || !Number.isFinite(value) || !Number.isFinite(notional) || notional <= 0) {
    return null;
  }
  return (value / notional) * 10_000;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringFieldFromRecord(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFiniteNumberFieldFromRecord(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArrayFieldFromRecord(
  source: Record<string, unknown>,
  key: string,
): string[] | null {
  const value = source[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : null;
}

function readUnknownDate(source: Record<string, unknown>, key: string): Date | string | null {
  const value = source[key];
  return value instanceof Date || typeof value === 'string' ? value : null;
}

function readNumberFieldFromRecord(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readDateField(source: unknown, key: string): Date | null {
  if (!source || typeof source !== 'object') {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

function readTimestamp(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function finiteNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampFraction(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value ?? 0));
}
