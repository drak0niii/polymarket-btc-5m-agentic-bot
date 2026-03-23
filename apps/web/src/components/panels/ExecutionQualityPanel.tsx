import { useExecutionQuality } from '../../hooks/useExecutionQuality';

export function ExecutionQualityPanel() {
  const { executionDiagnostics } = useExecutionQuality();
  const latest = executionDiagnostics[0];

  return (
    <section className="panel">
      <h2 className="panel-title">execution quality</h2>

      {!latest ? (
        <div className="panel-copy">No execution diagnostics available.</div>
      ) : (
        <div className="metric-grid">
          <div className="metric-card">
            <span className="metric-label">expected ev</span>
            <span className="metric-value">
              {latest.expectedEv?.toFixed(4) ?? 'n/a'}
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">realized ev</span>
            <span className="metric-value">
              {latest.realizedEv?.toFixed(4) ?? 'n/a'}
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">ev drift</span>
            <span className="metric-value">
              {latest.evDrift?.toFixed(4) ?? 'n/a'}
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">fill rate</span>
            <span className="metric-value">
              {latest.fillRate?.toFixed(4) ?? 'n/a'}
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">edge at signal</span>
            <span className="metric-value">
              {latest.edgeAtSignal?.toFixed(4) ?? 'n/a'}
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">edge at fill</span>
            <span className="metric-value">
              {latest.edgeAtFill?.toFixed(4) ?? 'n/a'}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}