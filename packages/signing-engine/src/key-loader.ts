export interface LoadedKeyMaterial {
  privateKey: string;
  sourceLabel: string;
  loadedAt: string;
}

export class KeyLoader {
  load(privateKeyInput: string | null | undefined, sourceLabel = 'configured privateKey'): LoadedKeyMaterial {
    const privateKey = privateKeyInput?.trim();

    if (!privateKey || privateKey.length === 0) {
      throw new Error(`Key loading failed: ${sourceLabel} is missing.`);
    }

    const isPem = privateKey.startsWith('-----BEGIN');
    const isHex = /^[0-9a-fA-F]{64}$/.test(privateKey.replace(/^0x/, ''));

    if (!isPem && !isHex) {
      throw new Error(
        `Key loading failed: ${sourceLabel} must be 32-byte hex or a PEM-encoded secp256k1 key.`,
      );
    }

    return {
      privateKey,
      sourceLabel,
      loadedAt: new Date().toISOString(),
    };
  }

  loadFromEnv(envKey = 'POLY_PRIVATE_KEY'): LoadedKeyMaterial {
    return this.load(process.env[envKey], `environment variable ${envKey}`);
  }
}
