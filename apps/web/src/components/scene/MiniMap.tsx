export function MiniMap() {
  return (
    <div
      style={{
        width: 176,
        borderRadius: 18,
        border: '1px solid rgba(255,255,255,0.1)',
        background: 'rgba(0,0,0,0.45)',
        padding: 10,
        boxShadow: '0 12px 36px rgba(0,0,0,0.24)',
        backdropFilter: 'blur(14px)',
      }}
    >
      <div
        style={{
          marginBottom: 8,
          fontSize: 10,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'rgba(210,225,255,0.72)',
        }}
      >
        minimap
      </div>

      <svg
        viewBox="0 0 160 160"
        style={{
          width: '100%',
          height: 140,
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.08)',
          background: '#081122',
        }}
      >
        <rect x="20" y="28" width="18" height="18" fill="#4D6BFF" opacity="0.8" />
        <rect x="58" y="50" width="18" height="18" fill="#E267FF" opacity="0.8" />
        <rect x="92" y="68" width="18" height="18" fill="#FF6B8A" opacity="0.8" />
        <rect x="120" y="44" width="18" height="18" fill="#7A8CFF" opacity="0.8" />
        <rect x="74" y="108" width="18" height="18" fill="#9B7BFF" opacity="0.8" />
      </svg>
    </div>
  );
}