import { createPrivateKey } from 'crypto';

export function normalizePrivateKeyForPolymarket(
  privateKeyInput: string | null | undefined,
): string {
  const normalized = privateKeyInput?.trim() ?? '';
  if (!normalized) {
    throw new Error('Polymarket signer requires privateKey.');
  }

  const keyHex = normalized.replace(/^0x/, '');
  if (/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    return `0x${keyHex}`;
  }

  if (!normalized.startsWith('-----BEGIN')) {
    throw new Error(
      'Polymarket signer privateKey must be 32-byte hex or a PEM-encoded secp256k1 key.',
    );
  }

  const keyObject = createPrivateKey(normalized);
  const jwk = keyObject.export({ format: 'jwk' }) as JsonWebKey;
  if (typeof jwk.d !== 'string' || jwk.d.length === 0) {
    throw new Error('Failed to derive secp256k1 private key bytes from PEM input.');
  }

  const key = base64UrlToBuffer(jwk.d).toString('hex');
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('Derived Polymarket private key is not 32 bytes.');
  }

  return `0x${key}`;
}

function base64UrlToBuffer(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  const suffix = remainder === 0 ? '' : '='.repeat(4 - remainder);
  return Buffer.from(`${padded}${suffix}`, 'base64');
}
