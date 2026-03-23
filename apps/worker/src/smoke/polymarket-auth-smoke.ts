import { z } from 'zod';
import { redactSecrets } from '@worker/config/secret-provider';
import {
  OfficialPolymarketTradingClient,
  VenueOrderType,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';

const smokeEnvSchema = z.object({
  POLY_CLOB_HOST: z.string().min(1, 'POLY_CLOB_HOST is required'),
  POLY_CHAIN_ID: z.coerce.number().int().positive().default(137),
  POLY_PRIVATE_KEY: z.string().min(1, 'POLY_PRIVATE_KEY is required'),
  POLY_API_KEY: z.string().min(1, 'POLY_API_KEY is required'),
  POLY_API_SECRET: z.string().min(1, 'POLY_API_SECRET is required'),
  POLY_API_PASSPHRASE: z.string().min(1, 'POLY_API_PASSPHRASE is required'),
  POLY_FUNDER: z.string().optional(),
  POLY_GEO_BLOCK_TOKEN: z.string().optional(),
  POLY_SIGNATURE_TYPE: z.coerce.number().int().nonnegative().default(0),
  POLY_SMOKE_TOKEN_ID: z.string().min(1, 'POLY_SMOKE_TOKEN_ID is required'),
  POLY_SMOKE_PRICE: z.coerce.number().positive('POLY_SMOKE_PRICE must be positive'),
  POLY_SMOKE_SIZE: z.coerce.number().positive('POLY_SMOKE_SIZE must be positive'),
  POLY_SMOKE_EXECUTE: z.string().refine((value) => value === 'true', {
    message:
      'POLY_SMOKE_EXECUTE=true is required. The smoke harness fails closed without the explicit execute guard.',
  }),
  POLY_SMOKE_ORDER_TYPE: z.enum(['GTC', 'GTD', 'FOK', 'FAK']).default('GTC'),
  POLY_SMOKE_EXPIRATION_SECONDS: z.coerce.number().int().positive().default(75),
  POLY_SMOKE_MAX_WAIT_MS: z.coerce.number().int().positive().default(10000),
  POLY_SMOKE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
});

export type PolymarketSmokeEnv = z.infer<typeof smokeEnvSchema>;

export type PolymarketSmokeStepName =
  | 'get_order_book'
  | 'get_balance_allowance'
  | 'get_open_orders'
  | 'get_trades'
  | 'submit'
  | 'open_order_visibility'
  | 'heartbeat'
  | 'cancel'
  | 'post_cancel_absence';

export interface PolymarketSmokeStepResult {
  step: PolymarketSmokeStepName;
  ok: boolean;
  checkedAt: string;
  reasonCode: string;
  evidence: Record<string, unknown>;
}

export interface PolymarketSmokeResult {
  success: boolean;
  executedAt: string;
  freshnessTtlMs: number;
  orderId: string | null;
  steps: PolymarketSmokeStepResult[];
}

export function parsePolymarketSmokeEnv(
  env: NodeJS.ProcessEnv,
): PolymarketSmokeEnv {
  const parsed = smokeEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid Polymarket smoke configuration: ${issues}`);
  }

  return parsed.data;
}

async function waitForCondition(
  fn: () => Promise<boolean>,
  maxWaitMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  do {
    if (await fn()) {
      return true;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (true);

  return false;
}

function failStep(
  step: PolymarketSmokeStepName,
  reasonCode: string,
  evidence?: Record<string, unknown>,
): PolymarketSmokeStepResult {
  return {
    step,
    ok: false,
    checkedAt: new Date().toISOString(),
    reasonCode,
    evidence: redactSecrets(evidence ?? {}),
  };
}

function passStep(
  step: PolymarketSmokeStepName,
  reasonCode: string,
  evidence?: Record<string, unknown>,
): PolymarketSmokeStepResult {
  return {
    step,
    ok: true,
    checkedAt: new Date().toISOString(),
    reasonCode,
    evidence: redactSecrets(evidence ?? {}),
  };
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify(redactSecrets({ message }));
}

export async function runPolymarketAuthenticatedSmoke(
  env: NodeJS.ProcessEnv = process.env,
  clientOverride?: OfficialPolymarketTradingClient,
): Promise<PolymarketSmokeResult> {
  const config = parsePolymarketSmokeEnv(env);
  const client =
    clientOverride ??
    new OfficialPolymarketTradingClient({
      host: config.POLY_CLOB_HOST,
      chainId: config.POLY_CHAIN_ID,
      privateKey: config.POLY_PRIVATE_KEY,
      apiKey: config.POLY_API_KEY,
      apiSecret: config.POLY_API_SECRET,
      apiPassphrase: config.POLY_API_PASSPHRASE,
      signatureType: config.POLY_SIGNATURE_TYPE,
      funder: config.POLY_FUNDER ?? null,
      geoBlockToken: config.POLY_GEO_BLOCK_TOKEN ?? null,
    });

  const executedAt = new Date().toISOString();
  const steps: PolymarketSmokeStepResult[] = [];
  let smokeOrderId: string | null = null;

  try {
    const preflight = await client.preflightVenue();
    if (!preflight.ready) {
      throw new Error(
        `Smoke harness blocked by venue preflight: ${preflight.reasonCode ?? 'unknown'}.`,
      );
    }

    const orderBook = await client.getOrderBook(config.POLY_SMOKE_TOKEN_ID);
    if (orderBook.tickSize == null || orderBook.minOrderSize == null || orderBook.negRisk == null) {
      throw new Error('orderbook_metadata_incomplete');
    }
    steps.push(
      passStep('get_order_book', 'passed', {
        tokenId: config.POLY_SMOKE_TOKEN_ID,
        tickSize: orderBook.tickSize,
        minOrderSize: orderBook.minOrderSize,
        negRisk: orderBook.negRisk,
      }),
    );

    const collateral = await client.getBalanceAllowance({
      assetType: 'COLLATERAL',
    });
    steps.push(
      passStep('get_balance_allowance', 'passed', {
        balance: collateral.balance,
        allowance: collateral.allowance,
      }),
    );

    const openOrdersBefore = await client.getOpenOrders();
    steps.push(
      passStep('get_open_orders', 'passed', {
        openOrders: openOrdersBefore.length,
      }),
    );

    const tradesBefore = await client.getTrades();
    steps.push(
      passStep('get_trades', 'passed', {
        trades: tradesBefore.length,
      }),
    );

    const expiration =
      config.POLY_SMOKE_ORDER_TYPE === 'GTD'
        ? new Date(Date.now() + config.POLY_SMOKE_EXPIRATION_SECONDS * 1000).toISOString()
        : null;
    if (
      config.POLY_SMOKE_ORDER_TYPE === 'GTD' &&
      config.POLY_SMOKE_EXPIRATION_SECONDS < 60
    ) {
      throw new Error(
        'Smoke harness blocked: POLY_SMOKE_EXPIRATION_SECONDS must be at least 60 for GTD orders.',
      );
    }

    const submit = await client.postOrder({
      tokenId: config.POLY_SMOKE_TOKEN_ID,
      side: 'BUY',
      price: config.POLY_SMOKE_PRICE,
      size: config.POLY_SMOKE_SIZE,
      orderType: config.POLY_SMOKE_ORDER_TYPE as VenueOrderType,
      tickSize: orderBook.tickSize,
      minOrderSize: orderBook.minOrderSize,
      negRisk: orderBook.negRisk,
      expiration,
      clientOrderId: `smoke:${Date.now()}`,
    });

    if (!submit.success || !submit.orderId) {
      throw new Error(`smoke_submit_failed:${submit.status}`);
    }
    smokeOrderId = submit.orderId;
    steps.push(
      passStep('submit', 'passed', {
        orderId: smokeOrderId,
        status: submit.status,
      }),
    );

    const visible = await waitForCondition(async () => {
      const openOrders = await client.getOpenOrders();
      return openOrders.some((order) => order.id === smokeOrderId);
    }, config.POLY_SMOKE_MAX_WAIT_MS, config.POLY_SMOKE_POLL_INTERVAL_MS);
    if (!visible) {
      throw new Error(`smoke_order_not_visible:${smokeOrderId}`);
    }
    steps.push(
      passStep('open_order_visibility', 'passed', {
        orderId: smokeOrderId,
      }),
    );

    const heartbeat = await client.postHeartbeat();
    if (!heartbeat.success) {
      throw new Error(`smoke_heartbeat_failed:${heartbeat.error ?? 'unknown'}`);
    }
    steps.push(
      passStep('heartbeat', 'passed', {
        heartbeatId: heartbeat.heartbeatId,
      }),
    );

    const cancel = await client.cancelOrder(smokeOrderId);
    if (!cancel.success) {
      throw new Error(`smoke_cancel_failed:${smokeOrderId}`);
    }
    steps.push(
      passStep('cancel', 'passed', {
        orderId: smokeOrderId,
      }),
    );

    const absent = await waitForCondition(async () => {
      const openOrders = await client.getOpenOrders();
      return !openOrders.some((order) => order.id === smokeOrderId);
    }, config.POLY_SMOKE_MAX_WAIT_MS, config.POLY_SMOKE_POLL_INTERVAL_MS);
    if (!absent) {
      throw new Error(`smoke_post_cancel_presence:${smokeOrderId}`);
    }
    steps.push(
      passStep('post_cancel_absence', 'passed', {
        orderId: smokeOrderId,
      }),
    );

    return {
      success: true,
      executedAt,
      freshnessTtlMs: config.POLY_SMOKE_MAX_WAIT_MS,
      orderId: smokeOrderId,
      steps,
    };
  } catch (error) {
    const remainingSteps: PolymarketSmokeStepName[] = [
      'get_order_book',
      'get_balance_allowance',
      'get_open_orders',
      'get_trades',
      'submit',
      'open_order_visibility',
      'heartbeat',
      'cancel',
      'post_cancel_absence',
    ];
    const completed = new Set(steps.map((step) => step.step));
    const failedStep =
      remainingSteps.find((step) => !completed.has(step)) ?? 'post_cancel_absence';
    steps.push(
      failStep(failedStep, 'failed', {
        error: sanitizeError(error),
        orderId: smokeOrderId,
      }),
    );

    return {
      success: false,
      executedAt,
      freshnessTtlMs: config.POLY_SMOKE_MAX_WAIT_MS,
      orderId: smokeOrderId,
      steps,
    };
  }
}

if (require.main === module) {
  runPolymarketAuthenticatedSmoke()
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(redactSecrets(result), null, 2));
      if (!result.success) {
        process.exit(1);
      }
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(sanitizeError(error));
      process.exit(1);
    });
}
