export interface L1BootstrapInput {
  privateKey: string;
  chainId: number;
  address: string;
  funder?: string;
  signatureType: number;
}

export interface L1BootstrapContext {
  address: string;
  chainId: number;
  funder: string | null;
  signatureType: number;
  initializedAt: string;
}

export class L1Bootstrap {
  initialize(input: L1BootstrapInput): L1BootstrapContext {
    if (!input.privateKey || input.privateKey.trim().length === 0) {
      throw new Error('L1 bootstrap failed: private key is required.');
    }

    if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
      throw new Error('L1 bootstrap failed: chainId must be a positive integer.');
    }

    if (!Number.isInteger(input.signatureType) || input.signatureType < 0) {
      throw new Error(
        'L1 bootstrap failed: signatureType must be a non-negative integer.',
      );
    }

    const address = input.address.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(
        'L1 bootstrap failed: address must be a valid 20-byte hex address.',
      );
    }

    return {
      address,
      chainId: input.chainId,
      funder: input.funder ?? null,
      signatureType: input.signatureType,
      initializedAt: new Date().toISOString(),
    };
  }
}
