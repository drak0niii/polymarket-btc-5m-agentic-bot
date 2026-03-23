import { usePortfolio } from '../../hooks/usePortfolio';

export function PortfolioPanel() {
  const { portfolio } = usePortfolio();

  return (
    <section className="panel">
      <h2 className="panel-title">portfolio</h2>

      {!portfolio ? (
        <div className="panel-copy">No portfolio snapshot available.</div>
      ) : (
        <div className="metric-grid">
          <div className="metric-card">
            <span className="metric-label">bankroll</span>
            <span className="metric-value">{portfolio.bankroll.toFixed(2)}</span>
          </div>

          <div className="metric-card">
            <span className="metric-label">available capital</span>
            <span className="metric-value">
              {portfolio.availableCapital.toFixed(2)}
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">open exposure</span>
            <span className="metric-value">
              {portfolio.openExposure.toFixed(2)}
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">realized pnl day</span>
            <span className="metric-value">
              {portfolio.realizedPnlDay.toFixed(2)}
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">unrealized pnl</span>
            <span className="metric-value">
              {portfolio.unrealizedPnl.toFixed(2)}
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">consecutive losses</span>
            <span className="metric-value">{portfolio.consecutiveLosses}</span>
          </div>
        </div>
      )}
    </section>
  );
}