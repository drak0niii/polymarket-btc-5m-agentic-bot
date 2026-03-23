import { useDiagnostics } from '../../hooks/useDiagnostics';

export function DiagnosticsPanel() {
  const { diagnostics } = useDiagnostics();

  return (
    <section className="panel">
      <h2 className="panel-title">diagnostics</h2>

      <div className="metric-grid">
        <div className="metric-card">
          <span className="metric-label">execution records</span>
          <span className="metric-value">
            {diagnostics.execution.length}
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-label">ev drift records</span>
          <span className="metric-value">
            {diagnostics.evDrift.length}
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-label">regime records</span>
          <span className="metric-value">
            {diagnostics.regimes.length}
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-label">stress test runs</span>
          <span className="metric-value">
            {diagnostics.stressTests.length}
          </span>
        </div>
      </div>
    </section>
  );
}