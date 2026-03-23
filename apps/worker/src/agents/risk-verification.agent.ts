import { randomUUID } from 'crypto';
import { PrismaClient, Signal } from '@prisma/client';
import { EvaluateTradeOpportunitiesJob } from '@worker/jobs/evaluateTradeOpportunities.job';
import { appEnv } from '@worker/config/env';
import { RuntimeLiveConfig } from '@worker/runtime/runtime-control.repository';
import { OpenAiClient } from '@polymarket-btc-5m-agentic-bot/agent-layer';
import { ExecutionSemanticsPolicy } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { NegativeRiskPolicy } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { TradeIntentResolver } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { SafetyStateControls, SafetyState } from '@polymarket-btc-5m-agentic-bot/risk-engine';

type Outcome = 'YES' | 'NO';
type VenueSide = 'BUY' | 'SELL';
type RiskAction = 'ENTER' | 'REDUCE' | 'EXIT';

interface RiskAiVetoResponse {
  allowEntries?: unknown;
  reasonCode?: unknown;
  reasonMessage?: unknown;
  confidence?: unknown;
}

interface ResolvedRiskIntent {
  tokenId: string;
  outcome: Outcome;
  venueSide: VenueSide;
  action: RiskAction;
  inventoryEffect: 'increase' | 'decrease';
}

export interface RiskVerificationAgentResult {
  approved: number;
  rejected: number;
  killSwitchTriggered: boolean;
  killSwitchReason: string | null;
  safetyState?: SafetyState;
  safetyReasonCodes?: string[];
  safetyControls?: SafetyStateControls;
  finalVetoTriggered?: boolean;
  finalVetoReason?: string | null;
  vetoedSignals?: number;
  allowEntries?: boolean;
}

export class RiskVerificationAgent {
  private readonly executionSemanticsPolicy = new ExecutionSemanticsPolicy();
  private readonly negativeRiskPolicy = new NegativeRiskPolicy();
  private readonly tradeIntentResolver = new TradeIntentResolver();

  constructor(
    private readonly evaluateTradeOpportunitiesJob: EvaluateTradeOpportunitiesJob,
    private readonly prisma?: PrismaClient,
  ) {}

  async run(config: RuntimeLiveConfig): Promise<RiskVerificationAgentResult> {
    const baseResult = await this.evaluateTradeOpportunitiesJob.run(config);
    if (baseResult.killSwitchTriggered) {
      return {
        ...baseResult,
        finalVetoTriggered: true,
        finalVetoReason: baseResult.killSwitchReason,
        vetoedSignals: 0,
        allowEntries: false,
      };
    }

    const prisma = this.prisma;
    if (!prisma) {
      return {
        ...baseResult,
        finalVetoTriggered: false,
        finalVetoReason: null,
        vetoedSignals: 0,
        allowEntries: true,
      };
    }

    const approvedSignals = await prisma.signal.findMany({
      where: { status: 'approved' },
      orderBy: { observedAt: 'asc' },
      take: 50,
    });

    let vetoedSignals = 0;
    for (const signal of approvedSignals) {
      const reasons = await this.computeDeterministicVetoReasons(signal, config);
      if (reasons.length === 0) {
        continue;
      }

      await this.vetoSignal(signal, `risk_final_veto_${reasons[0]}`, reasons.join(','));
      vetoedSignals += 1;
    }

    const remainingApproved = await prisma.signal.findMany({
      where: { status: 'approved' },
      orderBy: { observedAt: 'asc' },
      take: 50,
    });

    const aiVeto =
      remainingApproved.length > 0
        ? await this.evaluateAiVeto(config, {
            approvedSignals: remainingApproved,
            deterministicVetoedSignals: vetoedSignals,
            baseResult,
          })
        : {
            allowEntries: true,
            reasonCode: 'no_approved_signals',
            reasonMessage: null,
          };

    let aiVetoed = 0;
    if (!aiVeto.allowEntries && remainingApproved.length > 0) {
      for (const signal of remainingApproved) {
        await this.vetoSignal(
          signal,
          aiVeto.reasonCode,
          aiVeto.reasonMessage ?? aiVeto.reasonCode,
        );
        aiVetoed += 1;
      }
    }

    const finalVetoTriggered = vetoedSignals + aiVetoed > 0 || !aiVeto.allowEntries;
    const finalVetoReason =
      !aiVeto.allowEntries
        ? aiVeto.reasonCode
        : vetoedSignals > 0
          ? 'risk_final_veto_deterministic'
          : null;

    return {
      ...baseResult,
      finalVetoTriggered,
      finalVetoReason,
      vetoedSignals: vetoedSignals + aiVetoed,
      allowEntries: !finalVetoTriggered,
    };
  }

  private getRiskAiClient(): OpenAiClient | null {
    return appEnv.IS_PRODUCTION && appEnv.OPENAI_API_KEY
      ? new OpenAiClient(appEnv.OPENAI_API_KEY)
      : null;
  }

  private async computeDeterministicVetoReasons(
    signal: Signal,
    config: RuntimeLiveConfig,
  ): Promise<string[]> {
    const prisma = this.prisma;
    if (!prisma) {
      return [];
    }

    const now = Date.now();
    const reasons: string[] = [];
    const signalAgeMs = now - new Date(signal.observedAt).getTime();
    if (signalAgeMs > appEnv.BOT_MAX_SIGNAL_AGE_MS) {
      reasons.push('signal_stale');
    }

    const market = await prisma.market.findUnique({
      where: { id: signal.marketId },
    });
    if (!market) {
      reasons.push('market_missing');
      return reasons;
    }

    const resolvedIntent = this.resolveRiskIntent(signal, market);
    if (!resolvedIntent) {
      reasons.push('ambiguous_execution_intent');
      return reasons;
    }

    const { tokenId, outcome, action, venueSide, inventoryEffect } = resolvedIntent;

    const [orderbook, snapshot, duplicateWorkingOrder, duplicateOpenPosition] =
      await Promise.all([
        prisma.orderbook.findFirst({
          where: {
            marketId: signal.marketId,
            tokenId,
          },
          orderBy: { observedAt: 'desc' },
        }),
        prisma.marketSnapshot.findFirst({
          where: { marketId: signal.marketId },
          orderBy: { observedAt: 'desc' },
        }),
        prisma.order.findFirst({
          where: {
            marketId: signal.marketId,
            tokenId,
            signalId: { not: signal.id },
            status: {
              in: ['submitted', 'acknowledged', 'partially_filled'],
            },
            ...(inventoryEffect === 'increase'
              ? {
                  side: venueSide,
                }
              : {}),
          },
        }),
        this.findDuplicateOpenPosition({
          marketId: signal.marketId,
          tokenId,
          outcome,
          action,
          inventoryEffect,
        }),
      ]);
    const expiryAt = snapshot?.expiresAt ?? market.expiresAt ?? null;

    if (!orderbook) {
      reasons.push('orderbook_missing');
    } else {
      const orderbookAgeMs = now - new Date(orderbook.observedAt).getTime();
      if (orderbookAgeMs > appEnv.BOT_MAX_ORDERBOOK_AGE_MS) {
        reasons.push('orderbook_stale');
      }

      const tickSize = this.normalizePositiveNumber(
        (orderbook as Record<string, unknown>).tickSize as number | null | undefined,
      );
      const minOrderSize = this.normalizePositiveNumber(
        (orderbook as Record<string, unknown>).minOrderSize as number | null | undefined,
      );
      const negRiskRaw = (orderbook as Record<string, unknown>).negRisk;
      const negRisk = typeof negRiskRaw === 'boolean' ? negRiskRaw : null;

      if (tickSize === null) {
        reasons.push('orderbook_tick_size_missing');
      }

      if (minOrderSize === null) {
        reasons.push('orderbook_min_order_size_missing');
      }

      if (negRisk === null) {
        reasons.push('orderbook_neg_risk_missing');
      } else {
        const negRiskVerdict = this.negativeRiskPolicy.evaluate({
          negRisk,
        });
        if (!negRiskVerdict.allowed) {
          reasons.push(negRiskVerdict.reasonCode);
        }
      }

      const referencePrice = venueSide === 'BUY'
        ? this.normalizePositiveNumber(orderbook.bestAsk ?? null)
        : this.normalizePositiveNumber(orderbook.bestBid ?? null);

      if (referencePrice === null) {
        reasons.push('reference_price_missing');
      } else {
        const positionSize = await this.latestApprovedPositionSize(signal.id);
        if (positionSize !== null) {
          const expectedSize = positionSize / referencePrice;

          if (!Number.isFinite(expectedSize) || expectedSize <= 0) {
            reasons.push('expected_order_size_invalid');
          } else if (minOrderSize !== null && expectedSize < minOrderSize) {
            reasons.push('size_below_min_order_size');
          }

          const orderSemantics = this.executionSemanticsPolicy.evaluate({
            action,
            urgency: this.resolveExecutionUrgency(signalAgeMs, appEnv.BOT_MAX_SIGNAL_AGE_MS),
            size: expectedSize,
            executableDepth: this.topLevelDepth(orderbook, venueSide),
            expiryAt: new Date(expiryAt ?? new Date()).toISOString(),
            noTradeWindowSeconds: config.noTradeWindowSeconds,
            partialFillTolerance:
              action === 'ENTER' && signalAgeMs > appEnv.BOT_MAX_SIGNAL_AGE_MS / 2
                ? 'all_or_nothing'
                : 'allow_partial',
            preferResting: action === 'ENTER' && signalAgeMs <= appEnv.BOT_MAX_SIGNAL_AGE_MS / 2,
          });

          const topLevelDepth = this.topLevelDepth(orderbook, venueSide);
          if (
            orderSemantics.executionStyle === 'cross' &&
            (!Number.isFinite(topLevelDepth) || topLevelDepth <= 0)
          ) {
            reasons.push('immediate_execution_liquidity_missing');
          } else if (
            orderSemantics.orderType === 'FOK' &&
            Number.isFinite(expectedSize) &&
            expectedSize > 0 &&
            topLevelDepth > 0 &&
            expectedSize > topLevelDepth
          ) {
            reasons.push('fok_fak_depth_insufficient');
          }
        }
      }
    }

    if (!snapshot) {
      reasons.push('market_snapshot_missing');
    } else {
      const snapshotAgeMs = now - new Date(snapshot.observedAt).getTime();
      if (snapshotAgeMs > appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS) {
        reasons.push('market_snapshot_stale');
      }
    }

    if (!expiryAt) {
      reasons.push('expiry_unknown');
    } else {
      const secondsToExpiry = Math.floor((new Date(expiryAt).getTime() - now) / 1000);
      if (secondsToExpiry <= config.noTradeWindowSeconds) {
        reasons.push('no_trade_near_expiry');
      }
    }

    if (duplicateWorkingOrder) {
      reasons.push('duplicate_working_order_exposure');
    }

    if (inventoryEffect === 'increase' && duplicateOpenPosition) {
      reasons.push('duplicate_open_position_exposure');
    }

    if (inventoryEffect === 'decrease' && !duplicateOpenPosition) {
      reasons.push('position_to_reduce_missing');
    }

    return reasons;
  }

  private async latestApprovedPositionSize(signalId: string): Promise<number | null> {
    const prisma = this.prisma;
    if (!prisma) {
      return null;
    }

    const latestDecision = await prisma.signalDecision.findFirst({
      where: {
        signalId,
        verdict: 'approved',
      },
      orderBy: {
        decisionAt: 'desc',
      },
    });

    if (!latestDecision || !Number.isFinite(latestDecision.positionSize)) {
      return null;
    }

    return latestDecision.positionSize ?? null;
  }

  private async findDuplicateOpenPosition(input: {
    marketId: string;
    tokenId: string;
    outcome: Outcome;
    action: RiskAction;
    inventoryEffect: 'increase' | 'decrease';
  }): Promise<unknown | null> {
    const prisma = this.prisma;
    if (!prisma) {
      return null;
    }

    const byTokenId = await prisma.position.findFirst({
      where: {
        marketId: input.marketId,
        status: 'open',
        tokenId: input.tokenId,
      } as any,
    });

    if (byTokenId) {
      return byTokenId;
    }

    const byOutcome = await prisma.position.findFirst({
      where: {
        marketId: input.marketId,
        status: 'open',
        OR: [
          { side: input.outcome === 'YES' ? 'BUY' : 'SELL' },
          { side: input.outcome === 'NO' ? 'BUY' : 'SELL' },
        ],
      },
    });

    return byOutcome;
  }

  private resolveRiskIntent(
    signal: unknown,
    market: unknown,
  ): ResolvedRiskIntent | null {
    const resolution = this.tradeIntentResolver.resolve({
      market: {
        id: this.readStringField(market, 'id') ?? '',
        tokenIdYes: this.readStringField(market, 'tokenIdYes'),
        tokenIdNo: this.readStringField(market, 'tokenIdNo'),
      },
      signal: {
        marketId: this.readStringField(signal, 'marketId'),
        side: this.readStringField(signal, 'side'),
        venueSide: this.readStringField(signal, 'venueSide'),
        tokenId: this.readStringField(signal, 'tokenId'),
        outcome: this.readStringField(signal, 'outcome'),
        targetOutcome: this.readStringField(signal, 'targetOutcome'),
        action: this.readStringField(signal, 'action'),
        intent: this.readStringField(signal, 'intent'),
      },
    });

    if (!resolution.ok) {
      return null;
    }

    return {
      tokenId: resolution.resolved.tokenId,
      outcome: resolution.resolved.outcome,
      action: resolution.resolved.intent as RiskAction,
      venueSide: resolution.resolved.venueSide,
      inventoryEffect:
        resolution.resolved.inventoryEffect === 'INCREASE'
          ? 'increase'
          : 'decrease',
    };
  }

  private async vetoSignal(
    signal: Signal,
    reasonCode: string,
    reasonMessage: string,
  ): Promise<void> {
    const prisma = this.prisma;
    if (!prisma) {
      return;
    }

    if (signal.status !== 'rejected') {
      await prisma.signal.update({
        where: { id: signal.id },
        data: { status: 'rejected' },
      });
    }

    await prisma.signalDecision.create({
      data: {
        id: randomUUID(),
        signalId: signal.id,
        verdict: 'rejected',
        reasonCode,
        reasonMessage,
        expectedEv: signal.expectedEv,
        positionSize: null,
        decisionAt: new Date(),
      },
    });
  }

  private async evaluateAiVeto(
    config: RuntimeLiveConfig,
    input: {
      approvedSignals: Signal[];
      deterministicVetoedSignals: number;
      baseResult: {
        approved: number;
        rejected: number;
        killSwitchTriggered: boolean;
        killSwitchReason: string | null;
      };
    },
  ): Promise<{ allowEntries: boolean; reasonCode: string; reasonMessage: string | null }> {
    const client = this.getRiskAiClient();
    if (!client) {
      return {
        allowEntries: true,
        reasonCode: 'risk_ai_disabled',
        reasonMessage: null,
      };
    }

    try {
      const resolvedSignals = await Promise.all(
        input.approvedSignals.map(async (signal) => {
          const market = this.prisma
            ? await this.prisma.market.findUnique({ where: { id: signal.marketId } })
            : null;
          const resolvedIntent = market ? this.resolveRiskIntent(signal, market) : null;

          return {
            id: signal.id,
            marketId: signal.marketId,
            signalSide: signal.side,
            expectedEv: signal.expectedEv,
            observedAt: signal.observedAt,
            tokenId: resolvedIntent?.tokenId ?? null,
            outcome: resolvedIntent?.outcome ?? null,
            action: resolvedIntent?.action ?? null,
            venueSide: resolvedIntent?.venueSide ?? null,
            inventoryEffect: resolvedIntent?.inventoryEffect ?? null,
          };
        }),
      );

      const aiResponse = await client.generateStructured<RiskAiVetoResponse>({
        model: appEnv.OPENAI_MODEL_CRITIC,
        systemPrompt:
          'You are the final risk veto authority for a live BTC 5-minute Polymarket trading system. Return JSON with allowEntries (boolean), reasonCode (string), reasonMessage (string), and confidence (number 0..1). Be strict: disallow entries when risk context is stale, contradictory, under-specified, or when token selection and exposure semantics are ambiguous.',
        userPrompt: JSON.stringify({
          config,
          approvedSignals: resolvedSignals,
          deterministicVetoedSignals: input.deterministicVetoedSignals,
          evaluationSummary: input.baseResult,
          now: new Date().toISOString(),
        }),
        schemaName: 'risk_final_veto',
      });

      const allowEntries = this.toBoolean(aiResponse.output.allowEntries);
      if (allowEntries === null) {
        return {
          allowEntries: false,
          reasonCode: 'risk_ai_invalid_response',
          reasonMessage: 'AI risk veto response missing boolean allowEntries.',
        };
      }

      const reasonCode = this.toString(aiResponse.output.reasonCode) ?? 'risk_ai_veto';
      const reasonMessage = this.toString(aiResponse.output.reasonMessage);
      return {
        allowEntries,
        reasonCode,
        reasonMessage,
      };
    } catch (error) {
      return {
        allowEntries: false,
        reasonCode: 'risk_ai_unavailable',
        reasonMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private readStringField(source: unknown, key: string): string | null {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private toBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
    }
    return null;
  }

  private toString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizePositiveNumber(value: number | null | undefined): number | null {
    return Number.isFinite(value) && (value as number) > 0 ? (value as number) : null;
  }

  private topLevelDepth(
    orderbook: {
      bidLevels: unknown;
      askLevels: unknown;
    },
    side: VenueSide,
  ): number {
    const levels = side === 'BUY' ? orderbook.askLevels : orderbook.bidLevels;
    if (!Array.isArray(levels) || levels.length === 0) {
      return 0;
    }

    const top = levels[0];
    if (Array.isArray(top) && top.length >= 2) {
      const size = Number(top[1]);
      return Number.isFinite(size) && size > 0 ? size : 0;
    }
    if (typeof top === 'object' && top !== null) {
      const record = top as Record<string, unknown>;
      const size = Number(record.size ?? record.s ?? Number.NaN);
      return Number.isFinite(size) && size > 0 ? size : 0;
    }
    return 0;
  }

  private resolveExecutionUrgency(
    signalAgeMs: number,
    maxSignalAgeMs: number,
  ): 'low' | 'medium' | 'high' {
    if (signalAgeMs > maxSignalAgeMs * 0.8) {
      return 'high';
    }
    if (signalAgeMs > maxSignalAgeMs * 0.5) {
      return 'medium';
    }
    return 'low';
  }
}
