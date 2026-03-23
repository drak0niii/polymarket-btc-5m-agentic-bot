# polymarket-btc-5m-agentic-bot

A live-only, fully automated BTC 5-minute Polymarket trading system with:

- deterministic signal generation
- strict risk gating
- automated execution through the official Polymarket trading client
- agentic supervision for planning, critique, anomaly analysis, and review
- a live operator dashboard with Start / Stop control
- diagnostics, stress testing, and execution-quality analysis

## High-level purpose

This repository is designed to monitor live BTC-linked 5-minute Polymarket opportunities, estimate whether a real edge exists after fees and execution costs, and place many small, selective trades when conditions pass strict risk thresholds.

The goal is not to guarantee profit. The engineering objective is:

- survive adverse conditions
- trade only when expected value appears positive
- keep execution observable and auditable
- compound small gains over time if the live edge is real

The live execution path is Polymarket-specific by design:

- order style is chosen from one canonical execution-semantics policy
- passive orders use explicit GTC or GTD rules
- immediate orders use explicit FOK or FAK rules
- duplicate venue exposure is blocked before submit
- dynamic venue fee inputs and maker-quality metadata feed final execution decisions
- negative-risk markets are excluded deliberately until strategy and reconciliation support is extended

## Core principles

1. **Deterministic code trades**
2. **Risk can veto any trade**
3. **AI supervises but does not directly own the live trade loop**
4. **The bot runs only in live mode**
5. **Start / Stop state is explicit and auditable**

## Repository layout

polymarket-btc-5m-agentic-bot/
  README.md
  package.json
  pnpm-workspace.yaml
  turbo.json
  .gitignore
  .env.example
  prisma.config.ts

  docs/
    architecture.md
    live-trading-flow.md
    risk-policy.md
    wallet-bootstrap.md
    start-stop.md
    stress-testing.md
    execution-diagnostics.md
    market-microstructure-notes.md

  apps/
    api/
      package.json
      tsconfig.json
      nest-cli.json

      prisma/
        schema.prisma
        migrations/

      src/
        main.ts
        app.module.ts

        common/
          logger.ts
          telemetry.ts
          ids.ts
          errors.ts

        config/
          env.ts

        modules/
          prisma/
            prisma.module.ts
            prisma.service.ts

          health/
            health.controller.ts

          bot-control/
            bot-control.module.ts
            bot-control.controller.ts
            bot-control.service.ts
            dto/
              start-bot.dto.ts
              stop-bot.dto.ts
              set-live-config.dto.ts

          markets/
            markets.module.ts
            markets.controller.ts
            markets.service.ts
            markets.repository.ts
            dto/
              market-response.dto.ts
              orderbook-response.dto.ts

          signals/
            signals.module.ts
            signals.controller.ts
            signals.service.ts
            signals.repository.ts
            dto/
              signal-response.dto.ts
              signal-decision-response.dto.ts

          portfolio/
            portfolio.module.ts
            portfolio.controller.ts
            portfolio.service.ts
            portfolio.repository.ts
            dto/
              portfolio-response.dto.ts
              portfolio-snapshot-response.dto.ts

          orders/
            orders.module.ts
            orders.controller.ts
            orders.service.ts
            orders.repository.ts
            dto/
              order-response.dto.ts
              fill-response.dto.ts

          strategy/
            strategy.module.ts
            strategy.controller.ts
            strategy.service.ts
            strategy.repository.ts
            dto/
              strategy-config.dto.ts
              update-strategy-config.dto.ts

          audit/
            audit.module.ts
            audit.controller.ts
            audit.service.ts
            audit.repository.ts
            dto/
              audit-event-response.dto.ts

          diagnostics/
            diagnostics.module.ts
            diagnostics.controller.ts
            diagnostics.service.ts
            diagnostics.repository.ts
            dto/
              execution-diagnostic-response.dto.ts
              ev-drift-response.dto.ts
              regime-diagnostic-response.dto.ts
              stress-test-run-response.dto.ts

          ui/
            ui.module.ts
            ui.controller.ts
            ui.service.ts
            dto/
              dashboard-response.dto.ts
              scene-response.dto.ts

    worker/
      package.json
      tsconfig.json

      src/
        main.ts
        worker.module.ts

        common/
          logger.ts
          telemetry.ts

        config/
          env.ts

        runtime/
          bot-runtime.ts
          bot-state.ts
          start-stop-manager.ts
          live-loop.ts

        jobs/
          discoverActiveBtcMarkets.job.ts
          syncBtcReference.job.ts
          syncOrderbooks.job.ts
          buildSignals.job.ts
          evaluateTradeOpportunities.job.ts
          executeOrders.job.ts
          manageOpenOrders.job.ts
          reconcileFills.job.ts
          refreshPortfolio.job.ts
          dailyReview.job.ts
          runStressResolutionWindow.job.ts
          runStressOrderbook.job.ts
          runStressFees.job.ts
          runStressLatency.job.ts
          runStressRegimes.job.ts
          runStressRiskOfRuin.job.ts
          runEvDriftAnalysis.job.ts

    web/
      package.json
      tsconfig.json
      vite.config.ts
      index.html

      src/
        main.tsx
        App.tsx
        index.css

        components/
          scene/
            Scene3D.tsx
            FloatingNode.tsx
            Connections.tsx
            MiniMap.tsx
            SceneLegend.tsx

          panels/
            ControlPanel.tsx
            MarketPanel.tsx
            SignalPanel.tsx
            EdgePanel.tsx
            RiskPanel.tsx
            PortfolioPanel.tsx
            OrdersPanel.tsx
            ActivityPanel.tsx
            AgentPanel.tsx
            DiagnosticsPanel.tsx
            StressTestPanel.tsx
            ExecutionQualityPanel.tsx
            RegimePanel.tsx

          buttons/
            StartBotButton.tsx
            StopBotButton.tsx
            EmergencyHaltButton.tsx

          ui/
            card.tsx
            button.tsx
            input.tsx
            scroll-area.tsx
            select.tsx
            badge.tsx

        hooks/
          useBotState.ts
          useMarkets.ts
          useSignals.ts
          useOrders.ts
          usePortfolio.ts
          useActivity.ts
          useDiagnostics.ts
          useStressTests.ts
          useExecutionQuality.ts
          useRegimes.ts

        lib/
          api.ts
          scene-mappers.ts
          diagnostics-api.ts
          stress-tests-api.ts

  packages/
    domain/
      package.json
      tsconfig.json
      src/
        market.ts
        candle.ts
        orderbook.ts
        signal.ts
        edge.ts
        ev.ts
        risk.ts
        order.ts
        fill.ts
        position.ts
        portfolio.ts
        bot-state.ts
        strategy.ts
        audit.ts
        enums.ts
        diagnostics.ts
        stress-test.ts
        regime.ts
        execution-quality.ts

    polymarket-adapter/
      package.json
      tsconfig.json
      src/
        gamma-client.ts
        market-discovery.ts
        official-trading-client.ts

        auth/
          l1-bootstrap.ts
          l2-credentials.ts
          credential-store.ts

    market-data/
      package.json
      tsconfig.json
      src/
        btc-price.service.ts
        candles.service.ts
        volatility.service.ts
        normalization.ts
        feed-latency-monitor.ts
        timestamp-alignment.ts

    signal-engine/
      package.json
      tsconfig.json
      src/
        feature-builder.ts
        mispricing-score.ts
        regime-classifier.ts

        prior/
          prior-model.ts

        posterior/
          posterior-update.ts

        edge/
          edge-calculator.ts

        ev/
          ev-calculator.ts

        filters/
          spread-filter.ts
          liquidity-filter.ts
          volatility-filter.ts
          cooldown-filter.ts
          regime-filter.ts
          book-freshness-filter.ts
          late-window-filter.ts
          no-trade-near-expiry-filter.ts

    risk-engine/
      package.json
      tsconfig.json
      src/
        bankroll.ts
        capped-kelly.ts
        bet-sizing.ts
        position-limits.ts
        daily-loss-limits.ts
        consecutive-loss-kill-switch.ts
        live-trade-guard.ts
        adverse-selection-guard.ts
        expected-vs-realized-ev-guard.ts
        execution-drift-kill-switch.ts
        bankroll-contraction.ts

    execution-engine/
      package.json
      tsconfig.json
      src/
        order-planner.ts
        order-router.ts
        marketable-limit.ts
        slippage-estimator.ts
        stale-order-manager.ts
        fill-tracker.ts
        exit-manager.ts
        position-manager.ts
        queue-position-estimator.ts
        fill-probability-estimator.ts
        cancel-replace-policy.ts
        execution-diagnostics.ts
        trade-intent-resolver.ts

    signing-engine/
      package.json
      tsconfig.json
      src/
        key-loader.ts
        polymarket-private-key.ts
        signer-health.ts

    agent-layer/
      package.json
      tsconfig.json
      src/
        openai-client.ts

        planner/
          strategy-planner.agent.ts

        critic/
          strategy-critic.agent.ts

        reviewer/
          daily-review.agent.ts

        anomaly/
          anomaly-review.agent.ts
          execution-drift.agent.ts

        schemas/
          strategy-proposal.schema.ts
          strategy-critique.schema.ts
          daily-review.schema.ts
          anomaly-report.schema.ts
          execution-drift-report.schema.ts

    ui-contracts/
      package.json
      src/
        dashboard.ts
        scene.ts
        activity.ts
        markets.ts
        signals.ts
        orders.ts
        portfolio.ts
        control.ts
        diagnostics.ts
        stress-tests.ts
        execution-quality.ts
        regimes.ts

  infra/
    docker-compose.yml
    prometheus/
      prometheus.yml
    grafana/
      dashboards/
        .gitkeep
      datasources/
        .gitkeep

  data/
    exports/
      .gitkeep

  scripts/
    bootstrap.sh
    dev-api.sh
    dev-worker.sh
    dev-web.sh
    run-live-bot.sh
    stop-live-bot.sh
    migrate.sh
    run-stress-resolution-window.sh
    run-stress-orderbook.sh
    run-stress-fees.sh
    run-stress-latency.sh
    run-stress-regimes.sh
    run-stress-risk.sh
    run-ev-drift.sh


Applications

1. apps/api
The API is the control plane. It exposes:
 - health and readiness
 - bot Start / Stop endpoints
 - live config update endpoints
 - markets, signals, orders, and portfolio endpoints
 - audit and activity endpoints
 - diagnostics and stress-test endpoints
 - dashboard aggregation endpoints for the web app

2. apps/worker
The worker is the live runtime. It:
 - discovers live BTC-linked markets
 - syncs BTC reference price and orderbook state
 - computes signals
 - evaluates edge and EV
 - applies risk checks
 - executes orders
 - manages stale orders and fills
 - refreshes portfolio state
 - computes diagnostics and daily reviews
 - runs stress-test jobs

3. apps/web
The web app is the live dashboard. It provides:
 - Start / Stop control
 - current bot state
 - market state
 - signals, edge, and EV visibility
 - order and portfolio monitoring
 - diagnostics panels
 - activity stream
 - agent commentary

 Packages

4. packages/domain
Shared domain models, enums, and typed contracts for:
 - markets
 - candles
 - orderbooks
 - signals
 - EV and risk
 - orders, fills, positions
 - portfolio
 - bot state
 - diagnostics
 - stress tests
 - regimes
 - execution quality

5. packages/polymarket-adapter
Encapsulates all Polymarket-specific logic:
 - market discovery
 - Gamma data access
 - L1 bootstrap support
 - L2 credential handling
 - official trading client for live order submission / cancellation / queries
 - canonical venue-awareness layer for startup preflight, server-time checks, error normalization, and rate governance

6. packages/market-data
Provides normalized market inputs:
 - BTC reference price
 - recent candles
 - volatility metrics
 - feed latency tracking
 - timestamp alignment

7. packages/signal-engine
Deterministic signal stack:
 - feature building
 - prior model
 - posterior update
 - edge calculation
 - net EV calculation
 - spread / liquidity / volatility filters
 - late-window and book-freshness filters
 - regime classification and mispricing scoring

8. packages/risk-engine
Trade approval and capital protection:
 - bankroll and sizing
 - capped Kelly
 - position limits
 - daily loss limits
 - consecutive-loss kill switch
 - adverse-selection guard
 - expected-vs-realized EV guard
 - bankroll contraction under drawdown

9. packages/execution-engine
Execution and order lifecycle:
 - canonical trade-intent resolution
 - order planning
 - routing
 - marketable-limit behavior
 - slippage estimation
 - queue-position and fill-probability estimation
 - fill tracking
 - stale-order handling
 - exit logic
 - execution diagnostics

10. packages/signing-engine
Live bot signing and key handling:
 - key loading
 - Polymarket private-key normalization
 - signer health checks

11. packages/agent-layer
Supervisory AI layer:
 - strategy planner
 - strategy critic
 - daily reviewer
 - anomaly reviewer
 - execution-drift explainer
This layer does not directly make the live buy / sell decision.

12. packages/ui-contracts
Shared DTOs for the frontend:
 - dashboard
 - scene
 - activity
 - markets
 - signals
 - orders
 - portfolio
 - diagnostics
 - control state


 Live-only runtime model

This repository supports only one operating mode:
 - live_bot

That means:
 - there is no replay mode
 - there is no paper mode
 - there is no shadow mode
The bot is designed to run as a live automated system with Start / Stop control and explicit runtime state.
`BOT_LIVE_EXECUTION_ENABLED` must be `true`; Start readiness rejects activation otherwise.

Start / Stop behavior
1. Start
Starting the bot should:

 - validate live configuration
 - verify credentials and signer health
 - preflight the venue for geoblock, closed-only mode, and clock skew
 - verify risk limits are loaded
 - transition runtime from stopped to active
 - allow the worker loop to begin trading

2. Stop
Stopping the bot should:

 - block new entries
 - enter `stopping` and allow safe cleanup of outstanding order state
 - continue reconciliation until stable
 - transition runtime to a stopped state

A stopped bot should remain observable through the API and web dashboard.

3. Diagnostics and stress testing
The repository includes infrastructure for:

 - resolution-window stress tests
 - orderbook / fill-quality stress tests
 - fee and friction stress tests
 - latency stress tests
 - regime stress tests
 - risk-of-ruin stress tests
 - expected-vs-realized EV analysis

These diagnostics are part of the live system hardening process.

4. Safety and operational notes
This repository is an engineering system, not a promise of returns.
Important realities:
 - live execution quality matters
 - fees, spread, and slippage matter
 - small bankrolls are fragile
 - market microstructure can destroy weak edge
 - expected EV must be compared to realized EV continuously
 - venue readiness is broader than auth alone

Canonical venue-awareness protections now include:
 - startup geoblock preflight before Start can arm the runtime
 - server-time probing with clock-skew rejection
 - normalized Polymarket error categories for auth, rate limits, venue validation, network, and server failures
 - scope-aware rate governance for public, private, submit, and heartbeat traffic

The right engineering target is:
 - robust infrastructure
 - selective entries
 - conservative sizing
 - hard risk controls
 - complete auditability

5. Development prerequisites
Expected local requirements:

 - Node.js 22+
 - pnpm
 - PostgreSQL
 - Redis
 - valid OpenAI API credentials for the agent layer
 - valid Polymarket trading credentials and signing material
 - optional Docker for local infrastructure


 Build order
Recommended build order:

1. root configuration files
2. packages/domain
3. packages/polymarket-adapter
4. packages/market-data
5. packages/signal-engine
6. packages/risk-engine
7. packages/execution-engine
8. packages/signing-engine
9. apps/api
10. apps/worker
11. packages/agent-layer
12. apps/web
