export function buildGammaMarketFixture(
  input?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    id: 'm1',
    slug: 'btc-5m-higher',
    question: 'Will BTC be higher in 5 minutes?',
    active: true,
    closed: false,
    enableOrderBook: true,
    conditionId: 'cond-1',
    endDate: new Date(Date.now() + 300_000).toISOString(),
    tokens: [
      {
        token_id: 'yes1',
        outcome: 'Yes',
      },
      {
        token_id: 'no1',
        outcome: 'No',
      },
    ],
    clobTokenIds: ['yes1', 'no1'],
    ...input,
  };
}

export function buildOrderbookPayloadFixture(
  input?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    bids: [
      { price: '0.50', size: '100' },
      { price: '0.49', size: '80' },
    ],
    asks: [
      { price: '0.52', size: '120' },
      { price: '0.53', size: '90' },
    ],
    tick_size: '0.01',
    min_order_size: '1',
    neg_risk: false,
    ...input,
  };
}

export function buildOpenOrderPayloadFixture(
  input?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    id: 'venue-order-1',
    status: 'OPEN',
    side: 'BUY',
    price: '0.52',
    original_size: '19.23076923076923',
    size_matched: '0',
    asset_id: 'yes1',
    created_at: Date.now(),
    ...input,
  };
}

export function buildTradePayloadFixture(
  input?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    id: 'trade-1',
    taker_order_id: 'venue-order-1',
    asset_id: 'yes1',
    side: 'BUY',
    price: '0.52',
    size: '5',
    fee: '0.01',
    match_time: new Date().toISOString(),
    status: 'MATCHED',
    ...input,
  };
}

export function buildBalanceAllowancePayloadFixture(
  input?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    balance: '100',
    allowance: '100',
    ...input,
  };
}

export function buildRewardsPayloadFixture(
  input?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    data: [
      {
        condition_id: 'cond-1',
        rewards_max_spread: '0.03',
        rewards_min_size: '10',
        market_slug: 'btc-5m-higher',
        question: 'Will BTC be higher in 5 minutes?',
        tokens: [
          { token_id: 'yes1', outcome: 'Yes', price: '0.52' },
          { token_id: 'no1', outcome: 'No', price: '0.48' },
        ],
      },
    ],
    ...input,
  };
}
