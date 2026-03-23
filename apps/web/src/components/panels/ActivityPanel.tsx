import { useActivity } from '../../hooks/useActivity';

export function ActivityPanel() {
  const { activity } = useActivity();

  return (
    <section className="panel">
      <h2 className="panel-title">activity</h2>

      {activity.length === 0 ? (
        <div className="panel-copy">No activity available.</div>
      ) : (
        <ul className="activity-list">
          {activity.slice(0, 8).map((event) => (
            <li key={event.id} className="activity-item">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {event.eventType}
              </div>
              <div style={{ opacity: 0.82, fontSize: 12 }}>
                {event.message}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}