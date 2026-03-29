import { z } from 'zod';
import { loadWorkerEnvironment, resolveSecrets } from './secret-provider';

const loadedEnvironment = loadWorkerEnvironment(process.env);
Object.assign(process.env, loadedEnvironment.env);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  WORKER_HOST: z.string().min(1).default('0.0.0.0'),
  WORKER_PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY_SECRET_PATH: z.string().optional(),
  OPENAI_MODEL_PLANNER: z.string().min(1).default('gpt-5'),
  OPENAI_MODEL_CRITIC: z.string().min(1).default('gpt-5'),
  OPENAI_MODEL_REVIEWER: z.string().min(1).default('gpt-5'),
  OPENAI_MODEL_ANOMALY: z.string().min(1).default('gpt-5'),

  POLY_CLOB_HOST: z.string().min(1, 'POLY_CLOB_HOST is required'),
  POLY_GAMMA_HOST: z.string().min(1, 'POLY_GAMMA_HOST is required'),
  POLY_DATA_API_HOST: z.string().min(1).default('https://data-api.polymarket.com'),
  POLY_CHAIN_ID: z.coerce.number().int().positive().default(137),
  POLY_PRIVATE_KEY: z.string().optional(),
  POLY_PRIVATE_KEY_SECRET_PATH: z.string().optional(),
  POLY_API_KEY: z.string().optional(),
  POLY_API_KEY_SECRET_PATH: z.string().optional(),
  POLY_API_SECRET: z.string().optional(),
  POLY_API_SECRET_PATH: z.string().optional(),
  POLY_API_PASSPHRASE: z.string().optional(),
  POLY_API_PASSPHRASE_PATH: z.string().optional(),
  POLY_SIGNATURE_TYPE: z.coerce.number().int().nonnegative().default(0),
  POLY_FUNDER: z.string().optional(),
  POLY_PROFILE_ADDRESS: z.string().optional(),
  POLY_GEO_BLOCK_TOKEN: z.string().optional(),
  POLY_USE_SERVER_TIME: z.coerce.boolean().default(true),
  POLY_MAX_CLOCK_SKEW_MS: z.coerce.number().int().nonnegative().default(5000),
  POLY_STARTUP_TOKEN_ID: z.string().optional(),
  POLY_RELAYER_URL: z.string().optional(),
  POLY_BUILDER_API_KEY: z.string().optional(),
  POLY_BUILDER_SECRET: z.string().optional(),
  POLY_BUILDER_PASSPHRASE: z.string().optional(),
  POLY_BUILDER_REMOTE_URL: z.string().optional(),
  POLY_BUILDER_REMOTE_TOKEN: z.string().optional(),

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
  BOT_ORDER_STALE_AFTER_MS: z.coerce.number().int().positive().default(30000),
  BOT_INITIAL_BANKROLL: z.coerce.number().positive().default(1000),
  BOT_LIVE_EXECUTION_ENABLED: z.coerce.boolean().default(true),
  BOT_MAX_BTC_SNAPSHOT_AGE_MS: z.coerce.number().int().positive().default(15000),
  BOT_MAX_SIGNAL_AGE_MS: z.coerce.number().int().positive().default(15000),
  BOT_MAX_ORDERBOOK_AGE_MS: z.coerce.number().int().positive().default(8000),
  BOT_MAX_MARKET_SNAPSHOT_AGE_MS: z.coerce.number().int().positive().default(8000),
  BOT_MAX_EXTERNAL_BALANCE_AGE_MS: z.coerce.number().int().positive().default(15000),
  BOT_MAX_EXTERNAL_ALLOWANCE_AGE_MS: z.coerce.number().int().positive().default(15000),
  BOT_MAX_EXTERNAL_OPEN_ORDERS_AGE_MS: z.coerce.number().int().positive().default(10000),
  BOT_MAX_EXTERNAL_CLOB_TRADES_AGE_MS: z.coerce.number().int().positive().default(20000),
  BOT_MAX_EXTERNAL_DATA_TRADES_AGE_MS: z.coerce.number().int().positive().default(30000),
  BOT_MAX_EXTERNAL_POSITIONS_AGE_MS: z.coerce.number().int().positive().default(30000),
  BOT_MAX_EXTERNAL_CLOSED_POSITIONS_AGE_MS: z.coerce.number().int().positive().default(300000),
  BOT_ORDER_MISSING_OPEN_GRACE_MS: z.coerce.number().int().nonnegative().default(5000),
  BOT_STOP_DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  BOT_REQUIRE_VENUE_SMOKE_GATE: z.coerce.boolean().default(true),
  BOT_RUN_VENUE_SMOKE_ON_STARTUP: z.coerce.boolean().default(false),
  BOT_MAX_VENUE_SMOKE_AGE_MS: z.coerce.number().int().positive().default(21600000),
  BOT_STARTUP_RUNBOOK_FAIL_FAST: z.coerce.boolean().default(false),
  BOT_STARTUP_RECOVERY_REQUIRED: z.coerce.boolean().default(true),
  BOT_ENV_PROFILE: z.enum(['default', 'smoke']).default('default'),
  BOT_SECRET_SOURCE_MODE: z.enum(['auto', 'env', 'file']).default('auto'),
  BOT_ALLOW_INSECURE_ENV_SECRETS_IN_PRODUCTION: z.coerce.boolean().default(false),
  BOT_MARKET_WS_URL: z.string().optional(),
  BOT_USER_WS_URL: z.string().optional(),
  BOT_MAX_MARKET_STREAM_STALENESS_MS: z.coerce.number().int().positive().default(12000),
  BOT_MAX_USER_STREAM_STALENESS_MS: z.coerce.number().int().positive().default(12000),
  BOT_ALLOW_EMERGENCY_CANCEL_IN_HALTED_HARD: z.coerce.boolean().default(true),
  BOT_DEPLOYMENT_TIER: z
    .enum(['research', 'paper', 'canary', 'cautious_live', 'scaled_live'])
    .default('paper'),
  BOT_MIN_LIVE_TRADES_FOR_CANARY: z.coerce.number().int().nonnegative().default(0),
  BOT_MIN_LIVE_TRADES_FOR_CAUTIOUS_LIVE: z.coerce.number().int().nonnegative().default(8),
  BOT_MIN_LIVE_TRADES_FOR_SCALED_LIVE: z.coerce.number().int().nonnegative().default(20),
  BOT_MAX_ALLOWED_REALIZED_EXPECTED_EDGE_GAP_BPS: z.coerce.number().nonnegative().default(50),
  BOT_MAX_ALLOWED_RECONCILIATION_DEFECT_RATE: z.coerce.number().min(0).max(1).default(0.1),
  BOT_ENABLE_SHADOW_DECISION_LOGGING: z.coerce.boolean().default(true),
  BOT_REQUIRE_PRODUCTION_READINESS_PASS: z.coerce.boolean().default(true),

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

const parsed = envSchema.safeParse(loadedEnvironment.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
    .join('; ');

  throw new Error(`Invalid environment configuration: ${issues}`);
}

const resolvedSecrets = resolveSecrets(process.env, {
  mode: parsed.data.BOT_SECRET_SOURCE_MODE,
  allowInsecureEnvInProduction: parsed.data.BOT_ALLOW_INSECURE_ENV_SECRETS_IN_PRODUCTION,
  isProduction: parsed.data.NODE_ENV === 'production',
}, {
  sources: loadedEnvironment.sources,
  cwd: process.cwd(),
  isTest: parsed.data.NODE_ENV === 'test',
});

if (!resolvedSecrets.healthy) {
  throw new Error(
    `Invalid secret configuration: ${resolvedSecrets.issues.join(', ')}`,
  );
}

export const appEnv = {
  ...parsed.data,
  OPENAI_API_KEY: resolvedSecrets.secrets.openAiApiKey.value,
  POLY_PRIVATE_KEY: resolvedSecrets.secrets.polyPrivateKey.value,
  POLY_API_KEY: resolvedSecrets.secrets.polyApiKey.value,
  POLY_API_SECRET: resolvedSecrets.secrets.polyApiSecret.value,
  POLY_API_PASSPHRASE: resolvedSecrets.secrets.polyApiPassphrase.value,
  SECRET_CONFIGURATION: {
    healthy: resolvedSecrets.healthy,
    insecureInProduction: resolvedSecrets.insecureInProduction,
    productionPolicyPassed: resolvedSecrets.productionPolicyPassed,
    issues: resolvedSecrets.issues,
    loadedFiles: loadedEnvironment.loadedFiles,
    evidence: resolvedSecrets.evidence,
    sources: {
      openAiApiKey: resolvedSecrets.secrets.openAiApiKey.source,
      polyPrivateKey: resolvedSecrets.secrets.polyPrivateKey.source,
      polyApiKey: resolvedSecrets.secrets.polyApiKey.source,
      polyApiSecret: resolvedSecrets.secrets.polyApiSecret.source,
      polyApiPassphrase: resolvedSecrets.secrets.polyApiPassphrase.source,
    },
  },
  IS_DEVELOPMENT: parsed.data.NODE_ENV === 'development',
  IS_TEST: parsed.data.NODE_ENV === 'test',
  IS_PRODUCTION: parsed.data.NODE_ENV === 'production',
} as const;

export type AppEnv = typeof appEnv;
