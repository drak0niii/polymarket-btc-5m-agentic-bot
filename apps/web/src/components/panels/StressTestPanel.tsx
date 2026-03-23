import { useStressTests } from '../../hooks/useStressTests';

export function StressTestPanel() {
  const { stressTests } = useStressTests();

  return (
    <section className="panel">
      <h2 className="panel-title">stress tests</h2>

      {stressTests.length === 0 ? (
        <div className="panel-copy">No stress test runs available.</div>
      ) : (
        <div className="activity-list">
          {stressTests.slice(0, 5).map((run) => (
            <div key={run.id} className="activity-item">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {run.family} · {run.status}
              </div>
              <div style={{ opacity: 0.82, fontSize: 12 }}>
                verdict {run.verdict ?? 'n/a'}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}