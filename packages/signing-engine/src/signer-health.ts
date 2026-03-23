import { normalizePrivateKeyForPolymarket } from './polymarket-private-key';

export interface SignerHealthInput {
  privateKey?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
  apiPassphrase?: string | null;
}

export interface SignerHealthStatus {
  healthy: boolean;
  reasonCodes: string[];
  checks: {
    privateKey: boolean;
    apiKey: boolean;
    apiSecret: boolean;
    apiPassphrase: boolean;
  };
  checkedAt: string;
}

export class SignerHealth {
  check(input: SignerHealthInput): SignerHealthStatus {
    const privateKeyValid = this.canSign(input.privateKey ?? null);
    const hasApiKey = Boolean(input.apiKey && input.apiKey.trim().length > 0);
    const hasApiSecret = Boolean(
      input.apiSecret && input.apiSecret.trim().length > 0,
    );
    const hasApiPassphrase = Boolean(
      input.apiPassphrase && input.apiPassphrase.trim().length > 0,
    );

    // API credentials only count as valid if all three are present
    const credentialsComplete = hasApiKey && hasApiSecret && hasApiPassphrase;

    const checks = {
      privateKey: privateKeyValid,
      apiKey: hasApiKey,
      apiSecret: hasApiSecret,
      apiPassphrase: hasApiPassphrase,
    };
    const reasonCodes = [
      ...(privateKeyValid ? [] : ['private_key_invalid']),
      ...(hasApiKey ? [] : ['api_key_missing']),
      ...(hasApiSecret ? [] : ['api_secret_missing']),
      ...(hasApiPassphrase ? [] : ['api_passphrase_missing']),
    ];

    return {
      healthy: privateKeyValid && credentialsComplete,
      reasonCodes,
      checks,
      checkedAt: new Date().toISOString(),
    };
  }

  private canSign(privateKey: string | null): boolean {
    try {
      return normalizePrivateKeyForPolymarket(privateKey).length > 0;
    } catch {
      return false;
    }
  }
}
