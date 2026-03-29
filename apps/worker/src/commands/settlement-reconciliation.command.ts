import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { appEnv } from '@worker/config/env';
import {
  ExternalPortfolioPositionSnapshot,
  ExternalPortfolioService,
  ExternalPortfolioSnapshot,
} from '@worker/portfolio/external-portfolio.service';
import { resolveRepositoryRoot } from '@worker/runtime/learning-state-store';
import {
  CtfRedeemExecutionResult,
  OfficialPolymarketSettlementClient,
  SettlementClientReadiness,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';

type CommandMode = 'dry_run' | 'execute';

interface ParsedArgs {
  execute: boolean;
  account: string | null;
  confirm: string | null;
  snapshotHash: string | null;
}

interface SettlementPlanSpec {
  tokenId: string;
  conditionId: string;
  slug: string;
  expectedOutcome: string;
  indexSets: number[];
}

interface TokenPlanEntry {
  tokenId: string;
  shortTokenId: string;
  conditionId: string;
  title: string;
  slug: string | null;
  venueOutcome: string | null;
  size: number;
  avgPrice: number | null;
  currentPrice: number | null;
  currentValue: number | null;
  redeemable: boolean;
  mergeable: boolean;
  expectedClaimAmount: number | null;
  indexSets: number[];
  primitive: 'ctf_redeem';
  likelySideNeeded: 'none';
  actionType:
    | 'redeem_claim'
    | 'reconcile_zero_value'
    | 'merge_or_reconcile'
    | 'historical_trade_reconcile_only';
  note: string;
}

interface HistoricalOnlyTradeEntry {
  tokenId: string;
  shortTokenId: string;
  conditionId: string;
  title: string | null;
  outcome: string | null;
  buyQty: number;
  sellQty: number;
  netQty: number;
  latestTimestamp: string | null;
  actionType: 'historical_trade_reconcile_only';
  note: string;
}

interface SnapshotDiffEntry {
  tokenId: string;
  shortTokenId: string;
  previousSize: number;
  currentSize: number;
  previousCurrentPrice: number | null;
  currentCurrentPrice: number | null;
  previousCurrentValue: number | null;
  currentCurrentValue: number | null;
}

interface SnapshotDiff {
  previousCheckpointProcessedAt: string | null;
  addedTokens: string[];
  removedTokens: string[];
  changedTokens: SnapshotDiffEntry[];
}

interface TokenExecutionResult {
  tokenId: string;
  shortTokenId: string;
  conditionId: string;
  indexSets: number[];
  actionType: TokenPlanEntry['actionType'];
  status: 'claimed' | 'failed' | 'skipped';
  expectedClaimAmount: number | null;
  claimedAmount: number | null;
  relayerTransactionId: string | null;
  initialState: string | null;
  finalState: string | null;
  transactionHash: string | null;
  stateTransitions: CtfRedeemExecutionResult['stateTransitions'];
  reason: string;
}

const EXPECTED_POSITION_TOKENS = [
  '39963936072750997656645753651192163983191828148129601701170390720366153693823',
  '13755172529244726850705657536964601042897023945655049643473375896492147473188',
  '114987444323546867984244236358158694827056882619809752900739008117779486532814',
  '59525972398225200784927159870783276179597329106059833611053825332303006648417',
  '102513636192689215890707927624255826656301285205306880989941289975031551601963',
  '67281714353300008594562642562196151253012217614869999280396248803562519337121',
  '34929373672903405067140060164973818573508486733167112567340128168370088133834',
  '20731721576086065236044837772195266152866070259959287491908272216560172742990',
  '50632934701910044979581150028216199657799868954462906973015838639903554164396',
  '85438855026786461143944538533844523569778327175307109021930837661062921496004',
  '23611926548696762485058429798986857615079264538027711517923714260767222572562',
] as const;

const RECONCILIATION_ONLY_RESIDUE_TOKENS = [
  '39963936072750997656645753651192163983191828148129601701170390720366153693823',
  '13755172529244726850705657536964601042897023945655049643473375896492147473188',
  '114987444323546867984244236358158694827056882619809752900739008117779486532814',
  '59525972398225200784927159870783276179597329106059833611053825332303006648417',
  '102513636192689215890707927624255826656301285205306880989941289975031551601963',
  '50632934701910044979581150028216199657799868954462906973015838639903554164396',
  '23611926548696762485058429798986857615079264538027711517923714260767222572562',
] as const;

const HISTORICAL_ONLY_TRADE_TOKEN =
  '20469932696411473373383054468509863683557047380642382528270246097611287430832';

const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const COLLATERAL_TOKEN_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ZERO_PARENT_COLLECTION_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

const SETTLEMENT_EXECUTION_PLAN: readonly SettlementPlanSpec[] = [
  {
    tokenId: '85438855026786461143944538533844523569778327175307109021930837661062921496004',
    conditionId: '0xf7dbefff7afa138b3605a85ef1d86f5a7e433187261001c6802164e097f2f61f',
    slug: 'btc-updown-5m-1773743400',
    expectedOutcome: 'Down',
    indexSets: [2],
  },
  {
    tokenId: '20731721576086065236044837772195266152866070259959287491908272216560172742990',
    conditionId: '0xf1a24b08211f6a5765ff5d926611483bc1cade7443f134789edeb2e5a279d814',
    slug: 'btc-updown-5m-1774266300',
    expectedOutcome: 'Down',
    indexSets: [2],
  },
  {
    tokenId: '34929373672903405067140060164973818573508486733167112567340128168370088133834',
    conditionId: '0x4d302c4c48ae67e3840aa79f5bb6703bd5bb38fb1d92a1bff850d713f6f39e68',
    slug: 'btc-updown-5m-1773750600',
    expectedOutcome: 'Up',
    indexSets: [1],
  },
  {
    tokenId: '67281714353300008594562642562196151253012217614869999280396248803562519337121',
    conditionId: '0x7fd89f90b33db6ee7f1cd5cb3e6f1cd87a3977ec12c792339aaa733ca870d8fd',
    slug: 'btc-updown-5m-1773742500',
    expectedOutcome: 'Up',
    indexSets: [1],
  },
] as const;

const SETTLEMENT_EXECUTION_PLAN_BY_TOKEN = new Map(
  SETTLEMENT_EXECUTION_PLAN.map((entry) => [entry.tokenId, entry]),
);

const ARTIFACT_DIR = path.join(
  resolveRepositoryRoot(),
  'artifacts/settlement-reconciliation',
);
const LATEST_DRY_RUN_PATH = path.join(ARTIFACT_DIR, 'latest.dry-run.json');
const LATEST_EXECUTE_PATH = path.join(ARTIFACT_DIR, 'latest.execute.json');
const LEGACY_LATEST_EXECUTE_PATH = path.join(
  ARTIFACT_DIR,
  'latest.execute-check.json',
);
const HISTORY_DIR = path.join(ARTIFACT_DIR, 'history');

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    execute: false,
    account: null,
    confirm: null,
    snapshotHash: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--execute') {
      parsed.execute = true;
      continue;
    }

    if (current.startsWith('--account=')) {
      parsed.account = current.slice('--account='.length).trim() || null;
      continue;
    }

    if (current === '--account') {
      parsed.account = argv[index + 1]?.trim() || null;
      index += 1;
      continue;
    }

    if (current.startsWith('--confirm=')) {
      parsed.confirm = current.slice('--confirm='.length) || null;
      continue;
    }

    if (current === '--confirm') {
      parsed.confirm = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (current.startsWith('--snapshot-hash=')) {
      parsed.snapshotHash = current.slice('--snapshot-hash='.length).trim() || null;
      continue;
    }

    if (current === '--snapshot-hash') {
      parsed.snapshotHash = argv[index + 1]?.trim() || null;
      index += 1;
    }
  }

  return parsed;
}

function normalizeAccount(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : null;
}

function shortTokenId(tokenId: string): string {
  return `${tokenId.slice(0, 6)}...${tokenId.slice(-4)}`;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(value: string | null | undefined, label: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`${label} is required for settlement reconciliation planning.`);
  }

  return value;
}

function resolveExpectedAccount(snapshot?: ExternalPortfolioSnapshot): string {
  const configured =
    normalizeAccount(appEnv.POLY_PROFILE_ADDRESS ?? appEnv.POLY_FUNDER ?? null);
  if (configured) {
    return configured;
  }

  const candidateValues: unknown[] = [
    snapshot?.positions.current[0]?.raw &&
    typeof snapshot.positions.current[0].raw === 'object'
      ? (snapshot.positions.current[0].raw as Record<string, unknown>).proxyWallet
      : null,
    snapshot?.trades.dataApi[0]?.raw &&
    typeof snapshot.trades.dataApi[0].raw === 'object'
      ? (snapshot.trades.dataApi[0].raw as Record<string, unknown>).proxyWallet
      : null,
  ];

  for (const value of candidateValues) {
    const normalized = normalizeAccount(typeof value === 'string' ? value : null);
    if (normalized) {
      return normalized;
    }
  }

  throw new Error(
    'Settlement reconciliation command could not resolve the current account from .env or the refreshed live snapshot.',
  );
}

function buildPositionMap(
  positions: ExternalPortfolioPositionSnapshot[],
): Map<string, ExternalPortfolioPositionSnapshot> {
  return new Map(positions.map((position) => [position.tokenId, position]));
}

function canonicalizePositions(
  positions: ExternalPortfolioPositionSnapshot[],
): Array<Record<string, unknown>> {
  return [...positions]
    .sort((left, right) => left.tokenId.localeCompare(right.tokenId))
    .map((position) => ({
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      size: position.size,
      currentPrice: position.currentPrice,
      currentValue: position.currentValue,
      avgPrice: position.avgPrice,
      title:
        position.raw && typeof position.raw === 'object'
          ? (position.raw as Record<string, unknown>).title ?? null
          : null,
      slug:
        position.raw && typeof position.raw === 'object'
          ? (position.raw as Record<string, unknown>).slug ?? null
          : null,
      outcome:
        position.raw && typeof position.raw === 'object'
          ? (position.raw as Record<string, unknown>).outcome ?? null
          : null,
      redeemable:
        position.raw && typeof position.raw === 'object'
          ? (position.raw as Record<string, unknown>).redeemable === true
          : false,
      mergeable:
        position.raw && typeof position.raw === 'object'
          ? (position.raw as Record<string, unknown>).mergeable === true
          : false,
    }));
}

function createSnapshotHash(payload: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function ensureArtifactDir(): void {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function writeArtifact(filePath: string, payload: Record<string, unknown>): void {
  ensureArtifactDir();
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function buildHistoricalOnlyTrades(
  snapshot: ExternalPortfolioSnapshot,
): HistoricalOnlyTradeEntry[] {
  const livePositionTokens = new Set(
    snapshot.positions.current.map((position) => position.tokenId),
  );
  const grouped = new Map<string, HistoricalOnlyTradeEntry>();

  for (const trade of snapshot.trades.dataApi) {
    if (livePositionTokens.has(trade.tokenId)) {
      continue;
    }

    const tradeTimestamp = requireString(
      trade.timestamp,
      `timestamp for historical-only trade ${trade.tokenId}`,
    );
    const key = `${trade.tokenId}:${trade.conditionId}`;
    const existing = grouped.get(key);
    if (existing) {
      if (trade.side === 'BUY') {
        existing.buyQty += trade.size;
      } else if (trade.side === 'SELL') {
        existing.sellQty += trade.size;
      }
      existing.netQty = existing.buyQty - existing.sellQty;
      const latestTimestamp = existing.latestTimestamp;
      if (!latestTimestamp || new Date(tradeTimestamp) > new Date(latestTimestamp)) {
        existing.latestTimestamp = tradeTimestamp;
      }
      continue;
    }

    const tradeRaw = readRecord(trade.raw);
    grouped.set(key, {
      tokenId: trade.tokenId,
      shortTokenId: shortTokenId(trade.tokenId),
      conditionId: requireString(trade.conditionId, `conditionId for ${trade.tokenId}`),
      title: typeof tradeRaw?.title === 'string' ? tradeRaw.title : null,
      outcome: typeof tradeRaw?.outcome === 'string' ? tradeRaw.outcome : null,
      buyQty: trade.side === 'BUY' ? trade.size : 0,
      sellQty: trade.side === 'SELL' ? trade.size : 0,
      netQty: trade.side === 'BUY' ? trade.size : -trade.size,
      latestTimestamp: tradeTimestamp,
      actionType: 'historical_trade_reconcile_only',
      note:
        'Historical-only venue trade with no current position; reconcile locally, do not remove via order submission.',
    });
  }

  return [...grouped.values()].sort((left, right) =>
    left.tokenId.localeCompare(right.tokenId),
  );
}

function buildSettlementQueue(
  positionsByToken: Map<string, ExternalPortfolioPositionSnapshot>,
): TokenPlanEntry[] {
  return SETTLEMENT_EXECUTION_PLAN.map((plan) => {
    const position = positionsByToken.get(plan.tokenId);
    if (!position) {
      throw new Error(
        `Settlement queue token ${plan.tokenId} is missing from the live snapshot.`,
      );
    }

    const raw = readRecord(position.raw);
    const actualConditionId = requireString(
      position.conditionId,
      `conditionId for ${plan.tokenId}`,
    );
    if (actualConditionId.toLowerCase() !== plan.conditionId.toLowerCase()) {
      throw new Error(
        `Settlement mapping mismatch for ${plan.tokenId}: expected condition ${plan.conditionId}, got ${actualConditionId}.`,
      );
    }

    const actualSlug =
      typeof raw?.slug === 'string' && raw.slug.trim().length > 0 ? raw.slug : null;
    if (actualSlug !== plan.slug) {
      throw new Error(
        `Settlement mapping mismatch for ${plan.tokenId}: expected slug ${plan.slug}, got ${actualSlug ?? 'null'}.`,
      );
    }

    const actualOutcome =
      typeof raw?.outcome === 'string' && raw.outcome.trim().length > 0
        ? raw.outcome
        : null;
    if (actualOutcome !== plan.expectedOutcome) {
      throw new Error(
        `Settlement mapping mismatch for ${plan.tokenId}: expected outcome ${plan.expectedOutcome}, got ${actualOutcome ?? 'null'}.`,
      );
    }

    if (raw?.redeemable !== true) {
      throw new Error(
        `Settlement queue token ${plan.tokenId} is not redeemable in the refreshed live snapshot.`,
      );
    }

    const note =
      plan.tokenId ===
      '67281714353300008594562642562196151253012217614869999280396248803562519337121'
        ? 'Winner-only SAFE-mode CTF redeem with indexSets=[1]. This does not touch loser residue 595259...8417 because that residue maps to indexSets=[2].'
        : `Winner-only SAFE-mode CTF redeem with indexSets=[${plan.indexSets.join(',')}].`;

    return {
      tokenId: plan.tokenId,
      shortTokenId: shortTokenId(plan.tokenId),
      conditionId: plan.conditionId,
      title: String(raw?.title ?? 'unknown market'),
      slug: actualSlug,
      venueOutcome: actualOutcome,
      size: position.size,
      avgPrice: position.avgPrice,
      currentPrice: position.currentPrice,
      currentValue: position.currentValue,
      redeemable: true,
      mergeable: raw?.mergeable === true,
      expectedClaimAmount: position.size,
      indexSets: [...plan.indexSets],
      primitive: 'ctf_redeem',
      likelySideNeeded: 'none',
      actionType: 'redeem_claim',
      note,
    };
  });
}

function buildReconciliationResidues(
  positionsByToken: Map<string, ExternalPortfolioPositionSnapshot>,
): TokenPlanEntry[] {
  return RECONCILIATION_ONLY_RESIDUE_TOKENS.map((tokenId) => {
    const position = positionsByToken.get(tokenId);
    if (!position) {
      throw new Error(
        `Reconciliation residue token ${tokenId} is missing from the live snapshot.`,
      );
    }

    const raw = readRecord(position.raw);
    const note =
      tokenId ===
      '59525972398225200784927159870783276179597329106059833611053825332303006648417'
        ? 'Zero-value losing remnant on the same condition as winning token 672817...7121. This pass leaves it untouched and reconciliation-only.'
        : 'Zero-value resolved remnant. Reconcile locally; do not submit orders.';

    return {
      tokenId,
      shortTokenId: shortTokenId(tokenId),
      conditionId: requireString(position.conditionId, `conditionId for ${tokenId}`),
      title: String(raw?.title ?? 'unknown market'),
      slug: typeof raw?.slug === 'string' ? raw.slug : null,
      venueOutcome: typeof raw?.outcome === 'string' ? raw.outcome : null,
      size: position.size,
      avgPrice: position.avgPrice,
      currentPrice: position.currentPrice,
      currentValue: position.currentValue,
      redeemable: raw?.redeemable === true,
      mergeable: raw?.mergeable === true,
      expectedClaimAmount: null,
      indexSets: [],
      primitive: 'ctf_redeem',
      likelySideNeeded: 'none',
      actionType:
        raw?.mergeable === true ? 'merge_or_reconcile' : 'reconcile_zero_value',
      note,
    };
  });
}

function buildSnapshotDiff(
  current: ExternalPortfolioSnapshot,
  priorCheckpointSnapshot: Record<string, unknown> | null,
  priorCheckpointProcessedAt: string | null,
): SnapshotDiff {
  const currentPositions = buildPositionMap(current.positions.current);
  const previousPositions = new Map<string, Record<string, unknown>>();
  const priorPositionsRecord = readRecord(priorCheckpointSnapshot?.positions);
  const previousCurrentRaw = priorPositionsRecord?.current;
  const previousCurrent = Array.isArray(previousCurrentRaw)
    ? (previousCurrentRaw as Array<Record<string, unknown>>)
    : [];

  for (const entry of previousCurrent) {
    const tokenId = typeof entry.tokenId === 'string' ? entry.tokenId : null;
    if (tokenId) {
      previousPositions.set(tokenId, entry);
    }
  }

  const currentTokens = [...currentPositions.keys()].sort();
  const previousTokens = [...previousPositions.keys()].sort();
  const previousTokenSet = new Set(previousTokens);
  const currentTokenSet = new Set(currentTokens);

  const addedTokens = currentTokens.filter((tokenId) => !previousTokenSet.has(tokenId));
  const removedTokens = previousTokens.filter((tokenId) => !currentTokenSet.has(tokenId));

  const changedTokens: SnapshotDiffEntry[] = [];
  for (const tokenId of currentTokens) {
    const currentPosition = currentPositions.get(tokenId);
    const previousPosition = previousPositions.get(tokenId);
    if (!currentPosition || !previousPosition) {
      continue;
    }

    const previousSize = readNumber(previousPosition.size) ?? 0;
    const previousCurrentPrice = readNumber(previousPosition.currentPrice);
    const previousCurrentValue = readNumber(previousPosition.currentValue);

    if (
      Math.abs(currentPosition.size - previousSize) <= 1e-9 &&
      currentPosition.currentPrice === previousCurrentPrice &&
      currentPosition.currentValue === previousCurrentValue
    ) {
      continue;
    }

    changedTokens.push({
      tokenId,
      shortTokenId: shortTokenId(tokenId),
      previousSize,
      currentSize: currentPosition.size,
      previousCurrentPrice,
      currentCurrentPrice: currentPosition.currentPrice,
      previousCurrentValue,
      currentCurrentValue: currentPosition.currentValue,
    });
  }

  return {
    previousCheckpointProcessedAt: priorCheckpointProcessedAt,
    addedTokens,
    removedTokens,
    changedTokens,
  };
}

function assertOpenOrders(snapshot: ExternalPortfolioSnapshot): void {
  if (snapshot.workingOpenOrders !== 0 || snapshot.openOrders.length !== 0) {
    throw new Error(
      `Aborting because openOrders != 0. workingOpenOrders=${snapshot.workingOpenOrders}, openOrders=${snapshot.openOrders.length}`,
    );
  }
}

function assertExpectedTokenSet(snapshot: ExternalPortfolioSnapshot): void {
  const actualTokens = new Set(
    snapshot.positions.current.map((position) => position.tokenId),
  );
  const missing = EXPECTED_POSITION_TOKENS.filter((tokenId) => !actualTokens.has(tokenId));
  const unexpected = [...actualTokens].filter(
    (tokenId) =>
      !EXPECTED_POSITION_TOKENS.includes(
        tokenId as (typeof EXPECTED_POSITION_TOKENS)[number],
      ),
  );

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Aborting because the resolved residual token set changed. missing=${missing.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'}`,
    );
  }

  if (snapshot.positions.current.length !== EXPECTED_POSITION_TOKENS.length) {
    throw new Error(
      `Aborting because residual position count changed. expected=${EXPECTED_POSITION_TOKENS.length} actual=${snapshot.positions.current.length}`,
    );
  }
}

function requireExecuteGuards(
  args: ParsedArgs,
  currentSnapshotHash: string,
  expectedAccount: string,
  confirmationString: string,
): { latestDryRun: Record<string, unknown> } {
  if (!args.execute) {
    throw new Error('Internal error: execute guards requested without --execute.');
  }

  const normalizedAccount = normalizeAccount(args.account);
  if (!normalizedAccount || normalizedAccount !== expectedAccount) {
    throw new Error(`Execution refused: --account must exactly match ${expectedAccount}.`);
  }

  if (args.confirm !== confirmationString) {
    throw new Error(
      `Execution refused: --confirm must exactly match "${confirmationString}".`,
    );
  }

  if (!args.snapshotHash) {
    throw new Error('Execution refused: --snapshot-hash is required.');
  }

  const latestDryRun = readJsonFile<Record<string, unknown>>(LATEST_DRY_RUN_PATH);
  if (!latestDryRun) {
    throw new Error('Execution refused: no prior dry-run artifact was found.');
  }

  const latestDryRunMode = latestDryRun.mode;
  if (latestDryRunMode !== 'dry_run') {
    throw new Error('Execution refused: latest dry-run artifact is invalid.');
  }

  const latestDryRunHash =
    typeof latestDryRun.snapshotHash === 'string' ? latestDryRun.snapshotHash : null;
  if (!latestDryRunHash || latestDryRunHash !== args.snapshotHash) {
    throw new Error(
      'Execution refused: --snapshot-hash does not match the immediately preceding dry run.',
    );
  }

  if (currentSnapshotHash !== args.snapshotHash) {
    throw new Error(
      'Execution refused: refreshed live snapshot hash does not match the dry-run hash.',
    );
  }

  return { latestDryRun };
}

function buildSkippedTokenResults(
  settlementQueue: TokenPlanEntry[],
  reason: string,
): TokenExecutionResult[] {
  return settlementQueue.map((entry) => ({
    tokenId: entry.tokenId,
    shortTokenId: entry.shortTokenId,
    conditionId: entry.conditionId,
    indexSets: [...entry.indexSets],
    actionType: entry.actionType,
    status: 'skipped',
    expectedClaimAmount: entry.expectedClaimAmount,
    claimedAmount: null,
    relayerTransactionId: null,
    initialState: null,
    finalState: null,
    transactionHash: null,
    stateTransitions: [],
    reason,
  }));
}

function buildTokenExecutionResult(
  entry: TokenPlanEntry,
  execution: CtfRedeemExecutionResult,
): TokenExecutionResult {
  const status: TokenExecutionResult['status'] =
    execution.finalState === 'STATE_CONFIRMED' ? 'claimed' : 'failed';

  return {
    tokenId: entry.tokenId,
    shortTokenId: entry.shortTokenId,
    conditionId: entry.conditionId,
    indexSets: [...entry.indexSets],
    actionType: entry.actionType,
    status,
    expectedClaimAmount: entry.expectedClaimAmount,
    claimedAmount: execution.claimedAmount,
    relayerTransactionId: execution.transactionId,
    initialState: execution.initialState,
    finalState: execution.finalState,
    transactionHash: execution.transactionHash,
    stateTransitions: execution.stateTransitions,
    reason:
      execution.reason ??
      (status === 'claimed'
        ? 'Claim confirmed through SAFE-mode relayer settlement.'
        : 'Claim submission failed.'),
  };
}

function buildFailureResult(entry: TokenPlanEntry, reason: string): TokenExecutionResult {
  return {
    tokenId: entry.tokenId,
    shortTokenId: entry.shortTokenId,
    conditionId: entry.conditionId,
    indexSets: [...entry.indexSets],
    actionType: entry.actionType,
    status: 'failed',
    expectedClaimAmount: entry.expectedClaimAmount,
    claimedAmount: null,
    relayerTransactionId: null,
    initialState: null,
    finalState: null,
    transactionHash: null,
    stateTransitions: [],
    reason,
  };
}

function isGlobalExecutionBlocker(reason: string): boolean {
  return /authorization|auth|builder|relayer|POLY_RELAYER_URL|SAFE settlement requires|cannot initialize/i.test(
    reason,
  );
}

function summarizePostExecutionSnapshot(
  snapshot: ExternalPortfolioSnapshot | null,
): Record<string, unknown> | null {
  if (!snapshot) {
    return null;
  }

  const positionsByToken = buildPositionMap(snapshot.positions.current);
  return {
    workingOpenOrders: snapshot.workingOpenOrders,
    openOrders: snapshot.openOrders.length,
    positionCount: snapshot.positions.current.length,
    claimedWinningTokensRemaining: SETTLEMENT_EXECUTION_PLAN.map((entry) => ({
      tokenId: entry.tokenId,
      present: positionsByToken.has(entry.tokenId),
      size: positionsByToken.get(entry.tokenId)?.size ?? null,
    })),
    remainingReconciliationResidues: RECONCILIATION_ONLY_RESIDUE_TOKENS.map((tokenId) => ({
      tokenId,
      present: positionsByToken.has(tokenId),
      size: positionsByToken.get(tokenId)?.size ?? null,
    })),
  };
}

function buildExecutionSummary(
  results: TokenExecutionResult[],
  reconciliationResidues: TokenPlanEntry[],
): Record<string, unknown> {
  const claimed = results.filter((entry) => entry.status === 'claimed');
  const failed = results.filter((entry) => entry.status === 'failed');
  const skipped = results.filter((entry) => entry.status === 'skipped');

  return {
    attemptedTokenCount: claimed.length + failed.length,
    claimedTokenCount: claimed.length,
    failedTokenCount: failed.length,
    skippedTokenCount: skipped.length,
    totalClaimedAmount: claimed.reduce(
      (total, entry) => total + (entry.claimedAmount ?? 0),
      0,
    ),
    failuresByToken: failed,
    skippedByToken: skipped,
    remainingReconciliationResidues: reconciliationResidues.map((entry) => ({
      tokenId: entry.tokenId,
      shortTokenId: entry.shortTokenId,
      actionType: entry.actionType,
    })),
  };
}

function buildSettlementClient(): OfficialPolymarketSettlementClient {
  return new OfficialPolymarketSettlementClient({
    relayerUrl: appEnv.POLY_RELAYER_URL ?? null,
    chainId: appEnv.POLY_CHAIN_ID,
    privateKey: appEnv.POLY_PRIVATE_KEY ?? '',
    signatureType: appEnv.POLY_SIGNATURE_TYPE,
    funder: appEnv.POLY_FUNDER ?? null,
    profileAddress: appEnv.POLY_PROFILE_ADDRESS ?? null,
    builderApiKey: appEnv.POLY_BUILDER_API_KEY ?? null,
    builderSecret: appEnv.POLY_BUILDER_SECRET ?? null,
    builderPassphrase: appEnv.POLY_BUILDER_PASSPHRASE ?? null,
    builderRemoteUrl: appEnv.POLY_BUILDER_REMOTE_URL ?? null,
    builderRemoteToken: appEnv.POLY_BUILDER_REMOTE_TOKEN ?? null,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode: CommandMode = args.execute ? 'execute' : 'dry_run';
  const prisma = new PrismaClient();

  try {
    const prismaAny = prisma as PrismaClient & {
      reconciliationCheckpoint?: {
        findFirst: (input: Record<string, unknown>) => Promise<{
          processedAt: Date;
          details?: Record<string, unknown> | null;
        } | null>;
      };
    };

    const priorCheckpoint =
      (await prismaAny.reconciliationCheckpoint?.findFirst({
        where: { source: 'startup_runbook_external_truth' },
        orderBy: { processedAt: 'desc' },
      })) ?? null;
    const priorDetails = readRecord(priorCheckpoint?.details);
    const priorSnapshot = readRecord(priorDetails?.snapshot);

    const externalPortfolioService = new ExternalPortfolioService(prisma);
    const liveSnapshot = await externalPortfolioService.capture({
      persist: false,
      source: 'settlement_reconciliation_dry_run',
      cycleKey: `settlement-reconciliation:${Date.now()}`,
    });

    const expectedAccount = resolveExpectedAccount(liveSnapshot);
    const confirmationString = `settle 11 resolved residual positions for ${expectedAccount}`;

    assertOpenOrders(liveSnapshot);
    assertExpectedTokenSet(liveSnapshot);

    const positionsByToken = buildPositionMap(liveSnapshot.positions.current);
    const settlementQueue = buildSettlementQueue(positionsByToken);
    const reconciliationResidues = buildReconciliationResidues(positionsByToken);
    const historicalOnlyTrades = buildHistoricalOnlyTrades(liveSnapshot);

    const historicalTrade204699 = historicalOnlyTrades.find(
      (entry) => entry.tokenId === HISTORICAL_ONLY_TRADE_TOKEN,
    );
    if (!historicalTrade204699) {
      throw new Error(
        `Aborting because historical-only trade ${HISTORICAL_ONLY_TRADE_TOKEN} is no longer present in live trade history.`,
      );
    }

    const settlementClient = buildSettlementClient();
    const settlementExecutorReadiness =
      await settlementClient.validateInitialization(expectedAccount);

    const snapshotSummary = {
      account: expectedAccount,
      positionTokens: [...EXPECTED_POSITION_TOKENS],
      workingOpenOrders: liveSnapshot.workingOpenOrders,
      openOrders: liveSnapshot.openOrders.length,
      settlementQueue: settlementQueue.map((entry) => ({
        tokenId: entry.tokenId,
        conditionId: entry.conditionId,
        indexSets: entry.indexSets,
        expectedClaimAmount: entry.expectedClaimAmount,
        actionType: entry.actionType,
      })),
      reconciliationResidues: reconciliationResidues.map((entry) => ({
        tokenId: entry.tokenId,
        size: entry.size,
        currentValue: entry.currentValue,
        actionType: entry.actionType,
      })),
      historicalOnlyTrades: historicalOnlyTrades.map((entry) => ({
        tokenId: entry.tokenId,
        buyQty: entry.buyQty,
        sellQty: entry.sellQty,
        netQty: entry.netQty,
      })),
      canonicalPositions: canonicalizePositions(liveSnapshot.positions.current),
    };

    const snapshotHash = createSnapshotHash(snapshotSummary);
    const snapshotDiff = buildSnapshotDiff(
      liveSnapshot,
      priorSnapshot,
      priorCheckpoint?.processedAt?.toISOString?.() ?? null,
    );

    const basePayload = {
      mode,
      generatedAt: new Date().toISOString(),
      account: expectedAccount,
      confirmationString,
      dryRunOnly: mode === 'dry_run',
      settlementExecutorReadiness,
      venueMutationSafety: {
        postOrderCalled: false,
        cancelOrderCalled: false,
        note:
          'This command never submits or cancels venue orders. Execute mode only submits SAFE-mode relayer settlement transactions for the 4 proven winning CTF positions.',
      },
      snapshotHash,
      snapshotDiff,
      expectedTokenCount: EXPECTED_POSITION_TOKENS.length,
      liveSnapshot: {
        capturedAt: null,
        workingOpenOrders: liveSnapshot.workingOpenOrders,
        openOrders: liveSnapshot.openOrders.length,
        positionCount: liveSnapshot.positions.current.length,
      },
      settlementQueue,
      reconciliationResidues,
      historicalOnlyTrades,
      highlightedHistoricalOnlyTrade: historicalTrade204699,
      safetyChecks: {
        openOrdersMustBeZero: true,
        workingOpenOrdersMustBeZero: true,
        tokenSetMustMatchExpectedResidualSet: true,
        executeRequiresFlag: true,
        executeRequiresExactAccount: true,
        executeRequiresExactConfirmationString: true,
        executeRequiresSnapshotHash: true,
        executeRequiresHashMatchWithImmediatelyPrecedingDryRun: true,
      },
    } as Record<string, unknown>;

    const timestamp = String(basePayload.generatedAt).replace(/[:.]/g, '-');
    const dryRunHistoryPath = path.join(HISTORY_DIR, `${timestamp}.dry-run.json`);

    if (mode === 'dry_run') {
      const dryRunPayload = {
        ...basePayload,
        perTokenExecutionResults: buildSkippedTokenResults(
          settlementQueue,
          'Dry run only. No settlement transaction submitted.',
        ),
      };
      writeArtifact(LATEST_DRY_RUN_PATH, dryRunPayload);
      writeArtifact(dryRunHistoryPath, dryRunPayload);
      process.stdout.write(`${JSON.stringify(dryRunPayload, null, 2)}\n`);
      return;
    }

    const { latestDryRun } = requireExecuteGuards(
      args,
      snapshotHash,
      expectedAccount,
      confirmationString,
    );

    let perTokenExecutionResults = buildSkippedTokenResults(
      settlementQueue,
      'Settlement execution was not attempted.',
    );
    let executionStatus = 'blocked';
    let executeResult = 'blocked_auth_validation_failed';
    let executionNote = '';
    let postExecutionSnapshot: ExternalPortfolioSnapshot | null = null;

    if (!settlementExecutorReadiness.ready) {
      perTokenExecutionResults = buildSkippedTokenResults(
        settlementQueue,
        `Settlement auth/config is not ready: ${settlementExecutorReadiness.reason}`,
      );
      executionNote = `Execution refused before submission: ${settlementExecutorReadiness.reason}`;
    } else {
      const results: TokenExecutionResult[] = [];
      let globalAbortReason: string | null = null;

      for (const entry of settlementQueue) {
        if (globalAbortReason) {
          results.push({
            ...buildSkippedTokenResults(settlementQueue, globalAbortReason).find(
              (item) => item.tokenId === entry.tokenId,
            )!,
            reason: globalAbortReason,
          });
          continue;
        }

        try {
          const execution = await settlementClient.redeemCtfPosition({
            tokenId: entry.tokenId,
            conditionId: entry.conditionId,
            indexSets: entry.indexSets,
            expectedClaimAmount: entry.expectedClaimAmount,
            metadata: `resolved_residual_redeem:${entry.tokenId}`,
            collateralToken: COLLATERAL_TOKEN_ADDRESS,
            parentCollectionId: ZERO_PARENT_COLLECTION_ID,
            ctfContractAddress: CTF_CONTRACT_ADDRESS,
          });
          const result = buildTokenExecutionResult(entry, execution);
          results.push(result);
          if (result.status === 'failed' && isGlobalExecutionBlocker(result.reason)) {
            globalAbortReason = `Execution aborted after ${entry.shortTokenId}: ${result.reason}`;
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const result = buildFailureResult(entry, reason);
          results.push(result);
          if (isGlobalExecutionBlocker(reason)) {
            globalAbortReason = `Execution aborted after ${entry.shortTokenId}: ${reason}`;
          }
        }
      }

      perTokenExecutionResults = results;
      const claimedCount = results.filter((entry) => entry.status === 'claimed').length;
      const failedCount = results.filter((entry) => entry.status === 'failed').length;
      const skippedCount = results.filter((entry) => entry.status === 'skipped').length;

      if (claimedCount === settlementQueue.length) {
        executionStatus = 'claimed';
        executeResult = 'claimed';
        executionNote =
          'All 4 winning resolved positions were submitted and confirmed through SAFE-mode relayer settlement.';
      } else if (claimedCount > 0 && (failedCount > 0 || skippedCount > 0)) {
        executionStatus = 'partial';
        executeResult = 'partial';
        executionNote =
          'Settlement execution completed with a mix of confirmed claims and failures/skips. See per-token relayer results.';
      } else if (failedCount > 0) {
        executionStatus = 'failed';
        executeResult = 'failed';
        executionNote =
          'Settlement execution reached the relayer but no full 4-token success occurred. See per-token relayer results.';
      } else {
        executionStatus = 'blocked';
        executeResult = 'blocked';
        executionNote =
          'Settlement execution did not submit any claim successfully. See per-token reasons.';
      }

      postExecutionSnapshot = await externalPortfolioService.capture({
        persist: false,
        source: 'settlement_reconciliation_execute_post',
        cycleKey: `settlement-reconciliation-post:${Date.now()}`,
      });
    }

    const executePayload = {
      ...basePayload,
      latestDryRunGeneratedAt:
        typeof latestDryRun.generatedAt === 'string' ? latestDryRun.generatedAt : null,
      executeAcknowledged: true,
      executeResult,
      executionStatus,
      executionNote,
      perTokenExecutionResults,
      executionSummary: buildExecutionSummary(
        perTokenExecutionResults,
        reconciliationResidues,
      ),
      postExecutionSnapshot: summarizePostExecutionSnapshot(postExecutionSnapshot),
    };

    const executeHistoryPath = path.join(HISTORY_DIR, `${timestamp}.execute.json`);
    writeArtifact(LATEST_EXECUTE_PATH, executePayload);
    writeArtifact(LEGACY_LATEST_EXECUTE_PATH, executePayload);
    writeArtifact(executeHistoryPath, executePayload);
    process.stdout.write(`${JSON.stringify(executePayload, null, 2)}\n`);
    if (executionStatus !== 'claimed') {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
