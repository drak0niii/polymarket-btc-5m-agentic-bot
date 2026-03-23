import { useSignals } from '../../hooks/useSignals';

export function SignalPanel() {
  const { signals } = useSignals();

  return (
    <section className="panel">
      <h2 className="panel-title">signals</h2>

      {signals.length === 0 ? (
        <div className="panel-copy">No live signals available.</div>
      ) : (
        <div className="activity-list">
          {signals.slice(0, 5).map((signal) => (
            <div key={signal.id} className="activity-item">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {signal.side} · {signal.status}
              </div>
              <div style={{ opacity: 0.82, fontSize: 12 }}>
                prior {signal.priorProbability.toFixed(3)} · posterior{' '}
                {signal.posteriorProbability.toFixed(3)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}