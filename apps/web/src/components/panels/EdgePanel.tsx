import { useSignals } from '../../hooks/useSignals';

export function EdgePanel() {
  const { signals } = useSignals();
  const latest = signals[0];

  return (
    <section className="panel">
      <h2 className="panel-title">edge</h2>

      {!latest ? (
        <div className="panel-copy">No edge data available.</div>
      ) : (
        <div className="metric-grid">
          <div className="metric-card">
            <span className="metric-label">edge</span>
            <span className="metric-value">{latest.edge.toFixed(4)}</span>
          </div>

          <div className="metric-card">
            <span className="metric-label">expected ev</span>
            <span className="metric-value">{latest.expectedEv.toFixed(4)}</span>
          </div>

          <div className="metric-card">
            <span className="metric-label">implied prob</span>
            <span className="metric-value">
              {latest.marketImpliedProb.toFixed(4)}
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">regime</span>
            <span className="metric-value">{latest.regime ?? 'n/a'}</span>
          </div>
        </div>
      )}
    </section>
  );
}