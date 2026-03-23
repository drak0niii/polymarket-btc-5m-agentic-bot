import { useRegimes } from '../../hooks/useRegimes';

export function RegimePanel() {
  const { regimes } = useRegimes();

  return (
    <section className="panel">
      <h2 className="panel-title">regimes</h2>

      {regimes.length === 0 ? (
        <div className="panel-copy">No regime diagnostics available.</div>
      ) : (
        <div className="activity-list">
          {regimes.slice(0, 5).map((regime) => (
            <div key={regime.id} className="activity-item">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {regime.regime}
              </div>
              <div style={{ opacity: 0.82, fontSize: 12 }}>
                trades {regime.tradeCount} · win rate{' '}
                {regime.winRate?.toFixed(4) ?? 'n/a'}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}