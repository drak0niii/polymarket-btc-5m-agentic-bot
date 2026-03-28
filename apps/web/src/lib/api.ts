const API_BASE = 'http://127.0.0.1:3000/api/v1';

export type TradingOperatingMode = 'sentinel_simulation' | 'live_trading';

export interface SentinelStatusResponse {
  updatedAt: string;
  recommendationState: 'not_ready' | 'ready_to_consider_live';
  recommendationMessage: string;
  simulatedTradesCompleted: number;
  simulatedTradesLearned: number;
  targetSimulatedTrades: number;
  targetLearnedTrades: number;
  readinessScore: number;
  readinessThreshold: number;
  expectedVsRealizedEdgeGapBps: number;
  fillQualityPassRate: number;
  noTradeDisciplinePassRate: number;
  learningCoverage: number;
  unresolvedAnomalyCount: number;
  recommendedLiveEnable: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export const apiClient = {
  getBotState() {
    return request<{
      state:
        | 'bootstrapping'
        | 'running'
        | 'degraded'
        | 'reconciliation_only'
        | 'cancel_only'
        | 'halted_hard'
        | 'stopped';
      liveConfig: {
        maxOpenPositions: number;
        maxDailyLossPct: number;
        maxPerTradeRiskPct: number;
        maxKellyFraction: number;
        maxConsecutiveLosses: number;
        noTradeWindowSeconds: number;
        evaluationIntervalMs: number;
        orderReconcileIntervalMs: number;
        portfolioRefreshIntervalMs: number;
      };
      operatingMode: TradingOperatingMode;
      sentinelEnabled: boolean;
      recommendedLiveEnable: boolean;
      sentinelStatus: SentinelStatusResponse | null;
      lastTransitionAt: string | null;
      lastTransitionReason: string | null;
      readiness: {
        ready: boolean;
        checks: {
          env: boolean;
          signing: boolean;
          credentials: boolean;
          liveMode: boolean;
          riskConfig: boolean;
        };
      };
    }>('/bot-control/state');
  },

  getOperatingMode() {
    return request<{
      operatingMode: TradingOperatingMode;
      sentinelEnabled: boolean;
      eligibleForLiveTrading: boolean;
      warningText: string | null;
      sentinelStatus: SentinelStatusResponse | null;
    }>('/bot-control/mode');
  },

  setOperatingMode(body: {
    operatingMode: TradingOperatingMode;
    requestedBy?: string;
  }) {
    return request<{
      operatingMode: TradingOperatingMode;
      sentinelEnabled: boolean;
      eligibleForLiveTrading: boolean;
      warningText: string | null;
      sentinelStatus: SentinelStatusResponse | null;
    }>('/bot-control/mode', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  startBot(body: {
    reason?: string;
    requestedBy?: string;
  }) {
    return request('/bot-control/start', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  stopBot(body: {
    reason?: string;
    requestedBy?: string;
    cancelOpenOrders?: boolean;
  }) {
    return request('/bot-control/stop', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  haltBot(body: {
    reason?: string;
    requestedBy?: string;
    cancelOpenOrders?: boolean;
  }) {
    return request('/bot-control/halt', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  getMarkets() {
    return request<
      Array<{
        id: string;
        slug: string;
        title: string;
        status: string;
        tokenIdYes: string | null;
        tokenIdNo: string | null;
        resolutionSource: string | null;
        createdAt: string;
        updatedAt: string;
      }>
    >('/markets');
  },

  getSignals() {
    return request<
      Array<{
        id: string;
        marketId: string;
        strategyVersionId: string | null;
        side: string;
        priorProbability: number;
        posteriorProbability: number;
        marketImpliedProb: number;
        edge: number;
        expectedEv: number;
        regime: string | null;
        status: string;
        observedAt: string;
        createdAt: string;
      }>
    >('/signals');
  },

  getOrders() {
    return request<
      Array<{
        id: string;
        marketId: string;
        signalId: string | null;
        strategyVersionId: string | null;
        status: string;
        side: string;
        price: number;
        size: number;
        expectedEv: number | null;
        postedAt: string | null;
        acknowledgedAt: string | null;
        canceledAt: string | null;
        createdAt: string;
        updatedAt: string;
      }>
    >('/orders');
  },

  getPortfolio() {
    return request<{
      id: string;
      bankroll: number;
      availableCapital: number;
      openExposure: number;
      realizedPnlDay: number;
      unrealizedPnl: number;
      consecutiveLosses: number;
      capturedAt: string;
      createdAt: string;
    }>('/portfolio');
  },

  getAuditEvents() {
    return request<
      Array<{
        id: string;
        marketId: string | null;
        signalId: string | null;
        orderId: string | null;
        eventType: string;
        message: string;
        metadata: unknown;
        createdAt: string;
      }>
    >('/audit');
  },

  getExecutionDiagnostics() {
    return request<
      Array<{
        id: string;
        orderId: string | null;
        strategyVersionId: string | null;
        expectedEv: number | null;
        realizedEv: number | null;
        evDrift: number | null;
        expectedFee: number | null;
        realizedFee: number | null;
        expectedSlippage: number | null;
        realizedSlippage: number | null;
        edgeAtSignal: number | null;
        edgeAtFill: number | null;
        fillRate: number | null;
        staleOrder: boolean;
        regime: string | null;
        capturedAt: string;
        createdAt: string;
      }>
    >('/diagnostics/execution');
  },

  getEvDriftDiagnostics() {
    return request<
      Array<{
        id: string;
        strategyVersionId: string | null;
        windowLabel: string;
        expectedEvSum: number;
        realizedEvSum: number;
        evDrift: number;
        realizedVsExpected: number;
        capturedAt: string;
        createdAt: string;
      }>
    >('/diagnostics/ev-drift');
  },

  getRegimeDiagnostics() {
    return request<
      Array<{
        id: string;
        strategyVersionId: string | null;
        regime: string;
        tradeCount: number;
        winRate: number | null;
        expectedEvAvg: number | null;
        realizedEvAvg: number | null;
        fillRate: number | null;
        capturedAt: string;
        createdAt: string;
      }>
    >('/diagnostics/regimes');
  },

  getStressTestRuns() {
    return request<
      Array<{
        id: string;
        family: string;
        status: string;
        startedAt: string;
        completedAt: string | null;
        summary: unknown;
        verdict: string | null;
        createdAt: string;
      }>
    >('/diagnostics/stress-tests');
  },

  getDashboard() {
    return request<{
      botState: unknown;
      readinessDashboard: unknown;
      operatingMode: TradingOperatingMode;
      sentinelStatus: SentinelStatusResponse | null;
      recommendationMessage: string;
      simulatedTradesCompleted: number;
      simulatedTradesLearned: number;
      targetSimulatedTrades: number;
      readinessScore: number;
      readinessThreshold: number;
      recommendedLiveEnable: boolean;
      markets: unknown[];
      signals: unknown[];
      orders: unknown[];
      portfolio: unknown | null;
      diagnostics: {
        execution: unknown[];
        evDrift: unknown[];
        regimes: unknown[];
      };
      activity: unknown[];
    }>('/ui/dashboard');
  },

  getScene() {
    return request('/ui/scene');
  },
};
