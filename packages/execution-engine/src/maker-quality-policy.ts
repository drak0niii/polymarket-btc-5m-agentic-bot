export interface VenueRewardToken {
  tokenId: string;
  outcome?: string | null;
  price?: number | null;
}

export interface VenueRewardConfig {
  ratePerDay?: number | null;
  totalRewards?: number | null;
}

export interface VenueRewardMarket {
  conditionId: string;
  rewardsMaxSpread: number | null;
  rewardsMinSize: number | null;
  tokens: VenueRewardToken[];
  rewardsConfig?: VenueRewardConfig[] | null;
}

export interface MakerQualityPolicyInput {
  route: 'maker' | 'taker';
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  bestBid: number | null;
  bestAsk: number | null;
  tickSize: number | null;
  rewardsMarkets?: VenueRewardMarket[] | null;
}

export interface MakerQualityPolicyResult {
  applicable: boolean;
  relevance: 'none' | 'low' | 'medium' | 'high';
  scoringRelevant: boolean;
  rewardsRelevant: boolean;
  eligibleForRewards: boolean | null;
  makerEfficient: boolean;
  rewardsConditionId: string | null;
  quoteDistanceToTopTicks: number | null;
  observedSpread: number | null;
  reasonCode: string;
  reasonMessage: string;
}

export class MakerQualityPolicy {
  evaluate(input: MakerQualityPolicyInput): MakerQualityPolicyResult {
    if (input.route !== 'maker') {
      return {
        applicable: false,
        relevance: 'none',
        scoringRelevant: false,
        rewardsRelevant: false,
        eligibleForRewards: null,
        makerEfficient: false,
        rewardsConditionId: null,
        quoteDistanceToTopTicks: null,
        observedSpread: this.resolveSpread(input.bestBid, input.bestAsk),
        reasonCode: 'maker_quality_not_applicable',
        reasonMessage: 'Immediate taker execution does not consult maker-quality scoring.',
      };
    }

    const rewardMarket =
      input.rewardsMarkets?.find((market) =>
        market.tokens.some((token) => token.tokenId === input.tokenId),
      ) ?? null;
    const topOfBook = this.resolveTopOfBook(input.side, input.bestBid, input.bestAsk);
    const observedSpread = this.resolveSpread(input.bestBid, input.bestAsk);
    const quoteDistanceToTopTicks =
      topOfBook !== null && input.tickSize && input.tickSize > 0
        ? Math.abs(input.price - topOfBook) / input.tickSize
        : null;

    if (!rewardMarket) {
      return {
        applicable: true,
        relevance: 'low',
        scoringRelevant: false,
        rewardsRelevant: false,
        eligibleForRewards: null,
        makerEfficient:
          quoteDistanceToTopTicks !== null ? quoteDistanceToTopTicks <= 1 + 1e-9 : false,
        rewardsConditionId: null,
        quoteDistanceToTopTicks,
        observedSpread,
        reasonCode: 'maker_rewards_not_available',
        reasonMessage:
          'Passive execution is allowed, but no current rewards configuration was available for this token.',
      };
    }

    const sizeEligible =
      rewardMarket.rewardsMinSize == null ? true : input.size >= rewardMarket.rewardsMinSize;
    const spreadEligible =
      rewardMarket.rewardsMaxSpread == null || observedSpread == null
        ? true
        : observedSpread <= rewardMarket.rewardsMaxSpread;
    const touchEligible =
      quoteDistanceToTopTicks !== null ? quoteDistanceToTopTicks <= 1 + 1e-9 : false;
    const eligibleForRewards = sizeEligible && spreadEligible;
    const makerEfficient = eligibleForRewards && touchEligible;

    return {
      applicable: true,
      relevance: makerEfficient ? 'high' : eligibleForRewards ? 'medium' : 'low',
      scoringRelevant: true,
      rewardsRelevant: true,
      eligibleForRewards,
      makerEfficient,
      rewardsConditionId: rewardMarket.conditionId,
      quoteDistanceToTopTicks,
      observedSpread,
      reasonCode: makerEfficient ? 'maker_quality_reward_efficient' : 'maker_quality_reward_limited',
      reasonMessage: makerEfficient
        ? 'Passive quote is close enough to top-of-book and satisfies current reward market constraints.'
        : 'Passive quote is reward-aware, but spread, size, or quote placement is unlikely to qualify as efficient maker liquidity.',
    };
  }

  private resolveTopOfBook(
    side: 'BUY' | 'SELL',
    bestBid: number | null,
    bestAsk: number | null,
  ): number | null {
    if (side === 'BUY') {
      return Number.isFinite(bestBid) && (bestBid as number) > 0 ? (bestBid as number) : null;
    }

    return Number.isFinite(bestAsk) && (bestAsk as number) > 0 ? (bestAsk as number) : null;
  }

  private resolveSpread(bestBid: number | null, bestAsk: number | null): number | null {
    if (
      !Number.isFinite(bestBid) ||
      !Number.isFinite(bestAsk) ||
      (bestBid as number) <= 0 ||
      (bestAsk as number) <= 0
    ) {
      return null;
    }

    return Math.max(0, (bestAsk as number) - (bestBid as number));
  }
}
