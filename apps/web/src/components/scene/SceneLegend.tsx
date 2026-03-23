export function SceneLegend() {
  const items = [
    { color: '#4D6BFF', label: 'market discovery' },
    { color: '#E267FF', label: 'signal engine' },
    { color: '#FF6B8A', label: 'risk engine' },
    { color: '#7A8CFF', label: 'execution engine' },
    { color: '#9B7BFF', label: 'portfolio' },
  ];

  return (
    <div
      style={{
        minWidth: 220,
        borderRadius: 18,
        border: '1px solid rgba(255,255,255,0.1)',
        background: 'rgba(0,0,0,0.45)',
        padding: 12,
        boxShadow: '0 12px 36px rgba(0,0,0,0.24)',
        backdropFilter: 'blur(14px)',
      }}
    >
      <div
        style={{
          marginBottom: 10,
          fontSize: 10,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'rgba(210,225,255,0.72)',
        }}
      >
        scene legend
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((item) => (
          <div
            key={item.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 12,
              color: 'rgba(245,247,255,0.84)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: item.color,
                display: 'inline-block',
              }}
            />
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
}