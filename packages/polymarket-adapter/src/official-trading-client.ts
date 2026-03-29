import { VenueOrderValidator } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { ServerSigner } from '@polymarket-btc-5m-agentic-bot/signing-engine';
import {
  PolymarketVenueAwareness,
  PolymarketVenueRequestScope,
  PolymarketVenueStartupPreflight,
} from './polymarket-venue-awareness';
import {
  parseBalanceAllowancePayload,
  parseDataApiPositionsPayload,
  parseDataApiTradesPayload,
  parseOpenOrdersPayload,
  parseOrderbookPayload,
  parseRewardsPayload,
  parseTradesPayload,
} from './parsers/venue-parsers';
import { pathToFileURL } from 'url';
import path from 'path';

export type Outcome = 'YES' | 'NO';
export type TradeIntent = 'ENTER' | 'REDUCE' | 'EXIT' | 'FLIP';
export type VenueSide = 'BUY' | 'SELL';
export type InventoryEffect = 'INCREASE' | 'DECREASE' | 'NEUTRAL';
export type VenueOrderType = 'GTC' | 'FOK' | 'FAK' | 'GTD';

export interface OfficialTradingClientConfig {
  host: string;
  dataApiHost?: string | null;
  chainId: number;
  privateKey: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  signatureType?: number;
  funder?: string | null;
  profileAddress?: string | null;
  geoBlockToken?: string | null;
  useServerTime?: boolean;
  retryOnError?: boolean;
  maxClockSkewMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SubmitVenueOrderInput {
  /**
   * Specific Polymarket token to trade.
   * This must already be resolved by upstream logic.
   * The adapter must never infer tokenId from side.
   */
  tokenId: string;

  /**
   * Exchange-facing venue side only.
   * BUY means acquire inventory of tokenId.
   * SELL means dispose of inventory of tokenId.
   *
   * This is NOT model direction and NOT market thesis.
   */
  side: VenueSide;

  /**
   * Optional semantic metadata passed through for observability/debugging.
   * These fields must not alter adapter execution behavior.
   */
  outcome?: Outcome | null;
  intent?: TradeIntent | null;
  inventoryEffect?: InventoryEffect | null;

  /**
   * Optional venue validity metadata supplied by upper layers.
   * These are validation inputs only and are not used to reconstruct token selection.
   */
  tickSize?: number | null;
  minOrderSize?: number | null;
  negRisk?: boolean | null;

  price: number;
  size: number;
  orderType: VenueOrderType;
  expiration?: string | null;
  clientOrderId?: string | null;
}

export interface SubmitVenueOrderResult {
  success: boolean;
  orderId: string | null;
  status: string;
  raw: unknown;
}

export type BalanceAllowanceAssetType = 'COLLATERAL' | 'CONDITIONAL';

export interface BalanceAllowanceSnapshot {
  assetType: BalanceAllowanceAssetType;
  tokenId: string | null;
  balance: number;
  allowance: number;
  checkedAt: string;
  raw: unknown;
}

const CONDITIONAL_TOKEN_UNIT_SCALE = 1_000_000;

export interface VenueHeartbeatResult {
  success: boolean;
  heartbeatId: string | null;
  error: string | null;
  raw: unknown;
}

export interface VenueOrderBookSummary {
  tokenId: string;
  tickSize: number | null;
  minOrderSize: number | null;
  negRisk: boolean | null;
  raw: unknown;
}

export interface VenueOpenOrder {
  id: string;
  status: string;

  /**
   * Venue side returned by Polymarket.
   */
  side: string;

  price: number;
  size: number;
  matchedSize: number;

  /**
   * Explicit token identifier returned by venue.
   */
  tokenId: string;

  createdAt?: string;
  raw: unknown;
}

export interface VenueTradeRecord {
  id: string;
  orderId: string | null;

  /**
   * Explicit token identifier returned by venue.
   */
  tokenId: string;

  /**
   * Venue side returned by Polymarket.
   */
  side: string;

  price: number;
  size: number;
  fee: number | null;
  filledAt: string | null;
  status: string | null;
  raw: unknown;
}

export interface DataApiUserTradeRecord {
  id: string;
  tokenId: string;
  marketId: string | null;
  conditionId: string | null;
  side: string;
  price: number;
  size: number;
  outcome: string | null;
  timestamp: string | null;
  transactionHash: string | null;
  raw: unknown;
}

export interface DataApiPositionRecord {
  tokenId: string;
  marketId: string | null;
  conditionId: string | null;
  size: number;
  avgPrice: number | null;
  initialValue: number | null;
  currentValue: number | null;
  cashPnl: number | null;
  realizedPnl: number | null;
  currentPrice: number | null;
  outcome: string | null;
  oppositeTokenId: string | null;
  endDate: string | null;
  negativeRisk: boolean | null;
  raw: unknown;
}

export interface VenueFeeRateSnapshot {
  tokenId: string;
  feeRateBps: number;
  fetchedAt: string;
  raw: unknown;
}

export interface VenueOrderScoringStatus {
  orderId: string;
  scoring: boolean;
  checkedAt: string;
}

export interface VenueRewardToken {
  tokenId: string;
  outcome: string | null;
  price: number | null;
}

export interface VenueRewardMarket {
  conditionId: string;
  rewardsMaxSpread: number | null;
  rewardsMinSize: number | null;
  marketSlug: string | null;
  question: string | null;
  tokens: VenueRewardToken[];
  raw: unknown;
}

interface OfficialClobClientInstance {
  getOk: () => Promise<unknown>;
  getServerTime: () => Promise<number>;
  createOrder: (
    order: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  postOrder: (
    signedOrder: unknown,
    orderType: unknown,
    deferExec?: boolean,
    postOnly?: boolean,
  ) => Promise<Record<string, unknown>>;
  getOrderBook: (tokenId: string) => Promise<unknown>;
  getBalanceAllowance: (params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getClosedOnlyMode: () => Promise<Record<string, unknown>>;
  getOpenOrders: () => Promise<unknown>;
  getTrades: () => Promise<unknown>;
  getFeeRateBps: (tokenId: string) => Promise<number>;
  isOrderScoring?: (params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  areOrdersScoring?: (params?: Record<string, unknown>) => Promise<Record<string, boolean>>;
  getCurrentRewards?: () => Promise<unknown>;
  postHeartbeat: (heartbeatId?: string | null) => Promise<Record<string, unknown>>;
  cancelOrder: (payload: { orderID: string }) => Promise<Record<string, unknown>>;
}

interface OfficialClobModule {
  ClobClient: new (
    host: string,
    chainId: number,
    signer?: unknown,
    creds?: { key: string; secret: string; passphrase: string },
    signatureType?: number,
    funderAddress?: string,
    geoBlockToken?: string,
    useServerTime?: boolean,
    builderConfig?: unknown,
    getSigner?: () => Promise<unknown> | unknown,
    retryOnError?: boolean,
    tickSizeTtlMs?: number,
    throwOnError?: boolean,
  ) => OfficialClobClientInstance;
  OrderType: Record<string, unknown>;
  Side: Record<string, unknown>;
  AssetType?: Record<string, unknown>;
}

interface EthersModule {
  Wallet: new (privateKey: string) => unknown;
}

function dynamicImport<T>(specifier: string): Promise<T> {
  const importer = new Function('s', 'return import(s)') as (s: string) => Promise<T>;
  return importer(specifier);
}

async function importPolymarketClobModule(): Promise<OfficialClobModule> {
  const candidates = ['@polymarket/clob-client', '@polymarket/clob-client/dist/index.js'];
  const searchPaths = [process.cwd(), path.join(process.cwd(), 'apps/worker')];
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      const resolved = require.resolve(candidate, {
        paths: searchPaths,
      });
      return await dynamicImport<OfficialClobModule>(pathToFileURL(resolved).href);
    } catch (error) {
      failures.push(
        `${candidate}=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  throw new Error(
    `Failed to resolve @polymarket/clob-client for the runtime workspace. ${failures.join(
      '; ',
    )}`,
  );
}

async function importEthersModule(): Promise<EthersModule> {
  const candidates = ['ethers'];
  const searchPaths = [process.cwd(), path.join(process.cwd(), 'apps/worker')];
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      const resolved = require.resolve(candidate, {
        paths: searchPaths,
      });
      return await dynamicImport<EthersModule>(pathToFileURL(resolved).href);
    } catch (error) {
      failures.push(
        `${candidate}=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  throw new Error(`Failed to resolve ethers for the runtime workspace. ${failures.join('; ')}`);
}

export class OfficialPolymarketTradingClient {
  private clientPromise: Promise<OfficialClobClientInstance> | null = null;
  private profileAddressPromise: Promise<string> | null = null;
  private modulePromise:
    | Promise<{ clob: OfficialClobModule; ethers: EthersModule }>
    | null = null;
  private readonly venueOrderValidator = new VenueOrderValidator();
  private readonly venueAwareness: PolymarketVenueAwareness;
  private readonly serverSigner: ServerSigner;

  constructor(private readonly config: OfficialTradingClientConfig) {
    this.venueAwareness = new PolymarketVenueAwareness({
      host: config.host,
      maxClockSkewMs: config.maxClockSkewMs,
    });
    this.serverSigner = new ServerSigner({
      privateKey: config.privateKey,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      apiPassphrase: config.apiPassphrase,
      funder: config.funder ?? null,
      profileAddress: config.profileAddress ?? null,
      signatureType: config.signatureType,
    });
  }

  async postOrder(input: SubmitVenueOrderInput): Promise<SubmitVenueOrderResult> {
    this.validateSubmitVenueOrderInput(input);
    this.validateConfig();

    return this.executeVenueOperation('submit', 'post_order', async () => {
      const client = await this.getClient();
      const { clob } = await this.getModules();

      const orderType = clob.OrderType[input.orderType];
      const venueSide = clob.Side[input.side];

      if (orderType == null) {
        throw new Error(`Unsupported venue order type: ${input.orderType}`);
      }

      if (venueSide == null) {
        throw new Error(`Unsupported venue side: ${input.side}`);
      }

      const orderPayload: Record<string, unknown> = {
        tokenID: input.tokenId,
        side: venueSide,
        price: input.price,
        size: input.size,
      };

      if (input.expiration) {
        orderPayload.expiration = this.toUnixSeconds(input.expiration);
      }

      if (input.clientOrderId) {
        orderPayload.clientOrderId = input.clientOrderId;
      }

      // Canonical live Polymarket path:
      // strategy/risk/execution produce one venue order payload here, the official
      // Polymarket SDK signs it with the configured wallet, and the same client
      // submits it. There is no generic signer fallback in the live path.
      const signedOrder = await client.createOrder(orderPayload, {
        tickSize: this.toSdkTickSize(input.tickSize),
        negRisk: input.negRisk,
      });

      const { deferExec, postOnly } = this.resolveExecutionFlags(input.orderType);

      const response = await client.postOrder(
        signedOrder,
        orderType,
        deferExec,
        postOnly,
      );

      const orderId =
        typeof response.orderID === 'string'
          ? response.orderID
          : typeof response.orderId === 'string'
            ? response.orderId
            : null;

      return {
        success: response.success === true && orderId !== null,
        orderId,
        status:
          typeof response.status === 'string'
            ? response.status
            : typeof response.errorMsg === 'string'
              ? response.errorMsg
              : 'unknown',
        raw: response,
      };
    });
  }

  async getOrderBook(tokenId: string): Promise<VenueOrderBookSummary> {
    if (!tokenId || tokenId.trim().length === 0) {
      throw new Error('getOrderBook requires a non-empty tokenId.');
    }

    return this.executeVenueOperation('public', 'get_order_book', async () => {
      const client = await this.getClient();
      const parsed = parseOrderbookPayload(
        tokenId.trim(),
        await client.getOrderBook(tokenId.trim()),
        'official_client_get_order_book',
      );

      return {
        tokenId: parsed.tokenId,
        tickSize: parsed.tickSize,
        minOrderSize: parsed.minOrderSize,
        negRisk: parsed.negRisk,
        raw: parsed.raw,
      };
    });
  }

  async getBalanceAllowance(input: {
    assetType: BalanceAllowanceAssetType;
    tokenId?: string | null;
  }): Promise<BalanceAllowanceSnapshot> {
    if (input.assetType === 'CONDITIONAL' && (!input.tokenId || input.tokenId.trim().length === 0)) {
      throw new Error('Conditional balance/allowance checks require tokenId.');
    }

    return this.executeVenueOperation('private', 'get_balance_allowance', async () => {
      const client = await this.getClient();
      const { clob } = await this.getModules();
      const assetType = clob.AssetType?.[input.assetType] ?? input.assetType;
      const response = await client.getBalanceAllowance({
        asset_type: assetType,
        ...(input.assetType === 'CONDITIONAL' && input.tokenId
          ? { token_id: input.tokenId.trim() }
          : {}),
      });
      const parsed = parseBalanceAllowancePayload(
        response,
        'official_client_get_balance_allowance',
      );

      return {
        assetType: input.assetType,
        tokenId: input.tokenId?.trim() ?? null,
        balance: this.normalizeBalanceAllowanceAmount(
          parsed.balance,
          input.assetType,
        ),
        allowance: this.normalizeBalanceAllowanceAmount(
          parsed.allowance,
          input.assetType,
        ),
        checkedAt: new Date().toISOString(),
        raw: parsed.raw,
      };
    });
  }

  async getOpenOrders(): Promise<VenueOpenOrder[]> {
    return this.executeVenueOperation('private', 'get_open_orders', async () => {
      const client = await this.getClient();
      return parseOpenOrdersPayload(
        await client.getOpenOrders(),
        'official_client_get_open_orders',
      ).map((order) => {
        const normalized: VenueOpenOrder = {
          id: order.id,
          status: order.status,
          side: order.side,
          price: order.price,
          size: order.size,
          matchedSize: order.matchedSize,
          tokenId: order.tokenId,
          raw: order.raw,
        };
        if (order.createdAt) {
          normalized.createdAt = order.createdAt;
        }
        return normalized;
      });
    });
  }

  async getTrades(): Promise<VenueTradeRecord[]> {
    return this.executeVenueOperation('private', 'get_trades', async () => {
      const client = await this.getClient();
      return parseTradesPayload(await client.getTrades(), 'official_client_get_trades');
    });
  }

  async getFeeRate(tokenId: string): Promise<VenueFeeRateSnapshot> {
    if (!tokenId || tokenId.trim().length === 0) {
      throw new Error('getFeeRate requires a non-empty tokenId.');
    }

    return this.executeVenueOperation('public', 'get_fee_rate', async () => {
      const client = await this.getClient();
      const feeRateBps = await client.getFeeRateBps(tokenId.trim());
      if (!Number.isFinite(feeRateBps) || feeRateBps < 0) {
        throw new Error(`Invalid fee rate returned for token ${tokenId}.`);
      }

      return {
        tokenId: tokenId.trim(),
        feeRateBps,
        fetchedAt: new Date().toISOString(),
        raw: {
          feeRateBps,
        },
      };
    });
  }

  async getOrderScoring(orderIds: string[]): Promise<VenueOrderScoringStatus[]> {
    const normalizedOrderIds = [...new Set(orderIds.map((orderId) => orderId.trim()))].filter(
      (orderId) => orderId.length > 0,
    );
    if (normalizedOrderIds.length === 0) {
      return [];
    }

    return this.executeVenueOperation('private', 'get_order_scoring', async () => {
      const client = await this.getClient();
      const checkedAt = new Date().toISOString();

      if (normalizedOrderIds.length === 1 && client.isOrderScoring) {
        const response = await client.isOrderScoring({
          order_id: normalizedOrderIds[0],
        });
        return [
          {
            orderId: normalizedOrderIds[0],
            scoring: response.scoring === true,
            checkedAt,
          },
        ];
      }

      if (client.areOrdersScoring) {
        const response = await client.areOrdersScoring({
          orderIds: normalizedOrderIds,
        });
        return normalizedOrderIds.map((orderId) => ({
          orderId,
          scoring: response[orderId] === true,
          checkedAt,
        }));
      }

      throw new Error('Official Polymarket client does not expose order scoring methods.');
    });
  }

  async getCurrentRewards(): Promise<VenueRewardMarket[]> {
    return this.executeVenueOperation('public', 'get_current_rewards', async () => {
      const client = await this.getClient();
      if (!client.getCurrentRewards) {
        throw new Error('Official Polymarket client does not expose current rewards.');
      }

      return parseRewardsPayload(await client.getCurrentRewards(), 'official_client_get_rewards');
    });
  }

  async getUserTrades(limit = 500): Promise<DataApiUserTradeRecord[]> {
    const profileAddress = await this.getProfileAddress();
    const recordsPayload = await this.fetchPaginatedDataApiArray('/trades', {
      operation: 'get_user_trades',
      scope: 'private',
      params: {
        user: profileAddress,
        takerOnly: false,
      },
      pageSize: Math.min(Math.max(Math.trunc(limit), 1), 500),
      maxPages: 4,
    });

    return parseDataApiTradesPayload(recordsPayload, 'official_client_get_user_trades');
  }

  async getCurrentPositions(limit = 500): Promise<DataApiPositionRecord[]> {
    return this.getDataApiPositions('/positions', 'get_current_positions', limit);
  }

  async getClosedPositions(limit = 500): Promise<DataApiPositionRecord[]> {
    return this.getDataApiPositions('/closed-positions', 'get_closed_positions', limit);
  }

  async postHeartbeat(heartbeatId?: string | null): Promise<VenueHeartbeatResult> {
    return this.executeVenueOperation('heartbeat', 'post_heartbeat', async () => {
      const client = await this.getClient();
      const response = await client.postHeartbeat(heartbeatId ?? null);

      return {
        success: typeof response.error === 'string' ? false : true,
        heartbeatId:
          typeof response.heartbeat_id === 'string'
            ? response.heartbeat_id
            : typeof response.heartbeatId === 'string'
              ? response.heartbeatId
              : null,
        error: typeof response.error === 'string' ? response.error : null,
        raw: response,
      };
    });
  }

  async cancelOrder(orderId: string): Promise<{ success: boolean; raw: unknown }> {
    if (!orderId || orderId.trim().length === 0) {
      throw new Error('cancelOrder requires a non-empty orderId.');
    }

    return this.executeVenueOperation('cancel', 'cancel_order', async () => {
      const client = await this.getClient();
      const response = await client.cancelOrder({
        orderID: orderId,
      });

      return {
        success: response.success !== false,
        raw: response,
      };
    });
  }

  async preflightVenue(): Promise<PolymarketVenueStartupPreflight> {
    this.validateConfig();
    const client = await this.getClient();

    return this.venueAwareness.preflightStartup({
      getOk: () => client.getOk(),
      getServerTime: () => client.getServerTime(),
      getClosedOnlyMode: () => client.getClosedOnlyMode(),
    });
  }

  private validateSubmitVenueOrderInput(input: SubmitVenueOrderInput): void {
    if (!input.tokenId || input.tokenId.trim().length === 0) {
      throw new Error('SubmitVenueOrderInput requires explicit tokenId.');
    }

    if (input.side !== 'BUY' && input.side !== 'SELL') {
      throw new Error(`Invalid venue side: ${String(input.side)}`);
    }

    if (!Number.isFinite(input.price) || input.price <= 0) {
      throw new Error('SubmitVenueOrderInput requires positive finite price.');
    }

    if (!Number.isFinite(input.size) || input.size <= 0) {
      throw new Error('SubmitVenueOrderInput requires positive finite size.');
    }

    if (!['GTC', 'FOK', 'FAK', 'GTD'].includes(input.orderType)) {
      throw new Error(`Invalid order type: ${String(input.orderType)}`);
    }

    if (input.tickSize != null) {
      if (!Number.isFinite(input.tickSize) || input.tickSize <= 0) {
        throw new Error('tickSize must be a positive finite number when provided.');
      }

      if (!this.isOnTick(input.price, input.tickSize)) {
        throw new Error(
          `Price ${input.price} is not aligned to tickSize ${input.tickSize}.`,
        );
      }
    }

    if (input.minOrderSize != null) {
      if (!Number.isFinite(input.minOrderSize) || input.minOrderSize <= 0) {
        throw new Error('minOrderSize must be a positive finite number when provided.');
      }

      if (input.size < input.minOrderSize) {
        throw new Error(
          `Order size ${input.size} is below minOrderSize ${input.minOrderSize}.`,
        );
      }
    }

    if (input.orderType === 'GTD' && !input.expiration) {
      throw new Error('GTD orders require expiration.');
    }

    if ((input.orderType === 'FOK' || input.orderType === 'FAK') && input.expiration) {
      throw new Error(`${input.orderType} orders must not include expiration.`);
    }

    const venueValidation = this.venueOrderValidator.validate({
      tokenId: input.tokenId,
      side: input.side,
      price: input.price,
      size: input.size,
      orderType: input.orderType,
      metadata: {
        tickSize: input.tickSize ?? null,
        minOrderSize: input.minOrderSize ?? null,
        negRisk: input.negRisk ?? null,
      },
      executionStyle:
        input.orderType === 'FOK' || input.orderType === 'FAK' ? 'cross' : 'rest',
      expiration: input.expiration ?? null,
      postOnly: false,
      normalizePriceToTick: false,
    });
    if (!venueValidation.valid) {
      throw new Error(
        venueValidation.reasonCode ?? 'Venue order validation failed before submit.',
      );
    }
  }

  private extractArrayResponse(response: unknown): unknown[] | null {
    if (Array.isArray(response)) {
      return response;
    }

    if (response && typeof response === 'object') {
      const record = response as Record<string, unknown>;
      if (Array.isArray(record.data)) {
        return record.data;
      }
    }

    return null;
  }

  private resolveExecutionFlags(
    orderType: VenueOrderType,
  ): { deferExec?: boolean; postOnly?: boolean } {
    switch (orderType) {
      case 'GTC':
        return {
          deferExec: true,
          postOnly: false,
        };
      case 'GTD':
        return {
          deferExec: true,
          postOnly: false,
        };
      case 'FOK':
        return {
          deferExec: false,
          postOnly: false,
        };
      case 'FAK':
        return {
          deferExec: false,
          postOnly: false,
        };
      default: {
        const exhaustiveCheck: never = orderType;
        throw new Error(`Unhandled order type: ${String(exhaustiveCheck)}`);
      }
    }
  }

  private isOnTick(price: number, tickSize: number): boolean {
    const scaled = price / tickSize;
    return Math.abs(scaled - Math.round(scaled)) <= 1e-9;
  }

  private async getClient(): Promise<OfficialClobClientInstance> {
    if (!this.clientPromise) {
      this.clientPromise = this.buildClient();
    }
    return this.clientPromise;
  }

  private async buildClient(): Promise<OfficialClobClientInstance> {
    this.validateConfig();
    const { clob, ethers } = await this.getModules();
    const wallet = this.serverSigner.createWallet(ethers.Wallet);

    return new clob.ClobClient(
      this.config.host,
      this.config.chainId,
      wallet,
      {
        key: this.config.apiKey,
        secret: this.config.apiSecret,
        passphrase: this.config.apiPassphrase,
      },
      this.config.signatureType,
      this.config.funder ?? undefined,
      this.config.geoBlockToken ?? undefined,
      this.config.useServerTime ?? true,
      undefined,
      undefined,
      this.config.retryOnError ?? true,
      undefined,
      true,
    );
  }

  private async getModules(): Promise<{
    clob: OfficialClobModule;
    ethers: EthersModule;
  }> {
    if (!this.modulePromise) {
      this.modulePromise = Promise.all([
        importPolymarketClobModule(),
        importEthersModule(),
      ]).then(([clob, ethers]) => ({ clob, ethers }));
    }

    return this.modulePromise;
  }

  private toUnixSeconds(value: string): number {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) {
      throw new Error(`Invalid expiration timestamp: ${value}`);
    }

    return Math.floor(timestamp / 1000);
  }

  private toSdkTickSize(
    tickSize: number | null | undefined,
  ): '0.1' | '0.01' | '0.001' | '0.0001' {
    const normalized = Number(tickSize);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new Error('tick_size_missing');
    }

    const asString = normalized.toString();
    if (
      asString === '0.1' ||
      asString === '0.01' ||
      asString === '0.001' ||
      asString === '0.0001'
    ) {
      return asString;
    }

    throw new Error(`Unsupported Polymarket tickSize for SDK signing: ${asString}`);
  }

  private readFiniteNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private readRequiredNumber(value: unknown, label: string): number {
    const parsed = this.readFiniteNumber(value);
    if (parsed === null) {
      throw new Error(`OfficialPolymarketTradingClient expected numeric ${label}.`);
    }
    return parsed;
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private readTimestamp(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = value >= 1_000_000_000_000 ? value : value * 1000;
      return new Date(ms).toISOString();
    }

    return null;
  }

  private normalizeAddress(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed : null;
  }

  private normalizeBalanceAllowanceAmount(
    value: number,
    assetType: BalanceAllowanceAssetType,
  ): number {
    if (!Number.isFinite(value) || assetType !== 'CONDITIONAL') {
      return value;
    }

    return value / CONDITIONAL_TOKEN_UNIT_SCALE;
  }

  private validateConfig(): void {
    if (!this.config.host || this.config.host.trim().length === 0) {
      throw new Error('OfficialPolymarketTradingClient requires host.');
    }

    if (!Number.isInteger(this.config.chainId) || this.config.chainId <= 0) {
      throw new Error('OfficialPolymarketTradingClient requires a positive chainId.');
    }

    const signerHealth = this.serverSigner.getHealth();
    if (!signerHealth.checks.privateKey) {
      this.serverSigner.getNormalizedPrivateKey();
    }

    if (!this.config.apiKey || this.config.apiKey.trim().length === 0) {
      throw new Error('OfficialPolymarketTradingClient requires apiKey.');
    }

    if (!this.config.apiSecret || this.config.apiSecret.trim().length === 0) {
      throw new Error('OfficialPolymarketTradingClient requires apiSecret.');
    }

    if (!this.config.apiPassphrase || this.config.apiPassphrase.trim().length === 0) {
      throw new Error('OfficialPolymarketTradingClient requires apiPassphrase.');
    }
  }

  private async executeVenueOperation<T>(
    scope: PolymarketVenueRequestScope,
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.venueAwareness.execute(scope, operation, action);
  }

  private async getProfileAddress(): Promise<string> {
    if (!this.profileAddressPromise) {
      this.profileAddressPromise = this.resolveProfileAddress();
    }

    return this.profileAddressPromise;
  }

  private async resolveProfileAddress(): Promise<string> {
    const explicit =
      this.normalizeAddress(this.config.profileAddress) ??
      this.normalizeAddress(this.config.funder);
    if (explicit) {
      return explicit;
    }

    const { ethers } = await this.getModules();
    return this.serverSigner.getAddress(ethers.Wallet as new (privateKey: string) => Record<string, unknown>);
  }

  private async getDataApiPositions(
    pathname: '/positions' | '/closed-positions',
    operation: string,
    limit: number,
  ): Promise<DataApiPositionRecord[]> {
    const profileAddress = await this.getProfileAddress();
    const recordsPayload = await this.fetchPaginatedDataApiArray(pathname, {
      operation,
      scope: 'private',
      params: {
        user: profileAddress,
        sizeThreshold: 0,
      },
      pageSize: Math.min(Math.max(Math.trunc(limit), 1), 500),
      maxPages: 4,
    });

    return parseDataApiPositionsPayload(recordsPayload, operation);
  }

  private async fetchPaginatedDataApiArray(
    pathname: string,
    input: {
      operation: string;
      scope: PolymarketVenueRequestScope;
      params: Record<string, string | number | boolean>;
      pageSize: number;
      maxPages: number;
    },
  ): Promise<unknown[]> {
    const all: unknown[] = [];
    let offset = 0;

    for (let page = 0; page < input.maxPages; page += 1) {
      const payload = await this.requestDataApi(pathname, {
        scope: input.scope,
        operation: input.operation,
        params: {
          ...input.params,
          limit: input.pageSize,
          offset,
        },
      });

      if (!Array.isArray(payload)) {
        throw new Error(`Expected array response from ${pathname}.`);
      }

      all.push(...payload);
      if (payload.length < input.pageSize) {
        break;
      }
      offset += input.pageSize;
    }

    return all;
  }

  private async requestDataApi(
    pathname: string,
    input: {
      scope: PolymarketVenueRequestScope;
      operation: string;
      params: Record<string, string | number | boolean>;
    },
  ): Promise<unknown> {
    return this.executeVenueOperation(input.scope, input.operation, async () => {
      const url = new URL(
        pathname,
        this.config.dataApiHost?.trim().length
          ? this.config.dataApiHost
          : 'https://data-api.polymarket.com',
      );
      for (const [key, value] of Object.entries(input.params)) {
        url.searchParams.set(key, String(value));
      }

      const response = await (this.config.fetchImpl ?? fetch)(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
      });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const payloadRecord =
          payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>)
            : null;
        throw {
          status: response.status,
          message:
            (typeof payloadRecord?.error === 'string' && payloadRecord.error) ||
            (typeof payloadRecord?.message === 'string' && payloadRecord.message) ||
            `Data API request failed with status ${response.status}.`,
          payload,
        };
      }

      return payload;
    });
  }
}
