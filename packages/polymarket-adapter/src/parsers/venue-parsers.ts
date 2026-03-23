export interface VenueParserIssue {
  code: string;
  message: string;
  path: string;
}

export class VenueParseError extends Error {
  readonly name = 'VenueParseError';

  constructor(
    readonly operation: string,
    readonly issues: VenueParserIssue[],
    readonly payload: unknown,
  ) {
    super(
      `${operation}:${issues.map((issue) => `${issue.path}:${issue.code}`).join('|')}`,
    );
  }
}

export interface ParsedGammaMarketToken {
  tokenId: string;
  outcome: string | null;
}

export interface ParsedGammaMarket {
  id: string;
  slug: string;
  question: string;
  active: boolean;
  closed: boolean;
  tradable: boolean;
  enableOrderBook: boolean;
  negativeRisk: boolean | null;
  endDate: string | null;
  conditionId: string | null;
  tokenIdYes: string;
  tokenIdNo: string;
  tokens: ParsedGammaMarketToken[];
  clobTokenIds: string[];
  raw: Record<string, unknown>;
}

export interface ParsedGammaMarketsResponse {
  markets: ParsedGammaMarket[];
  failures: VenueParserIssue[];
}

export interface ParsedOrderbookLevel {
  price: number;
  size: number;
}

export interface ParsedOrderbook {
  tokenId: string;
  bidLevels: ParsedOrderbookLevel[];
  askLevels: ParsedOrderbookLevel[];
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
  raw: Record<string, unknown>;
}

export interface ParsedVenueOpenOrder {
  id: string;
  status: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  matchedSize: number;
  tokenId: string;
  createdAt: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedVenueTrade {
  id: string;
  orderId: string | null;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  fee: number | null;
  filledAt: string | null;
  status: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedBalanceAllowance {
  balance: number;
  allowance: number;
  raw: Record<string, unknown>;
}

export interface ParsedRewardToken {
  tokenId: string;
  outcome: string | null;
  price: number | null;
}

export interface ParsedRewardMarket {
  conditionId: string;
  rewardsMaxSpread: number | null;
  rewardsMinSize: number | null;
  marketSlug: string | null;
  question: string | null;
  tokens: ParsedRewardToken[];
  raw: Record<string, unknown>;
}

export interface ParsedDataApiTrade {
  id: string;
  tokenId: string;
  marketId: string | null;
  conditionId: string | null;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  outcome: string | null;
  timestamp: string | null;
  transactionHash: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedDataApiPosition {
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
  raw: Record<string, unknown>;
}

const LIVE_ORDER_STATUS_ALIASES: Record<string, string> = {
  live: 'submitted',
  open: 'submitted',
  pending: 'submitted',
  unmatched: 'submitted',
  posted: 'submitted',
  placed: 'submitted',
  active: 'acknowledged',
  acknowledged: 'acknowledged',
  matched: 'partially_filled',
  partially_filled: 'partially_filled',
  partial_filled: 'partially_filled',
  partiallymatched: 'partially_filled',
  filled: 'filled',
  complete: 'filled',
  completed: 'filled',
  canceled: 'canceled',
  cancelled: 'canceled',
  expired: 'canceled',
  rejected: 'rejected',
};

const TRADE_STATUS_ALIASES: Record<string, string> = {
  matched: 'MATCHED',
  filled: 'FILLED',
  settled: 'SETTLED',
};

function issue(code: string, path: string, message: string): VenueParserIssue {
  return { code, path, message };
}

function readRecord(
  value: unknown,
  operation: string,
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VenueParseError(operation, [issue('record_expected', path, 'Expected object.')], value);
  }
  return value as Record<string, unknown>;
}

function readString(
  value: unknown,
  operation: string,
  path: string,
  options: { nullable?: boolean } = {},
): string | null {
  if (value == null && options.nullable) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new VenueParseError(
      operation,
      [issue('string_expected', path, 'Expected non-empty string.')],
      value,
    );
  }
  return value.trim();
}

function readFiniteNumber(
  value: unknown,
  operation: string,
  path: string,
  options: { min?: number; max?: number; nullable?: boolean } = {},
): number | null {
  if (value == null && options.nullable) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new VenueParseError(
      operation,
      [issue('number_expected', path, 'Expected finite number.')],
      value,
    );
  }
  if (options.min != null && parsed < options.min) {
    throw new VenueParseError(
      operation,
      [issue('number_below_min', path, `Expected number >= ${options.min}.`)],
      value,
    );
  }
  if (options.max != null && parsed > options.max) {
    throw new VenueParseError(
      operation,
      [issue('number_above_max', path, `Expected number <= ${options.max}.`)],
      value,
    );
  }
  return parsed;
}

function readBoolean(
  value: unknown,
  operation: string,
  path: string,
  options: { nullable?: boolean } = {},
): boolean | null {
  if (value == null && options.nullable) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'n'].includes(normalized)) {
      return false;
    }
  }
  throw new VenueParseError(
    operation,
    [issue('boolean_expected', path, 'Expected boolean-like value.')],
    value,
  );
}

function readTimestamp(
  value: unknown,
  operation: string,
  path: string,
  options: { nullable?: boolean } = {},
): string | null {
  if (value == null && options.nullable) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value >= 1_000_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new VenueParseError(
        operation,
        [issue('timestamp_invalid', path, 'Expected valid timestamp.')],
        value,
      );
    }
    return parsed.toISOString();
  }
  throw new VenueParseError(
    operation,
    [issue('timestamp_expected', path, 'Expected timestamp.')],
    value,
  );
}

function readArray(value: unknown, operation: string, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new VenueParseError(operation, [issue('array_expected', path, 'Expected array.')], value);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readOptionalBoolean(record: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (value == null) {
      continue;
    }
    try {
      return readBoolean(value, 'optional_boolean', key, { nullable: true });
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeSide(value: unknown, operation: string, path: string): 'BUY' | 'SELL' {
  const normalized = readString(value, operation, path)!.toUpperCase();
  if (normalized === 'BUY' || normalized === 'BID') {
    return 'BUY';
  }
  if (normalized === 'SELL' || normalized === 'ASK') {
    return 'SELL';
  }
  throw new VenueParseError(operation, [issue('side_invalid', path, 'Unknown venue side.')], value);
}

function normalizeOrderStatus(value: unknown, operation: string, path: string): string {
  const raw = readString(value, operation, path)!.toLowerCase().replace(/[\s-]+/g, '_');
  const normalized = LIVE_ORDER_STATUS_ALIASES[raw] ?? LIVE_ORDER_STATUS_ALIASES[raw.replace(/_/g, '')];
  if (!normalized) {
    throw new VenueParseError(
      operation,
      [issue('order_status_invalid', path, 'Unknown order status.')],
      value,
    );
  }
  return normalized;
}

function normalizeTradeStatus(value: unknown, operation: string, path: string): string | null {
  if (value == null) {
    return null;
  }
  const raw = readString(value, operation, path)!.toLowerCase().replace(/[\s-]+/g, '_');
  const normalized = TRADE_STATUS_ALIASES[raw] ?? TRADE_STATUS_ALIASES[raw.replace(/_/g, '')];
  if (!normalized) {
    throw new VenueParseError(
      operation,
      [issue('trade_status_invalid', path, 'Unknown trade status.')],
      value,
    );
  }
  return normalized;
}

function collectGammaTokenIds(record: Record<string, unknown>, operation: string, path: string) {
  const tokens = Array.isArray(record.tokens) ? record.tokens : [];
  const parsedTokens: ParsedGammaMarketToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const tokenRecord = readRecord(tokens[index], operation, `${path}.tokens[${index}]`);
    const tokenId =
      readOptionalString(tokenRecord, ['token_id', 'tokenId', 'id']) ??
      (() => {
        throw new VenueParseError(
          operation,
          [issue('token_id_missing', `${path}.tokens[${index}]`, 'Missing token id.')],
          tokenRecord,
        );
      })();
    parsedTokens.push({
      tokenId,
      outcome: readOptionalString(tokenRecord, ['outcome', 'name', 'label']),
    });
  }

  const clobTokenIdsRaw = record.clobTokenIds ?? record.clob_token_ids;
  const clobTokenIds = Array.isArray(clobTokenIdsRaw)
    ? clobTokenIdsRaw.map((value, index) =>
        readString(value, operation, `${path}.clobTokenIds[${index}]`)!,
      )
    : [];

  const tokenIdYes =
    parsedTokens.find((token) => token.outcome?.toLowerCase().includes('yes'))?.tokenId ??
    clobTokenIds[0] ??
    null;
  const tokenIdNo =
    parsedTokens.find((token) => token.outcome?.toLowerCase().includes('no'))?.tokenId ??
    clobTokenIds[1] ??
    null;

  if (!tokenIdYes || !tokenIdNo || tokenIdYes === tokenIdNo) {
    throw new VenueParseError(
      operation,
      [issue('outcome_token_mapping_invalid', path, 'Missing or contradictory YES/NO token mapping.')],
      record,
    );
  }

  return {
    tokens: parsedTokens,
    clobTokenIds,
    tokenIdYes,
    tokenIdNo,
  };
}

export function parseGammaMarket(value: unknown, operation = 'gamma_market'): ParsedGammaMarket {
  const record = readRecord(value, operation, '$');
  const id = readString(record.id, operation, '$.id')!;
  const slug = readOptionalString(record, ['slug']) ?? id;
  const question = readOptionalString(record, ['question', 'title', 'name']) ?? slug;
  const active = readOptionalBoolean(record, ['active']) ?? true;
  const closed = readOptionalBoolean(record, ['closed']) ?? false;
  const enableOrderBook =
    readOptionalBoolean(record, ['enableOrderBook', 'enable_order_book', 'orderBookEnabled']) ??
    true;
  const tradable = !(
    readOptionalBoolean(record, [
      'tradable',
      'isTradable',
      'acceptingOrders',
      'accepting_orders',
      'trading',
      'canTrade',
      'suspended',
      'isSuspended',
      'archived',
      'isArchived',
    ]) === false
  );
  const negativeRisk = readOptionalBoolean(record, ['negRisk', 'negativeRisk']);
  const endDate = readOptionalString(record, [
    'endDate',
    'end_date_iso',
    'endDateIso',
    'end_date',
  ]);
  const conditionId = readOptionalString(record, ['conditionId', 'condition_id', 'condition']);
  const parsedEndDate =
    endDate === null ? null : readTimestamp(endDate, operation, '$.endDate', { nullable: true });
  const tokenMapping = collectGammaTokenIds(record, operation, '$');

  if (closed && active) {
    throw new VenueParseError(
      operation,
      [issue('market_state_contradiction', '$', 'Market cannot be both active and closed.')],
      value,
    );
  }

  return {
    id,
    slug,
    question,
    active,
    closed,
    tradable,
    enableOrderBook,
    negativeRisk,
    endDate: parsedEndDate,
    conditionId,
    tokenIdYes: tokenMapping.tokenIdYes,
    tokenIdNo: tokenMapping.tokenIdNo,
    tokens: tokenMapping.tokens,
    clobTokenIds: tokenMapping.clobTokenIds,
    raw: record,
  };
}

export function parseGammaMarketsPayload(
  payload: unknown,
  operation = 'gamma_list_markets',
): ParsedGammaMarketsResponse {
  const items = readArray(payload, operation, '$');
  const markets: ParsedGammaMarket[] = [];
  const failures: VenueParserIssue[] = [];

  for (let index = 0; index < items.length; index += 1) {
    try {
      markets.push(parseGammaMarket(items[index], `${operation}[${index}]`));
    } catch (error) {
      if (error instanceof VenueParseError) {
        failures.push(
          ...error.issues.map((entry) => ({
            ...entry,
            path: `$[${index}]${entry.path === '$' ? '' : entry.path.replace(/^\$/, '')}`,
          })),
        );
        continue;
      }
      throw error;
    }
  }

  return { markets, failures };
}

function parseOrderbookLevels(
  value: unknown,
  operation: string,
  path: string,
): ParsedOrderbookLevel[] {
  const entries = readArray(value, operation, path);
  return entries.map((entry, index) => {
    if (Array.isArray(entry)) {
      if (entry.length < 2) {
        throw new VenueParseError(
          operation,
          [issue('level_tuple_invalid', `${path}[${index}]`, 'Orderbook level tuple too short.')],
          entry,
        );
      }
      return {
        price: readFiniteNumber(entry[0], operation, `${path}[${index}][0]`, {
          min: 0,
          max: 1,
        })!,
        size: readFiniteNumber(entry[1], operation, `${path}[${index}][1]`, {
          min: 0,
        })!,
      };
    }

    const record = readRecord(entry, operation, `${path}[${index}]`);
    return {
      price: readFiniteNumber(record.price ?? record.p, operation, `${path}[${index}].price`, {
        min: 0,
        max: 1,
      })!,
      size: readFiniteNumber(record.size ?? record.s, operation, `${path}[${index}].size`, {
        min: 0,
      })!,
    };
  });
}

export function parseOrderbookPayload(
  tokenId: string,
  payload: unknown,
  operation = 'clob_orderbook',
): ParsedOrderbook {
  const record = readRecord(payload, operation, '$');
  const bidLevels = parseOrderbookLevels(record.bids, operation, '$.bids');
  const askLevels = parseOrderbookLevels(record.asks, operation, '$.asks');
  if (bidLevels.length === 0 && askLevels.length === 0) {
    throw new VenueParseError(
      operation,
      [issue('orderbook_empty', '$', 'Orderbook had no bid or ask levels.')],
      payload,
    );
  }

  return {
    tokenId: readString(tokenId, operation, '$.tokenId')!,
    bidLevels,
    askLevels,
    tickSize: readFiniteNumber(record.tick_size ?? record.tickSize, operation, '$.tick_size', {
      min: 0,
    })!,
    minOrderSize: readFiniteNumber(
      record.min_order_size ?? record.minOrderSize,
      operation,
      '$.min_order_size',
      { min: 0 },
    )!,
    negRisk: readBoolean(record.neg_risk ?? record.negRisk, operation, '$.neg_risk')!,
    raw: record,
  };
}

function extractArrayPayload(payload: unknown, operation: string): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = readRecord(payload, operation, '$');
  if (!Array.isArray(record.data)) {
    throw new VenueParseError(
      operation,
      [issue('array_expected', '$.data', 'Expected top-level array or data array.')],
      payload,
    );
  }
  return record.data;
}

export function parseOpenOrdersPayload(
  payload: unknown,
  operation = 'clob_open_orders',
): ParsedVenueOpenOrder[] {
  const items = extractArrayPayload(payload, operation);
  return items.map((entry, index) => {
    const record = readRecord(entry, operation, `$[${index}]`);
    return {
      id: readString(record.id, operation, `$[${index}].id`)!,
      status: normalizeOrderStatus(record.status, operation, `$[${index}].status`),
      side: normalizeSide(record.side, operation, `$[${index}].side`),
      price: readFiniteNumber(record.price, operation, `$[${index}].price`, { min: 0, max: 1 })!,
      size: readFiniteNumber(
        record.original_size ?? record.size,
        operation,
        `$[${index}].size`,
        { min: 0 },
      )!,
      matchedSize: readFiniteNumber(
        record.size_matched ?? record.matchedSize ?? 0,
        operation,
        `$[${index}].matchedSize`,
        { min: 0 },
      )!,
      tokenId: readString(record.asset_id ?? record.tokenId, operation, `$[${index}].tokenId`)!,
      createdAt: readTimestamp(
        record.created_at ?? record.createdAt ?? null,
        operation,
        `$[${index}].createdAt`,
        { nullable: true },
      ),
      raw: record,
    };
  });
}

export function parseTradesPayload(
  payload: unknown,
  operation = 'clob_trades',
): ParsedVenueTrade[] {
  const items = extractArrayPayload(payload, operation);
  return items.map((entry, index) => {
    const record = readRecord(entry, operation, `$[${index}]`);
    return {
      id: readString(record.id, operation, `$[${index}].id`)!,
      orderId:
        readOptionalString(record, ['taker_order_id', 'orderId', 'order_id']) ??
        readOptionalString(record, ['maker_order_id']),
      tokenId: readString(record.asset_id ?? record.tokenId, operation, `$[${index}].tokenId`)!,
      side: normalizeSide(record.side, operation, `$[${index}].side`),
      price: readFiniteNumber(record.price, operation, `$[${index}].price`, {
        min: 0,
        max: 1,
      })!,
      size: readFiniteNumber(record.size, operation, `$[${index}].size`, { min: 0 })!,
      fee: readFiniteNumber(
        record.fee ?? record.fees ?? record.fee_amount ?? record.feeAmount ?? null,
        operation,
        `$[${index}].fee`,
        { min: 0, nullable: true },
      ),
      filledAt: readTimestamp(
        record.match_time ?? record.filledAt ?? null,
        operation,
        `$[${index}].filledAt`,
        { nullable: true },
      ),
      status: normalizeTradeStatus(record.status ?? null, operation, `$[${index}].status`),
      raw: record,
    };
  });
}

export function parseBalanceAllowancePayload(
  payload: unknown,
  operation = 'clob_balance_allowance',
): ParsedBalanceAllowance {
  const record = readRecord(payload, operation, '$');
  return {
    balance: readFiniteNumber(record.balance, operation, '$.balance', { min: 0 })!,
    allowance: readFiniteNumber(record.allowance, operation, '$.allowance', { min: 0 })!,
    raw: record,
  };
}

export function parseRewardsPayload(
  payload: unknown,
  operation = 'clob_rewards',
): ParsedRewardMarket[] {
  const items = extractArrayPayload(payload, operation);
  return items.map((entry, index) => {
    const record = readRecord(entry, operation, `$[${index}]`);
    const tokens = readArray(record.tokens, operation, `$[${index}].tokens`).map((token, tokenIndex) => {
      const tokenRecord = readRecord(token, operation, `$[${index}].tokens[${tokenIndex}]`);
      return {
        tokenId: readString(
          tokenRecord.token_id ?? tokenRecord.tokenId,
          operation,
          `$[${index}].tokens[${tokenIndex}].tokenId`,
        )!,
        outcome: readOptionalString(tokenRecord, ['outcome']),
        price: readFiniteNumber(tokenRecord.price ?? null, operation, `$[${index}].tokens[${tokenIndex}].price`, {
          min: 0,
          max: 1,
          nullable: true,
        }),
      };
    });

    return {
      conditionId: readString(
        record.condition_id ?? record.conditionId,
        operation,
        `$[${index}].conditionId`,
      )!,
      rewardsMaxSpread: readFiniteNumber(
        record.rewards_max_spread ?? null,
        operation,
        `$[${index}].rewardsMaxSpread`,
        { min: 0, nullable: true },
      ),
      rewardsMinSize: readFiniteNumber(
        record.rewards_min_size ?? null,
        operation,
        `$[${index}].rewardsMinSize`,
        { min: 0, nullable: true },
      ),
      marketSlug: readOptionalString(record, ['market_slug']),
      question: readOptionalString(record, ['question']),
      tokens,
      raw: record,
    };
  });
}

export function parseDataApiTradesPayload(
  payload: unknown,
  operation = 'data_api_trades',
): ParsedDataApiTrade[] {
  const items = extractArrayPayload(payload, operation);
  return items.map((entry, index) => {
    const record = readRecord(entry, operation, `$[${index}]`);
    return {
      id: readString(record.tradeID ?? record.id, operation, `$[${index}].id`)!,
      tokenId: readString(record.asset ?? record.tokenId, operation, `$[${index}].tokenId`)!,
      marketId: readOptionalString(record, ['marketId', 'market_id']),
      conditionId: readOptionalString(record, ['conditionId']),
      side: normalizeSide(record.side, operation, `$[${index}].side`),
      price: readFiniteNumber(record.price, operation, `$[${index}].price`, { min: 0, max: 1 })!,
      size: readFiniteNumber(record.size, operation, `$[${index}].size`, { min: 0 })!,
      outcome: readOptionalString(record, ['outcome']),
      timestamp: readTimestamp(record.timestamp ?? null, operation, `$[${index}].timestamp`, {
        nullable: true,
      }),
      transactionHash: readOptionalString(record, ['transactionHash']),
      raw: record,
    };
  });
}

export function parseDataApiPositionsPayload(
  payload: unknown,
  operation = 'data_api_positions',
): ParsedDataApiPosition[] {
  const items = extractArrayPayload(payload, operation);
  return items.map((entry, index) => {
    const record = readRecord(entry, operation, `$[${index}]`);
    return {
      tokenId: readString(record.asset ?? record.tokenId, operation, `$[${index}].tokenId`)!,
      marketId: readOptionalString(record, ['marketId', 'market_id']),
      conditionId: readOptionalString(record, ['conditionId']),
      size: readFiniteNumber(record.size, operation, `$[${index}].size`, { min: 0 })!,
      avgPrice: readFiniteNumber(record.avgPrice ?? null, operation, `$[${index}].avgPrice`, {
        min: 0,
        max: 1,
        nullable: true,
      }),
      initialValue: readFiniteNumber(
        record.initialValue ?? null,
        operation,
        `$[${index}].initialValue`,
        { min: 0, nullable: true },
      ),
      currentValue: readFiniteNumber(
        record.currentValue ?? null,
        operation,
        `$[${index}].currentValue`,
        { nullable: true },
      ),
      cashPnl: readFiniteNumber(record.cashPnl ?? null, operation, `$[${index}].cashPnl`, {
        nullable: true,
      }),
      realizedPnl: readFiniteNumber(
        record.realizedPnl ?? null,
        operation,
        `$[${index}].realizedPnl`,
        { nullable: true },
      ),
      currentPrice: readFiniteNumber(
        record.curPrice ?? record.price ?? null,
        operation,
        `$[${index}].currentPrice`,
        { min: 0, max: 1, nullable: true },
      ),
      outcome: readOptionalString(record, ['outcome']),
      oppositeTokenId: readOptionalString(record, ['oppositeAsset']),
      endDate: readTimestamp(record.endDate ?? null, operation, `$[${index}].endDate`, {
        nullable: true,
      }),
      negativeRisk:
        readOptionalBoolean(record, ['negativeRisk', 'negRisk']),
      raw: record,
    };
  });
}

export function isVenueParseError(error: unknown): error is VenueParseError {
  return error instanceof VenueParseError;
}
