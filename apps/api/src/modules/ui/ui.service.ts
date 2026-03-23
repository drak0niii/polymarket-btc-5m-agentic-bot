import { Injectable } from '@nestjs/common';
import { MarketsService } from '@api/modules/markets/markets.service';
import { SignalsService } from '@api/modules/signals/signals.service';
import { OrdersService } from '@api/modules/orders/orders.service';
import { PortfolioService } from '@api/modules/portfolio/portfolio.service';
import { BotControlService } from '@api/modules/bot-control/bot-control.service';
import { DiagnosticsService } from '@api/modules/diagnostics/diagnostics.service';
import { AuditService } from '@api/modules/audit/audit.service';
import { appEnv } from '@api/config/env';
import { ProductionReadinessDashboardService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { DeploymentTierPolicyService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { CapitalRampPolicyService } from '@polymarket-btc-5m-agentic-bot/risk-engine';

@Injectable()
export class UiService {
  private readonly readinessService = new ProductionReadinessDashboardService();
  private readonly tierPolicy = new DeploymentTierPolicyService();
  private readonly capitalRampPolicy = new CapitalRampPolicyService();

  constructor(
    private readonly marketsService: MarketsService,
    private readonly signalsService: SignalsService,
    private readonly ordersService: OrdersService,
    private readonly portfolioService: PortfolioService,
    private readonly botControlService: BotControlService,
    private readonly diagnosticsService: DiagnosticsService,
    private readonly auditService: AuditService,
  ) {}

  async getDashboard() {
    const [
      botState,
      markets,
      signals,
      orders,
      portfolio,
      executionDiagnostics,
      evDriftDiagnostics,
      regimeDiagnostics,
      stressTests,
      reconciliationDiagnostics,
      auditEvents,
    ] = await Promise.all([
      this.botControlService.getState(),
      this.marketsService.listMarkets(),
      this.signalsService.listSignals(),
      this.ordersService.listOrders(),
      this.portfolioService.getLatestPortfolio().catch(() => null),
      this.diagnosticsService.getExecutionDiagnostics(),
      this.diagnosticsService.getEvDriftDiagnostics(),
      this.diagnosticsService.getRegimeDiagnostics(),
      this.diagnosticsService.getStressTestRuns(),
      this.diagnosticsService.getReconciliationDiagnostics(),
      this.auditService.listAuditEvents(),
    ]);
    const readinessDashboard = this.buildReadinessDashboard({
      botState,
      stressTests,
      reconciliationDiagnostics,
      auditEvents,
    });

    return {
      botState,
      readinessDashboard,
      markets,
      signals,
      orders,
      portfolio,
      diagnostics: {
        execution: executionDiagnostics,
        evDrift: evDriftDiagnostics,
        regimes: regimeDiagnostics,
      },
      activity: auditEvents,
    };
  }

  async getScene() {
    const [botState, markets, signals, orders, portfolio] = await Promise.all([
      this.botControlService.getState(),
      this.marketsService.listMarkets(),
      this.signalsService.listSignals(),
      this.ordersService.listOrders(),
      this.portfolioService.getLatestPortfolio().catch(() => null),
    ]);

    return {
      botState,
      scene: {
        districts: [
          { id: 'market-discovery', label: 'market discovery' },
          { id: 'signal-engine', label: 'signal engine' },
          { id: 'risk-engine', label: 'risk engine' },
          { id: 'execution-engine', label: 'execution engine' },
          { id: 'portfolio', label: 'portfolio' },
          { id: 'activity', label: 'activity' },
        ],
        state: {
          markets,
          signals,
          orders,
          portfolio,
        },
      },
    };
  }

  private buildReadinessDashboard(input: {
    botState: Awaited<ReturnType<BotControlService['getState']>>;
    stressTests: Array<{
      family: string;
      status: string;
      verdict?: string | null;
      summary?: unknown;
    }>;
    reconciliationDiagnostics: Array<{
      source?: string | null;
      status?: string | null;
      details?: unknown;
      processedAt?: Date;
    }>;
    auditEvents: Array<{
      eventType: string;
    }>;
  }) {
    const auditCoverage = this.auditCoverage(input.auditEvents);
    const latestResearch = input.reconciliationDiagnostics.find(
      (entry) => entry.source === 'research_governance_validation',
    );
    const latestStartup = input.reconciliationDiagnostics.find(
      (entry) => entry.source === 'startup_gate_verdict',
    );
    const latestOpenOrders = input.reconciliationDiagnostics.find(
      (entry) => entry.source === 'open_orders_reconcile_cycle',
    );
    const latestFills = input.reconciliationDiagnostics.find(
      (entry) => entry.source === 'fills_reconcile_cycle',
    );
    const latestExternal = input.reconciliationDiagnostics.find(
      (entry) => entry.source === 'external_portfolio_reconcile',
    );
    const latestHeartbeat = input.reconciliationDiagnostics.find(
      (entry) => entry.source === 'venue_open_orders_heartbeat',
    );
    const latestObserver = input.reconciliationDiagnostics.find(
      (entry) => entry.source === 'production_readiness_observer',
    );
    const latestCapitalExposure = input.reconciliationDiagnostics.find(
      (entry) => entry.source === 'capital_exposure_validation',
    );
    const chaosRun = input.stressTests.find((run) => run.family === 'chaos_harness');
    const researchDetails =
      latestResearch?.details && typeof latestResearch.details === 'object'
        ? (latestResearch.details as Record<string, unknown>)
        : {};
    const robustness =
      researchDetails.robustness && typeof researchDetails.robustness === 'object'
        ? (researchDetails.robustness as Record<string, unknown>)
        : {};
    const promotion =
      researchDetails.promotion && typeof researchDetails.promotion === 'object'
        ? (researchDetails.promotion as Record<string, unknown>)
        : {};
    const tierVerdict = this.tierPolicy.evaluate({
      tier: appEnv.BOT_DEPLOYMENT_TIER,
      liveExecutionEnabled: appEnv.BOT_LIVE_EXECUTION_ENABLED,
      robustnessPassed: Boolean(robustness.passed),
      auditCoverageHealthy: auditCoverage >= 0.6,
      readinessReady:
        input.botState.state === 'running' &&
        latestOpenOrders?.status === 'completed' &&
        latestFills?.status === 'completed' &&
        latestExternal?.status === 'completed',
    });
    const capitalRamp = this.capitalRampPolicy.evaluate({
      tierAllowsScale: tierVerdict.allowNewEntries,
      robustnessPassed: Boolean(robustness.passed),
      chaosPassed:
        chaosRun?.verdict === 'passed' ||
        chaosRun?.status === 'passed' ||
        appEnv.BOT_DEPLOYMENT_TIER === 'paper' ||
        appEnv.BOT_DEPLOYMENT_TIER === 'research',
      auditCoverageHealthy: auditCoverage >= 0.6,
      attributionCoverage:
        input.auditEvents.filter((event) => event.eventType === 'trade.post_trade_attribution')
          .length / 10,
      promotionScore: Number(promotion.score ?? 0),
      capitalExposureValidated:
        latestCapitalExposure?.status === 'completed' ||
        appEnv.BOT_DEPLOYMENT_TIER === 'paper' ||
        appEnv.BOT_DEPLOYMENT_TIER === 'research',
    });

    return this.readinessService.evaluate({
      deploymentTier: tierVerdict.tier,
      capitalMultiplier: capitalRamp.capitalMultiplier,
      checks: {
        startup: latestStartup?.status === 'completed',
        streams:
          latestOpenOrders?.status === 'completed' &&
          latestFills?.status === 'completed' &&
          latestExternal?.status === 'completed' &&
          (latestHeartbeat?.status === 'completed' || !latestHeartbeat),
        observer: latestObserver?.status === 'completed',
        governance: latestResearch?.status === 'passed',
        robustness: Boolean(robustness.passed),
        auditability: auditCoverage >= 0.6,
        replay: input.auditEvents.some((event) => event.eventType === 'signal.admission_decision'),
        chaos:
          chaosRun?.verdict === 'passed' ||
          chaosRun?.status === 'passed' ||
          appEnv.BOT_DEPLOYMENT_TIER === 'paper' ||
          appEnv.BOT_DEPLOYMENT_TIER === 'research',
        tier: tierVerdict.reasons.length === 0,
        capitalRamp:
          capitalRamp.allowScaling ||
          appEnv.BOT_DEPLOYMENT_TIER === 'paper' ||
          appEnv.BOT_DEPLOYMENT_TIER === 'research',
        capitalEvidence:
          latestCapitalExposure?.status === 'completed' ||
          appEnv.BOT_DEPLOYMENT_TIER === 'paper' ||
          appEnv.BOT_DEPLOYMENT_TIER === 'research',
      },
      reasons: {
        startup: latestStartup?.status ?? 'missing',
        streams: latestHeartbeat?.status ?? 'healthy',
        observer: latestObserver?.status ?? 'missing',
        governance: latestResearch?.status ?? 'missing',
        robustness: Boolean(robustness.passed) ? 'healthy' : 'not_passed',
        auditability: auditCoverage >= 0.6 ? 'healthy' : 'coverage_too_low',
        replay: 'decision_trace_available',
        chaos: chaosRun?.status ?? 'missing',
        tier: tierVerdict.reasons.join('|') || 'healthy',
        capitalRamp: capitalRamp.reasons.join('|') || capitalRamp.stage,
        capitalEvidence: latestCapitalExposure?.status ?? 'missing',
      },
    });
  }

  private auditCoverage(auditEvents: Array<{ eventType: string }>): number {
    const families = [
      'signal.edge_assessed',
      'signal.admission_decision',
      'signal.execution_decision',
      'trade.post_trade_attribution',
      'runtime.readiness_dashboard',
    ];
    const seen = new Set(auditEvents.map((event) => event.eventType));
    return families.filter((family) => seen.has(family)).length / families.length;
  }
}
