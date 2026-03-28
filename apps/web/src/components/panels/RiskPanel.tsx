import { useBotState } from '../../hooks/useBotState';

export function RiskPanel() {
  const { botState, fetchStatus } = useBotState();

  if (!botState) {
    return (
      <section className="panel">
        <h2 className="panel-title">risk</h2>
        <div className="panel-copy">
          {fetchStatus === 'loading'
            ? 'Loading risk truth...'
            : 'Risk truth unavailable while backend data is unavailable.'}
        </div>
      </section>
    );
  }

  const config = botState.liveConfig;

  return (
    <section className="panel">
      <h2 className="panel-title">risk</h2>

      <div className="metric-grid">
        <div className="metric-card">
          <span className="metric-label">max open positions</span>
          <span className="metric-value">{config.maxOpenPositions}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">daily loss %</span>
          <span className="metric-value">{config.maxDailyLossPct}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">risk per trade %</span>
          <span className="metric-value">{config.maxPerTradeRiskPct}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">kelly fraction</span>
          <span className="metric-value">{config.maxKellyFraction}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">max consecutive losses</span>
          <span className="metric-value">{config.maxConsecutiveLosses}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">no-trade window (s)</span>
          <span className="metric-value">{config.noTradeWindowSeconds}</span>
        </div>
      </div>
    </section>
  );
}
