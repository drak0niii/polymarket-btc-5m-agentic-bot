export function AgentPanel() {
  const agents = [
    {
      id: 'planner',
      name: 'strategy planner',
      description: 'Proposes structured strategy changes and refinements.',
    },
    {
      id: 'critic',
      name: 'strategy critic',
      description: 'Challenges weak assumptions and flags configuration risks.',
    },
    {
      id: 'reviewer',
      name: 'daily reviewer',
      description: 'Summarizes daily behavior, outcomes, and execution quality.',
    },
    {
      id: 'anomaly',
      name: 'anomaly reviewer',
      description: 'Explains execution drift and unusual market behavior.',
    },
  ];

  return (
    <section className="panel">
      <h2 className="panel-title">agent layer</h2>

      <div className="activity-list">
        {agents.map((agent) => (
          <div key={agent.id} className="activity-item">
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{agent.name}</div>
            <div style={{ opacity: 0.82, fontSize: 12 }}>{agent.description}</div>
          </div>
        ))}
      </div>
    </section>
  );
}