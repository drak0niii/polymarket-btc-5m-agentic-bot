import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL_PLANNER: z.string().min(1).default('gpt-5'),
  OPENAI_MODEL_CRITIC: z.string().min(1).default('gpt-5'),
  OPENAI_MODEL_REVIEWER: z.string().min(1).default('gpt-5'),
  OPENAI_MODEL_ANOMALY: z.string().min(1).default('gpt-5'),

  POLY_CLOB_HOST: z.string().min(1, 'POLY_CLOB_HOST is required'),
  POLY_GAMMA_HOST: z.string().min(1, 'POLY_GAMMA_HOST is required'),
  POLY_CHAIN_ID: z.coerce.number().int().positive().default(137),
  POLY_PRIVATE_KEY: z.string().optional(),
  POLY_API_KEY: z.string().optional(),
  POLY_API_SECRET: z.string().optional(),
  POLY_API_PASSPHRASE: z.string().optional(),
  POLY_SIGNATURE_TYPE: z.coerce.number().int().nonnegative().default(0),
  POLY_FUNDER: z.string().optional(),

  BTC_REFERENCE_SYMBOL: z.string().min(1).default('BTCUSD'),
  BOT_DEFAULT_STATUS: z
    .enum([
      'bootstrapping',
      'running',
      'degraded',
      'reconciliation_only',
      'cancel_only',
      'halted_hard',
      'stopped',
    ])
    .default('stopped'),
  BOT_EVALUATION_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  BOT_ORDER_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  BOT_PORTFOLIO_REFRESH_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  BOT_LIVE_EXECUTION_ENABLED: z.coerce.boolean().default(true),
  BOT_DEPLOYMENT_TIER: z
    .enum(['research', 'paper', 'canary', 'cautious_live', 'scaled_live'])
    .default('paper'),

  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(1),
  MAX_DAILY_LOSS_PCT: z.coerce.number().positive().default(5),
  MAX_PER_TRADE_RISK_PCT: z.coerce.number().positive().default(1),
  MAX_KELLY_FRACTION: z.coerce.number().positive().default(0.05),
  MAX_CONSECUTIVE_LOSSES: z.coerce.number().int().positive().default(2),
  NO_TRADE_WINDOW_SECONDS: z.coerce.number().int().nonnegative().default(30),

  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
  OTEL_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
    .join('; ');

  throw new Error(`Invalid environment configuration: ${issues}`);
}

export const appEnv = {
  ...parsed.data,
  IS_DEVELOPMENT: parsed.data.NODE_ENV === 'development',
  IS_TEST: parsed.data.NODE_ENV === 'test',
  IS_PRODUCTION: parsed.data.NODE_ENV === 'production',
} as const;

export type AppEnv = typeof appEnv;
