import { usePortfolio } from '../../hooks/usePortfolio';

export function PortfolioPanel() {
  const { portfolio, status, message, lastSuccessfulSyncAt } = usePortfolio();

  return (
    <section className="panel">
      <h2 className="panel-title">portfolio</h2>

      {status === 'loading' ? (
        <div className="panel-copy">Loading portfolio truth...</div>
      ) : status === 'error' ? (
        <div className="panel-copy">
          Portfolio truth unavailable. {message ?? 'Backend request failed.'}
        </div>
      ) : status === 'stale' ? (
        <div className="panel-copy">
          Portfolio truth is stale from {lastSuccessfulSyncAt ?? 'an unknown time'}.{' '}
          {message ?? 'Latest refresh failed.'}
        </div>
      ) : status === 'missing' ? (
        <div className="panel-copy">{message ?? 'No portfolio snapshot has been recorded yet.'}</div>
      ) : !portfolio ? (
        <div className="panel-copy">Portfolio response was empty.</div>
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
