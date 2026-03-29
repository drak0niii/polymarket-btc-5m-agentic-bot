import { ServerSigner } from '@polymarket-btc-5m-agentic-bot/signing-engine';
import { ethers } from 'ethers';
import path from 'path';
import { pathToFileURL } from 'url';

export interface OfficialSettlementClientConfig {
  relayerUrl?: string | null;
  chainId: number;
  privateKey: string;
  signatureType?: number;
  funder?: string | null;
  profileAddress?: string | null;
  builderApiKey?: string | null;
  builderSecret?: string | null;
  builderPassphrase?: string | null;
  builderRemoteUrl?: string | null;
  builderRemoteToken?: string | null;
}

export interface SettlementClientReadiness {
  ready: boolean;
  authMode: 'local_builder' | 'remote_builder' | 'missing';
  reason: string;
  relayerUrl: string | null;
  signatureType: number;
  eoaAddress: string | null;
  expectedSafeAddress: string | null;
  configuredAccount: string | null;
  safeMatchesConfiguredAccount: boolean;
  safeDeployed: boolean | null;
  safeNonce: string | null;
  authProbeSucceeded: boolean;
  authProbeError: string | null;
}

export interface RelayerStateTransition {
  state: string;
  observedAt: string;
  transactionHash: string | null;
}

export interface CtfRedeemExecutionInput {
  tokenId: string;
  conditionId: string;
  indexSets: number[];
  expectedClaimAmount: number | null;
  metadata: string;
  collateralToken: string;
  parentCollectionId?: string | null;
  ctfContractAddress: string;
  maxPolls?: number;
  pollIntervalMs?: number;
}

export interface CtfRedeemExecutionResult {
  accepted: boolean;
  transactionId: string | null;
  initialState: string | null;
  finalState: string | null;
  transactionHash: string | null;
  stateTransitions: RelayerStateTransition[];
  claimedAmount: number | null;
  reason: string | null;
}

interface BuilderConfigInstance {
  isValid: () => boolean;
}

interface BuilderSigningModule {
  BuilderConfig: new (config: {
    localBuilderCreds?: {
      key: string;
      secret: string;
      passphrase: string;
    };
    remoteBuilderConfig?: {
      url: string;
      token?: string;
    };
  }) => BuilderConfigInstance;
}

interface RelayerTransaction {
  transactionID: string;
  transactionHash: string;
  state: string;
}

interface RelayerTransactionResponse {
  transactionID: string;
  state: string;
  hash: string;
  transactionHash: string;
  getTransaction: () => Promise<RelayerTransaction[]>;
}

interface RelayClientInstance {
  getNonce: (signerAddress: string, signerType: string) => Promise<{ nonce: string }>;
  getDeployed: (safe: string) => Promise<boolean>;
  getTransactions: () => Promise<unknown[]>;
  getTransaction: (transactionId: string) => Promise<RelayerTransaction[]>;
  execute: (
    txns: Array<{ to: string; data: string; value: string }>,
    metadata?: string,
  ) => Promise<RelayerTransactionResponse>;
}

interface RelayerModule {
  RelayClient: new (
    relayerUrl: string,
    chainId: number,
    signer?: unknown,
    builderConfig?: unknown,
    relayTxType?: string,
  ) => RelayClientInstance;
  RelayerTxType: {
    SAFE: string;
    PROXY: string;
  };
}

const POLYGON_SAFE_FACTORY = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b';
const POLYGON_SAFE_INIT_CODE_HASH =
  '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf';
const ZERO_PARENT_COLLECTION_ID = ethers.constants.HashZero;
const TERMINAL_SUCCESS_STATE = 'STATE_CONFIRMED';
const TERMINAL_FAILURE_STATES = new Set(['STATE_FAILED', 'STATE_INVALID']);
const READ_ONLY_RPC_URLS_BY_CHAIN: Record<number, readonly string[]> = {
  137: [
    'https://polygon-bor-rpc.publicnode.com',
    'https://1rpc.io/matic',
    'https://polygon.drpc.org',
  ],
};

function dynamicImport<T>(specifier: string): Promise<T> {
  const importer = new Function('s', 'return import(s)') as (s: string) => Promise<T>;
  return importer(specifier);
}

async function importBuilderSigningModule(): Promise<BuilderSigningModule> {
  const candidates = [
    '@polymarket/builder-signing-sdk',
    '@polymarket/builder-signing-sdk/dist/index.js',
  ];
  const searchPaths = [process.cwd(), path.join(process.cwd(), 'apps/worker')];
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      const resolved = require.resolve(candidate, { paths: searchPaths });
      return await dynamicImport<BuilderSigningModule>(pathToFileURL(resolved).href);
    } catch (error) {
      failures.push(
        `${candidate}=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `Failed to resolve @polymarket/builder-signing-sdk for the runtime workspace. ${failures.join('; ')}`,
  );
}

async function importRelayerModule(): Promise<RelayerModule> {
  const candidates = [
    '@polymarket/builder-relayer-client',
    '@polymarket/builder-relayer-client/dist/index.js',
  ];
  const searchPaths = [process.cwd(), path.join(process.cwd(), 'apps/worker')];
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      const resolved = require.resolve(candidate, { paths: searchPaths });
      return await dynamicImport<RelayerModule>(pathToFileURL(resolved).href);
    } catch (error) {
      failures.push(
        `${candidate}=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `Failed to resolve @polymarket/builder-relayer-client for the runtime workspace. ${failures.join('; ')}`,
  );
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed : null;
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OfficialPolymarketSettlementClient {
  private readonly serverSigner: ServerSigner;
  private relayClientPromise: Promise<RelayClientInstance> | null = null;
  private readinessPromise: Promise<SettlementClientReadiness> | null = null;
  private readOnlyProviderPromise: Promise<ethers.providers.StaticJsonRpcProvider> | null = null;

  constructor(private readonly config: OfficialSettlementClientConfig) {
    this.serverSigner = new ServerSigner({
      privateKey: config.privateKey,
      funder: config.funder ?? null,
      profileAddress: config.profileAddress ?? null,
      signatureType: config.signatureType ?? 0,
    });
  }

  async validateInitialization(expectedAccount?: string | null): Promise<SettlementClientReadiness> {
    if (!this.readinessPromise) {
      this.readinessPromise = this.buildReadiness(expectedAccount ?? null);
    }
    return this.readinessPromise;
  }

  async redeemCtfPosition(input: CtfRedeemExecutionInput): Promise<CtfRedeemExecutionResult> {
    const readiness = await this.validateInitialization();
    if (!readiness.ready) {
      throw new Error(`Settlement auth is not ready: ${readiness.reason}`);
    }

    const client = await this.getRelayClient();
    const calldata = this.encodeCtfRedeemCall({
      collateralToken: input.collateralToken,
      parentCollectionId: input.parentCollectionId ?? ZERO_PARENT_COLLECTION_ID,
      conditionId: input.conditionId,
      indexSets: input.indexSets,
    });

    const response = await client.execute(
      [
        {
          to: input.ctfContractAddress,
          data: calldata,
          value: '0',
        },
      ],
      input.metadata,
    );

    const stateTransitions: RelayerStateTransition[] = [];
    this.recordStateTransition(stateTransitions, response.state, response.transactionHash);

    const finalTransaction = await this.pollTransaction({
      client,
      transactionId: response.transactionID,
      stateTransitions,
      maxPolls: input.maxPolls ?? 45,
      pollIntervalMs: input.pollIntervalMs ?? 2000,
    });

    const finalState = finalTransaction?.state ?? response.state ?? null;
    const finalHash = finalTransaction?.transactionHash ?? response.transactionHash ?? response.hash ?? null;
    const confirmed = finalState === TERMINAL_SUCCESS_STATE;

    return {
      accepted: true,
      transactionId: response.transactionID ?? null,
      initialState: response.state ?? null,
      finalState,
      transactionHash: finalHash,
      stateTransitions,
      claimedAmount: confirmed ? input.expectedClaimAmount : null,
      reason: confirmed
        ? null
        : finalState && TERMINAL_FAILURE_STATES.has(finalState)
          ? `Relayer transaction reached terminal failure state ${finalState}.`
          : `Relayer transaction did not reach ${TERMINAL_SUCCESS_STATE}.`,
    };
  }

  private async buildReadiness(expectedAccount: string | null): Promise<SettlementClientReadiness> {
    const relayerUrl = trimToNull(this.config.relayerUrl);
    const signatureType = this.config.signatureType ?? 0;
    const wallet = new ethers.Wallet(this.serverSigner.getNormalizedPrivateKey());
    const eoaAddress = wallet.address;
    const expectedSafeAddress = this.deriveSafeAddress(eoaAddress);
    const configuredAccount =
      normalizeAddress(this.config.profileAddress ?? null) ??
      normalizeAddress(this.config.funder ?? null);
    const accountForValidation = expectedAccount ?? configuredAccount;
    const safeMatchesConfiguredAccount =
      !accountForValidation || accountForValidation.toLowerCase() === expectedSafeAddress.toLowerCase();

    const builderConfigResult = await this.buildBuilderConfig();

    if (!relayerUrl) {
      return {
        ready: false,
        authMode: builderConfigResult.authMode,
        reason: 'POLY_RELAYER_URL is missing.',
        relayerUrl: null,
        signatureType,
        eoaAddress,
        expectedSafeAddress,
        configuredAccount: accountForValidation,
        safeMatchesConfiguredAccount,
        safeDeployed: null,
        safeNonce: null,
        authProbeSucceeded: false,
        authProbeError: null,
      };
    }

    if (signatureType !== 2) {
      return {
        ready: false,
        authMode: builderConfigResult.authMode,
        reason: `SAFE settlement requires POLY_SIGNATURE_TYPE=2. Received ${signatureType}.`,
        relayerUrl,
        signatureType,
        eoaAddress,
        expectedSafeAddress,
        configuredAccount: accountForValidation,
        safeMatchesConfiguredAccount,
        safeDeployed: null,
        safeNonce: null,
        authProbeSucceeded: false,
        authProbeError: null,
      };
    }

    if (!safeMatchesConfiguredAccount) {
      return {
        ready: false,
        authMode: builderConfigResult.authMode,
        reason:
          `Configured settlement account ${accountForValidation} does not match the deterministic SAFE ${expectedSafeAddress}.`,
        relayerUrl,
        signatureType,
        eoaAddress,
        expectedSafeAddress,
        configuredAccount: accountForValidation,
        safeMatchesConfiguredAccount,
        safeDeployed: null,
        safeNonce: null,
        authProbeSucceeded: false,
        authProbeError: null,
      };
    }

    if (!builderConfigResult.builderConfig) {
      return {
        ready: false,
        authMode: 'missing',
        reason:
          'Settlement auth is missing. Provide local builder credentials or remote builder signer configuration.',
        relayerUrl,
        signatureType,
        eoaAddress,
        expectedSafeAddress,
        configuredAccount: accountForValidation,
        safeMatchesConfiguredAccount,
        safeDeployed: null,
        safeNonce: null,
        authProbeSucceeded: false,
        authProbeError: null,
      };
    }

    const relayerModule = await importRelayerModule();
    let relaySigner: ethers.Wallet;

    try {
      relaySigner = await this.buildRelaySigner();
    } catch (error) {
      return {
        ready: false,
        authMode: builderConfigResult.authMode,
        reason: `Read-only settlement provider initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        relayerUrl,
        signatureType,
        eoaAddress,
        expectedSafeAddress,
        configuredAccount: accountForValidation,
        safeMatchesConfiguredAccount,
        safeDeployed: null,
        safeNonce: null,
        authProbeSucceeded: false,
        authProbeError: null,
      };
    }

    const client = new relayerModule.RelayClient(
      relayerUrl,
      this.config.chainId,
      relaySigner,
      builderConfigResult.builderConfig,
      relayerModule.RelayerTxType.SAFE,
    );

    let safeDeployed: boolean | null = null;
    let safeNonce: string | null = null;
    let authProbeSucceeded = false;
    let authProbeError: string | null = null;

    try {
      safeDeployed = await client.getDeployed(expectedSafeAddress);
      const noncePayload = await client.getNonce(eoaAddress, 'SAFE');
      safeNonce = trimToNull(noncePayload.nonce) ?? '0';
      await client.getTransactions();
      authProbeSucceeded = true;
    } catch (error) {
      authProbeError = error instanceof Error ? error.message : String(error);
    }

    return {
      ready: Boolean(safeDeployed && authProbeSucceeded),
      authMode: builderConfigResult.authMode,
      reason:
        safeDeployed && authProbeSucceeded
          ? 'SAFE settlement auth validated via non-mutating relayer probes.'
          : safeDeployed === false
            ? `Deterministic SAFE ${expectedSafeAddress} is not deployed on the relayer.`
            : authProbeError ?? 'Settlement auth validation failed.',
      relayerUrl,
      signatureType,
      eoaAddress,
      expectedSafeAddress,
      configuredAccount: accountForValidation,
      safeMatchesConfiguredAccount,
      safeDeployed,
      safeNonce,
      authProbeSucceeded,
      authProbeError,
    };
  }

  private async getRelayClient(): Promise<RelayClientInstance> {
    if (!this.relayClientPromise) {
      this.relayClientPromise = this.buildRelayClient();
    }
    return this.relayClientPromise;
  }

  private async buildRelayClient(): Promise<RelayClientInstance> {
    const readiness = await this.validateInitialization();
    if (!readiness.ready || !readiness.relayerUrl) {
      throw new Error(`Settlement client cannot initialize: ${readiness.reason}`);
    }

    const relayerModule = await importRelayerModule();
    const builderConfigResult = await this.buildBuilderConfig();
    if (!builderConfigResult.builderConfig) {
      throw new Error('Settlement client cannot initialize without builder auth.');
    }

    const wallet = await this.buildRelaySigner();
    return new relayerModule.RelayClient(
      readiness.relayerUrl,
      this.config.chainId,
      wallet,
      builderConfigResult.builderConfig,
      relayerModule.RelayerTxType.SAFE,
    );
  }

  private async buildBuilderConfig(): Promise<{
    authMode: SettlementClientReadiness['authMode'];
    builderConfig: BuilderConfigInstance | null;
  }> {
    const localKey = trimToNull(this.config.builderApiKey);
    const localSecret = trimToNull(this.config.builderSecret);
    const localPassphrase = trimToNull(this.config.builderPassphrase);
    const remoteUrl = trimToNull(this.config.builderRemoteUrl);
    const remoteToken = trimToNull(this.config.builderRemoteToken);

    if (localKey && localSecret && localPassphrase) {
      const module = await importBuilderSigningModule();
      const builderConfig = new module.BuilderConfig({
        localBuilderCreds: {
          key: localKey,
          secret: localSecret,
          passphrase: localPassphrase,
        },
      });
      return {
        authMode: 'local_builder',
        builderConfig,
      };
    }

    if (remoteUrl) {
      const module = await importBuilderSigningModule();
      const builderConfig = new module.BuilderConfig({
        remoteBuilderConfig: {
          url: remoteUrl,
          token: remoteToken ?? undefined,
        },
      });
      return {
        authMode: 'remote_builder',
        builderConfig,
      };
    }

    return {
      authMode: 'missing',
      builderConfig: null,
    };
  }

  private deriveSafeAddress(eoaAddress: string): string {
    const salt = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(['address'], [eoaAddress]),
    );
    return ethers.utils.getCreate2Address(
      POLYGON_SAFE_FACTORY,
      salt,
      POLYGON_SAFE_INIT_CODE_HASH,
    );
  }

  private async buildRelaySigner(): Promise<ethers.Wallet> {
    const provider = await this.getReadOnlyProvider();
    return new ethers.Wallet(this.serverSigner.getNormalizedPrivateKey(), provider);
  }

  private async getReadOnlyProvider(): Promise<ethers.providers.StaticJsonRpcProvider> {
    if (!this.readOnlyProviderPromise) {
      this.readOnlyProviderPromise = this.buildReadOnlyProvider();
    }

    return this.readOnlyProviderPromise;
  }

  private async buildReadOnlyProvider(): Promise<ethers.providers.StaticJsonRpcProvider> {
    const rpcUrls = READ_ONLY_RPC_URLS_BY_CHAIN[this.config.chainId] ?? [];
    if (rpcUrls.length === 0) {
      throw new Error(
        `No read-only settlement RPC endpoints are configured for chainId ${this.config.chainId}.`,
      );
    }

    const failures: string[] = [];
    for (const rpcUrl of rpcUrls) {
      const provider = new ethers.providers.StaticJsonRpcProvider(
        {
          url: rpcUrl,
          timeout: 5000,
        },
        this.config.chainId,
      );

      try {
        await provider.getBlockNumber();
        return provider;
      } catch (error) {
        failures.push(
          `${rpcUrl}=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new Error(
      `Unable to connect a read-only settlement RPC provider for chainId ${this.config.chainId}. ${failures.join('; ')}`,
    );
  }

  private encodeCtfRedeemCall(input: {
    collateralToken: string;
    parentCollectionId: string;
    conditionId: string;
    indexSets: number[];
  }): string {
    const iface = new ethers.utils.Interface([
      'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    ]);

    return iface.encodeFunctionData('redeemPositions', [
      input.collateralToken,
      input.parentCollectionId,
      input.conditionId,
      input.indexSets,
    ]);
  }

  private async pollTransaction(input: {
    client: RelayClientInstance;
    transactionId: string;
    stateTransitions: RelayerStateTransition[];
    maxPolls: number;
    pollIntervalMs: number;
  }): Promise<RelayerTransaction | null> {
    let latest: RelayerTransaction | null = null;

    for (let attempt = 0; attempt < input.maxPolls; attempt += 1) {
      const transactions = await input.client.getTransaction(input.transactionId);
      latest = transactions[0] ?? latest;
      if (latest) {
        this.recordStateTransition(
          input.stateTransitions,
          latest.state,
          latest.transactionHash ?? null,
        );
        if (
          latest.state === TERMINAL_SUCCESS_STATE ||
          TERMINAL_FAILURE_STATES.has(latest.state)
        ) {
          return latest;
        }
      }

      await sleep(input.pollIntervalMs);
    }

    return latest;
  }

  private recordStateTransition(
    transitions: RelayerStateTransition[],
    state: string | null | undefined,
    transactionHash: string | null | undefined,
  ): void {
    const normalizedState = trimToNull(state);
    if (!normalizedState) {
      return;
    }

    const normalizedHash = trimToNull(transactionHash);
    const last = transitions[transitions.length - 1];
    if (last && last.state === normalizedState && last.transactionHash === normalizedHash) {
      return;
    }

    transitions.push({
      state: normalizedState,
      observedAt: new Date().toISOString(),
      transactionHash: normalizedHash,
    });
  }
}
