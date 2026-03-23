export type FundingValidationReasonCode =
  | 'external_portfolio_truth_missing'
  | 'external_portfolio_truth_stale'
  | 'external_portfolio_truth_unhealthy'
  | 'buy_balance_insufficient'
  | 'buy_allowance_insufficient'
  | 'buy_reserved_headroom_exhausted'
  | 'sell_inventory_insufficient'
  | 'sell_allowance_insufficient'
  | 'sell_reserved_inventory_exhausted';

export interface ExternalInventoryAvailability {
  tokenId: string;
  balance: number;
  allowance: number;
  reservedQuantity: number;
  freeQuantityBeforeAllowance?: number;
  freeQuantityAfterAllowance?: number;
  tradableSellHeadroom?: number;
  positionQuantity?: number;
  availableQuantity: number;
}

export interface ExternalPortfolioFundingSnapshot {
  capturedAt: string;
  freshnessState: 'fresh' | 'stale';
  freshnessVerdict?: 'healthy' | 'warning' | 'degraded' | 'stale';
  reconciliationHealth: 'healthy' | 'failed';
  tradingPermissions?: {
    allowNewEntries: boolean;
    allowPositionManagement: boolean;
    reasonCodes: string[];
  };
  cashBalance: number;
  cashAllowance: number;
  reservedCash: number;
  freeCashBeforeAllowance?: number;
  freeCashAfterAllowance?: number;
  tradableBuyHeadroom?: number;
  availableCapital: number;
  inventories: ExternalInventoryAvailability[];
}

export interface PreTradeFundingValidatorInput {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  snapshot: ExternalPortfolioFundingSnapshot | null;
}

export interface PreTradeFundingValidationResult {
  passed: boolean;
  reasonCode: FundingValidationReasonCode | null;
  details: {
    requiredNotional: number;
    requiredSize: number;
    availableCapital: number | null;
    availableInventory: number | null;
  };
}

export class PreTradeFundingValidator {
  validate(input: PreTradeFundingValidatorInput): PreTradeFundingValidationResult {
    const requiredNotional = input.price * input.size;

    if (!input.snapshot) {
      return this.fail(
        'external_portfolio_truth_missing',
        requiredNotional,
        input.size,
        null,
      );
    }

    if (input.snapshot.reconciliationHealth !== 'healthy') {
      return this.fail(
        'external_portfolio_truth_unhealthy',
        requiredNotional,
        input.size,
        null,
      );
    }

    if (input.snapshot.freshnessState !== 'fresh') {
      return this.fail('external_portfolio_truth_stale', requiredNotional, input.size, null);
    }

    if (input.snapshot.tradingPermissions?.allowNewEntries === false) {
      return this.fail(
        'external_portfolio_truth_unhealthy',
        requiredNotional,
        input.size,
        null,
      );
    }

    if (input.side === 'BUY') {
      if (input.snapshot.cashBalance + 1e-9 < requiredNotional) {
        return this.fail(
          'buy_balance_insufficient',
          requiredNotional,
          input.size,
          input.snapshot.availableCapital,
        );
      }

      if (input.snapshot.cashAllowance + 1e-9 < requiredNotional) {
        return this.fail(
          'buy_allowance_insufficient',
          requiredNotional,
          input.size,
          input.snapshot.availableCapital,
        );
      }

      const tradableBuyHeadroom =
        input.snapshot.tradableBuyHeadroom ?? input.snapshot.availableCapital;

      if (tradableBuyHeadroom + 1e-9 < requiredNotional) {
        return this.fail(
          'buy_reserved_headroom_exhausted',
          requiredNotional,
          input.size,
          tradableBuyHeadroom,
        );
      }

      return {
        passed: true,
        reasonCode: null,
        details: {
          requiredNotional,
          requiredSize: input.size,
          availableCapital: input.snapshot.availableCapital,
          availableInventory: null,
        },
      };
    }

    const inventory =
      input.snapshot.inventories.find((entry) => entry.tokenId === input.tokenId) ?? null;
    if (!inventory || inventory.balance + 1e-9 < input.size) {
      return this.fail('sell_inventory_insufficient', requiredNotional, input.size, inventory);
    }

    if (inventory.allowance + 1e-9 < input.size) {
      return this.fail('sell_allowance_insufficient', requiredNotional, input.size, inventory);
    }

    const tradableSellHeadroom =
      inventory.tradableSellHeadroom ?? inventory.availableQuantity;

    if (tradableSellHeadroom + 1e-9 < input.size) {
      return this.fail(
        'sell_reserved_inventory_exhausted',
        requiredNotional,
        input.size,
        inventory,
      );
    }

    return {
      passed: true,
      reasonCode: null,
      details: {
        requiredNotional,
        requiredSize: input.size,
        availableCapital: input.snapshot.availableCapital,
        availableInventory: tradableSellHeadroom,
      },
    };
  }

  private fail(
    reasonCode: FundingValidationReasonCode,
    requiredNotional: number,
    requiredSize: number,
    availability: ExternalInventoryAvailability | number | null,
  ): PreTradeFundingValidationResult {
    return {
      passed: false,
      reasonCode,
      details: {
        requiredNotional,
        requiredSize,
        availableCapital: typeof availability === 'number' ? availability : null,
        availableInventory:
          typeof availability === 'object' && availability
            ? availability.tradableSellHeadroom ?? availability.availableQuantity
            : null,
      },
    };
  }
}
