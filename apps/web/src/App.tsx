import { ControlPanel } from './components/panels/ControlPanel';
import { MarketPanel } from './components/panels/MarketPanel';
import { SignalPanel } from './components/panels/SignalPanel';
import { EdgePanel } from './components/panels/EdgePanel';
import { RiskPanel } from './components/panels/RiskPanel';
import { PortfolioPanel } from './components/panels/PortfolioPanel';
import { OrdersPanel } from './components/panels/OrdersPanel';
import { ActivityPanel } from './components/panels/ActivityPanel';
import { AgentPanel } from './components/panels/AgentPanel';
import { DiagnosticsPanel } from './components/panels/DiagnosticsPanel';
import { StressTestPanel } from './components/panels/StressTestPanel';
import { ExecutionQualityPanel } from './components/panels/ExecutionQualityPanel';
import { RegimePanel } from './components/panels/RegimePanel';
import { Scene3D } from './components/scene/Scene3D';

export default function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>polymarket-btc-5m-agentic-bot</h1>
      </header>

      <main className="layout">
        <section className="scene-column">
          <Scene3D />
        </section>

        <section className="panel-column">
          <ControlPanel />
          <MarketPanel />
          <SignalPanel />
          <EdgePanel />
          <RiskPanel />
          <PortfolioPanel />
          <OrdersPanel />
          <ExecutionQualityPanel />
          <RegimePanel />
          <DiagnosticsPanel />
          <StressTestPanel />
          <ActivityPanel />
          <AgentPanel />
        </section>
      </main>
    </div>
  );
}