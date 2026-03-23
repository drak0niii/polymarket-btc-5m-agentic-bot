import { KeyLoader } from './key-loader';
import { normalizePrivateKeyForPolymarket } from './polymarket-private-key';
import { SignerHealth, SignerHealthStatus } from './signer-health';

export interface ServerSignerConfig {
  privateKey: string | null | undefined;
  apiKey?: string | null;
  apiSecret?: string | null;
  apiPassphrase?: string | null;
  funder?: string | null;
  profileAddress?: string | null;
  signatureType?: number;
  secretSource?: string | null;
}

export interface ServerSignerIdentity {
  funder: string | null;
  profileAddress: string | null;
  signatureType: number;
  secretSource: string | null;
}

export interface ServerSignerDiagnostics {
  address: string | null;
  funder: string | null;
  profileAddress: string | null;
  signatureType: number;
  secretSource: string | null;
  privateKeyPresent: boolean;
}

export interface WalletConstructor<TWallet> {
  new (privateKey: string): TWallet;
}

export class ServerSigner {
  private readonly keyLoader = new KeyLoader();
  private readonly signerHealth = new SignerHealth();

  constructor(private readonly config: ServerSignerConfig) {}

  getIdentity(): ServerSignerIdentity {
    return {
      funder: this.normalizeAddress(this.config.funder),
      profileAddress: this.normalizeAddress(this.config.profileAddress),
      signatureType: this.config.signatureType ?? 0,
      secretSource: this.config.secretSource ?? null,
    };
  }

  getNormalizedPrivateKey(): string {
    const loaded = this.keyLoader.load(this.config.privateKey, 'Polymarket signer privateKey');
    return normalizePrivateKeyForPolymarket(loaded.privateKey);
  }

  createWallet<TWallet>(Wallet: WalletConstructor<TWallet>): TWallet {
    return new Wallet(this.getNormalizedPrivateKey());
  }

  getAddress<TWallet extends Record<string, unknown>>(
    Wallet: WalletConstructor<TWallet>,
  ): string {
    const explicit =
      this.normalizeAddress(this.config.profileAddress) ??
      this.normalizeAddress(this.config.funder);
    if (explicit) {
      return explicit;
    }

    const wallet = this.createWallet(Wallet);
    const address =
      'address' in wallet ? this.normalizeAddress(wallet.address as string | null | undefined) : null;
    if (!address) {
      throw new Error('ServerSigner could not resolve wallet address.');
    }

    return address;
  }

  getHealth(): SignerHealthStatus {
    return this.signerHealth.check({
      privateKey: this.config.privateKey,
      apiKey: this.config.apiKey ?? null,
      apiSecret: this.config.apiSecret ?? null,
      apiPassphrase: this.config.apiPassphrase ?? null,
    });
  }

  getDiagnostics(): ServerSignerDiagnostics {
    const identity = this.getIdentity();

    return {
      address: identity.profileAddress ?? identity.funder,
      funder: identity.funder,
      profileAddress: identity.profileAddress,
      signatureType: identity.signatureType,
      secretSource: identity.secretSource,
      privateKeyPresent: Boolean(this.config.privateKey && this.config.privateKey.trim().length > 0),
    };
  }

  private normalizeAddress(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }

    const trimmed = value.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed : null;
  }
}
