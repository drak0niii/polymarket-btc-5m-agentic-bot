interface MarketItem {
  id: string;
  title: string;
  status: string;
}

interface SignalItem {
  id: string;
  status: string;
  edge: number;
}

interface OrderItem {
  id: string;
  status: string;
  side: string;
}

interface PortfolioItem {
  bankroll: number;
  availableCapital: number;
}

export interface SceneDistrictState {
  id: string;
  label: string;
  value: string;
}

export function mapDashboardToSceneState(params: {
  markets: MarketItem[];
  signals: SignalItem[];
  orders: OrderItem[];
  portfolio: PortfolioItem | null;
}): SceneDistrictState[] {
  const latestSignal = params.signals[0];
  const latestOrder = params.orders[0];

  return [
    {
      id: 'market-discovery',
      label: 'market discovery',
      value: `${params.markets.length} markets`,
    },
    {
      id: 'signal-engine',
      label: 'signal engine',
      value: latestSignal
        ? `${latestSignal.status} · edge ${latestSignal.edge.toFixed(4)}`
        : 'no signals',
    },
    {
      id: 'execution-engine',
      label: 'execution engine',
      value: latestOrder
        ? `${latestOrder.side} · ${latestOrder.status}`
        : 'no orders',
    },
    {
      id: 'portfolio',
      label: 'portfolio',
      value: params.portfolio
        ? `bankroll ${params.portfolio.bankroll.toFixed(2)}`
        : 'no portfolio',
    },
  ];
}