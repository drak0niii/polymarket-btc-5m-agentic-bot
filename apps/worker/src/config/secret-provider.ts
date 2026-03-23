import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

export type SecretSourceMode = 'auto' | 'env' | 'file';
export type SecretSourceClassification =
  | 'env_file'
  | 'process_env'
  | 'external_secret_provider'
  | 'test_override'
  | 'unknown'
  | 'missing';

export interface EnvironmentValueSource {
  classification: Exclude<SecretSourceClassification, 'external_secret_provider' | 'missing'>;
  filePath: string | null;
}

export interface LoadedWorkerEnvironment {
  env: NodeJS.ProcessEnv;
  sources: Record<string, EnvironmentValueSource>;
  loadedFiles: string[];
}

export interface ResolvedSecret {
  key: string;
  value: string | undefined;
  source: SecretSourceClassification;
  filePath: string | null;
  required: boolean;
  present: boolean;
  approvedInProduction: boolean;
}

export interface SecretProviderOptions {
  mode: SecretSourceMode;
  allowInsecureEnvInProduction: boolean;
  isProduction: boolean;
}

export interface SecretProviderVerdict {
  healthy: boolean;
  insecureInProduction: boolean;
  productionPolicyPassed: boolean;
  issues: string[];
  evidence: {
    requiredSecrets: Array<{
      key: string;
      present: boolean;
      source: SecretSourceClassification;
      approvedInProduction: boolean;
    }>;
  };
  secrets: {
    openAiApiKey: ResolvedSecret;
    polyPrivateKey: ResolvedSecret;
    polyApiKey: ResolvedSecret;
    polyApiSecret: ResolvedSecret;
    polyApiPassphrase: ResolvedSecret;
  };
}

export function loadWorkerEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): LoadedWorkerEnvironment {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const sources: Record<string, EnvironmentValueSource> = {};
  const loadedFiles: string[] = [];

  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string') {
      sources[key] = {
        classification:
          baseEnv.NODE_ENV === 'test' ? 'test_override' : 'process_env',
        filePath: null,
      };
    }
  }

  const nodeEnv = (baseEnv.NODE_ENV ?? 'development').trim();
  if (nodeEnv === 'production') {
    return { env, sources, loadedFiles };
  }

  const filesToLoad = ['.env'];
  if (baseEnv.POLY_SMOKE_EXECUTE === 'true' || baseEnv.BOT_ENV_PROFILE === 'smoke') {
    filesToLoad.push('.env.smoke');
  }

  for (const fileName of filesToLoad) {
    const absolutePath = path.resolve(cwd, fileName);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const parsed = dotenv.parse(fs.readFileSync(absolutePath, 'utf8'));
    loadedFiles.push(absolutePath);
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof env[key] === 'string' && env[key]?.length) {
        continue;
      }

      env[key] = value;
      sources[key] = {
        classification: 'env_file',
        filePath: absolutePath,
      };
    }
  }

  return {
    env,
    sources,
    loadedFiles,
  };
}

function readSecretFromFile(path: string | undefined): string | undefined {
  if (!path || path.trim().length === 0) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(path.trim(), 'utf8').trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

function resolveSecret(input: {
  key: string;
  envValue?: string;
  filePath?: string;
  mode: SecretSourceMode;
  required: boolean;
  isProduction: boolean;
  isTest: boolean;
  envSource?: EnvironmentValueSource;
  cwd: string;
}): ResolvedSecret {
  const envValue = input.envValue?.trim();
  const filePath = input.filePath?.trim();
  const fileValue = readSecretFromFile(filePath);
  const classifyProcessEnv = (): SecretSourceClassification => {
    if (input.isTest) {
      return 'test_override';
    }

    if (!input.envSource) {
      return 'unknown';
    }

    return input.envSource.classification;
  };

  const isApprovedInProduction = (source: SecretSourceClassification, secretPath: string | null): boolean => {
    if (!input.isProduction || !input.required) {
      return true;
    }

    if (source === 'process_env') {
      return true;
    }

    if (source === 'external_secret_provider') {
      return true;
    }

    if (source === 'test_override') {
      return false;
    }

    if (source === 'env_file') {
      return false;
    }

    if (source === 'unknown') {
      return false;
    }

    if (secretPath) {
      const relative = path.relative(input.cwd, secretPath);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        return false;
      }
    }

    return false;
  };

  const classifyFileSource = (secretPath: string | null): SecretSourceClassification => {
    if (!secretPath) {
      return 'missing';
    }

    const relative = path.relative(input.cwd, secretPath);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return 'env_file';
    }

    return input.isTest ? 'test_override' : 'external_secret_provider';
  };

  if (input.mode === 'env') {
    const source = envValue ? classifyProcessEnv() : 'missing';
    return {
      key: input.key,
      value: envValue || undefined,
      source,
      filePath: filePath ?? null,
      required: input.required,
      present: Boolean(envValue),
      approvedInProduction: isApprovedInProduction(source, filePath ?? null),
    };
  }

  if (input.mode === 'file') {
    const source = fileValue ? classifyFileSource(filePath ?? null) : 'missing';
    return {
      key: input.key,
      value: fileValue,
      source,
      filePath: filePath ?? null,
      required: input.required,
      present: Boolean(fileValue),
      approvedInProduction: isApprovedInProduction(source, filePath ?? null),
    };
  }

  if (fileValue) {
    const source = classifyFileSource(filePath ?? null);
    return {
      key: input.key,
      value: fileValue,
      source,
      filePath: filePath ?? null,
      required: input.required,
      present: true,
      approvedInProduction: isApprovedInProduction(source, filePath ?? null),
    };
  }

  if (envValue) {
    const source = classifyProcessEnv();
    return {
      key: input.key,
      value: envValue,
      source,
      filePath: filePath ?? null,
      required: input.required,
      present: true,
      approvedInProduction: isApprovedInProduction(source, filePath ?? null),
    };
  }

  return {
    key: input.key,
    value: undefined,
    source: 'missing',
    filePath: filePath ?? null,
    required: input.required,
    present: false,
    approvedInProduction: !input.required || !input.isProduction,
  };
}

export function resolveSecrets(
  env: NodeJS.ProcessEnv,
  options: SecretProviderOptions,
  metadata?: {
    sources?: Record<string, EnvironmentValueSource>;
    cwd?: string;
    isTest?: boolean;
  },
): SecretProviderVerdict {
  const cwd = metadata?.cwd ?? process.cwd();
  const secrets = {
    openAiApiKey: resolveSecret({
      key: 'OPENAI_API_KEY',
      envValue: env.OPENAI_API_KEY,
      filePath: env.OPENAI_API_KEY_SECRET_PATH,
      mode: options.mode,
      required: false,
      isProduction: options.isProduction,
      isTest: metadata?.isTest ?? false,
      envSource: metadata?.sources?.OPENAI_API_KEY,
      cwd,
    }),
    polyPrivateKey: resolveSecret({
      key: 'POLY_PRIVATE_KEY',
      envValue: env.POLY_PRIVATE_KEY,
      filePath: env.POLY_PRIVATE_KEY_SECRET_PATH,
      mode: options.mode,
      required: true,
      isProduction: options.isProduction,
      isTest: metadata?.isTest ?? false,
      envSource: metadata?.sources?.POLY_PRIVATE_KEY,
      cwd,
    }),
    polyApiKey: resolveSecret({
      key: 'POLY_API_KEY',
      envValue: env.POLY_API_KEY,
      filePath: env.POLY_API_KEY_SECRET_PATH,
      mode: options.mode,
      required: true,
      isProduction: options.isProduction,
      isTest: metadata?.isTest ?? false,
      envSource: metadata?.sources?.POLY_API_KEY,
      cwd,
    }),
    polyApiSecret: resolveSecret({
      key: 'POLY_API_SECRET',
      envValue: env.POLY_API_SECRET,
      filePath: env.POLY_API_SECRET_PATH,
      mode: options.mode,
      required: true,
      isProduction: options.isProduction,
      isTest: metadata?.isTest ?? false,
      envSource: metadata?.sources?.POLY_API_SECRET,
      cwd,
    }),
    polyApiPassphrase: resolveSecret({
      key: 'POLY_API_PASSPHRASE',
      envValue: env.POLY_API_PASSPHRASE,
      filePath: env.POLY_API_PASSPHRASE_PATH,
      mode: options.mode,
      required: true,
      isProduction: options.isProduction,
      isTest: metadata?.isTest ?? false,
      envSource: metadata?.sources?.POLY_API_PASSPHRASE,
      cwd,
    }),
  };

  const issues: string[] = [];
  const requiredSecrets = Object.values(secrets).filter((secret) => secret.required);
  const insecureInProduction =
    options.isProduction &&
    !options.allowInsecureEnvInProduction &&
    requiredSecrets.some((secret) => !secret.approvedInProduction);

  if (options.isProduction && insecureInProduction) {
    issues.push('production_env_secrets_forbidden');
  }

  for (const secret of Object.values(secrets)) {
    if (secret.source === 'missing' && secret.filePath) {
      issues.push(`${secret.key.toLowerCase()}_file_missing`);
    }
    if (secret.required && !secret.present) {
      issues.push(`${secret.key.toLowerCase()}_missing`);
    }
    if (options.isProduction && secret.required && !secret.approvedInProduction) {
      issues.push(`${secret.key.toLowerCase()}_source_${secret.source}_forbidden_in_production`);
    }
  }

  return {
    healthy: issues.length === 0,
    insecureInProduction,
    productionPolicyPassed:
      !options.isProduction || requiredSecrets.every((secret) => secret.approvedInProduction),
    issues,
    evidence: {
      requiredSecrets: requiredSecrets.map((secret) => ({
        key: secret.key,
        present: secret.present,
        source: secret.source,
        approvedInProduction: secret.approvedInProduction,
      })),
    },
    secrets,
  };
}

const SECRET_KEY_PATTERN =
  /passphrase|secret|private[_-]?key|api[_-]?key|authorization|token/i;

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry)) as T;
  }

  if (value && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = redactSecrets(entry);
      }
    }
    return redacted as T;
  }

  return value;
}
