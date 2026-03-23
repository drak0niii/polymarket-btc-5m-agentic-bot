export interface L2Credentials {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  createdAt: string;
}

export interface L2CredentialsInput {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

export class L2CredentialsManager {
  create(input: L2CredentialsInput): L2Credentials {
    if (!input.apiKey || input.apiKey.trim().length === 0) {
      throw new Error('L2 credentials failed: apiKey is required.');
    }

    if (!input.apiSecret || input.apiSecret.trim().length === 0) {
      throw new Error('L2 credentials failed: apiSecret is required.');
    }

    if (!input.apiPassphrase || input.apiPassphrase.trim().length === 0) {
      throw new Error('L2 credentials failed: apiPassphrase is required.');
    }

    return {
      apiKey: input.apiKey.trim(),
      apiSecret: input.apiSecret.trim(),
      apiPassphrase: input.apiPassphrase.trim(),
      createdAt: new Date().toISOString(),
    };
  }

  toAuthHeaders(credentials: L2Credentials): Record<string, string> {
    return {
      'POLY_API_KEY': credentials.apiKey,
      'POLY_API_SECRET': credentials.apiSecret,
      'POLY_API_PASSPHRASE': credentials.apiPassphrase,
    };
  }
}