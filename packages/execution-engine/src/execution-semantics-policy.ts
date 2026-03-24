export type ExecutionAction = 'ENTER' | 'REDUCE' | 'EXIT';
export type OrderUrgency = 'low' | 'medium' | 'high';
export type ExecutionStyle = 'rest' | 'cross';
export type OrderType = 'GTC' | 'GTD' | 'FOK' | 'FAK';
export type PartialFillTolerance = 'allow_partial' | 'all_or_nothing';
export type ExecutionRoute = 'maker' | 'taker';

export interface ExecutionSemanticsPolicyInput {
  action: ExecutionAction;
  urgency: OrderUrgency;
  size: number;
  executableDepth?: number | null;
  expiryAt: string;
  now?: string | null;
  noTradeWindowSeconds: number;
  partialFillTolerance?: PartialFillTolerance | null;
  preferResting?: boolean | null;
  executionStyle?: ExecutionStyle | null;
  gtdMinLifetimeMs?: number;
  defaultGtdLifetimeMs?: number;
}

export interface ExecutionSemanticsPolicyResult {
  orderType: OrderType;
  executionStyle: ExecutionStyle;
  route: ExecutionRoute;
  expiration: string | null;
  timeDiscipline: 'open_ended' | 'deadline' | 'immediate';
  partialFillTolerance: PartialFillTolerance;
  allowedOrderTypes: OrderType[];
  reasonCode: string;
  reasonMessage: string;
}

export class ExecutionSemanticsPolicy {
  evaluate(input: ExecutionSemanticsPolicyInput): ExecutionSemanticsPolicyResult {
    const partialFillTolerance =
      input.partialFillTolerance ??
      (input.action === 'ENTER' && input.urgency === 'high'
        ? 'all_or_nothing'
        : 'allow_partial');
    const preferResting =
      input.executionStyle === 'rest'
        ? true
        : input.executionStyle === 'cross'
          ? false
          : input.preferResting ??
            (input.action === 'ENTER' &&
              (input.urgency === 'low' || input.urgency === 'medium'));

    if (preferResting) {
      if (input.urgency === 'low') {
        return {
          orderType: 'GTC',
          executionStyle: 'rest',
          route: 'maker',
          expiration: null,
          timeDiscipline: 'open_ended',
          partialFillTolerance,
          allowedOrderTypes: ['GTC', 'GTD'],
          reasonCode: 'passive_open_ended_entry',
          reasonMessage:
            'Execution policy selected passive GTC because the entry is not urgent and is allowed to rest on the book.',
        };
      }

      const expiration = this.computeGtdExpiration(input);
      if (expiration) {
        return {
          orderType: 'GTD',
          executionStyle: 'rest',
          route: 'maker',
          expiration,
          timeDiscipline: 'deadline',
          partialFillTolerance,
          allowedOrderTypes: ['GTD'],
          reasonCode: 'passive_time_boxed_entry',
          reasonMessage:
            'Execution policy selected passive GTD because entry timing matters and a venue-safe deadline is available.',
        };
      }
    }

    const executableDepth = this.normalizePositive(input.executableDepth ?? null);
    const allOrNothing =
      partialFillTolerance === 'all_or_nothing' &&
      executableDepth !== null &&
      executableDepth >= input.size;

    return {
      orderType: allOrNothing ? 'FOK' : 'FAK',
      executionStyle: 'cross',
      route: 'taker',
      expiration: null,
      timeDiscipline: 'immediate',
      partialFillTolerance,
      allowedOrderTypes: allOrNothing ? ['FOK'] : ['FAK', 'FOK'],
      reasonCode: allOrNothing
        ? 'immediate_all_or_nothing_execution'
        : 'immediate_partial_tolerated_execution',
      reasonMessage: allOrNothing
        ? 'Execution policy selected FOK because immediate full execution is required and executable depth appears sufficient.'
        : 'Execution policy selected FAK because the order must execute immediately but partial fill is safer than resting.',
    };
  }

  routeFor(orderType: OrderType): ExecutionRoute {
    return orderType === 'GTC' || orderType === 'GTD' ? 'maker' : 'taker';
  }

  private computeGtdExpiration(input: ExecutionSemanticsPolicyInput): string | null {
    const now = this.resolveNow(input.now ?? null);
    const expiry = new Date(input.expiryAt);
    if (Number.isNaN(expiry.getTime())) {
      return null;
    }

    const gtdMinLifetimeMs = this.normalizePositive(input.gtdMinLifetimeMs ?? null) ?? 60_000;
    const defaultGtdLifetimeMs =
      this.normalizePositive(input.defaultGtdLifetimeMs ?? null) ?? 90_000;
    const latestSafeExpiryMs = expiry.getTime() - input.noTradeWindowSeconds * 1000;
    const requestedExpiryMs = Math.min(now.getTime() + defaultGtdLifetimeMs, latestSafeExpiryMs);

    if (requestedExpiryMs - now.getTime() < gtdMinLifetimeMs) {
      return null;
    }

    return new Date(requestedExpiryMs).toISOString();
  }

  private resolveNow(now: string | null): Date {
    if (!now) {
      return new Date();
    }

    const parsed = new Date(now);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private normalizePositive(value: number | null): number | null {
    return Number.isFinite(value) && (value as number) > 0 ? (value as number) : null;
  }
}
