import { useMarkets } from '../../hooks/useMarkets';

export function MarketPanel() {
  const { markets } = useMarkets();

  return (
    <section className="panel">
      <h2 className="panel-title">markets</h2>

      {markets.length === 0 ? (
        <div className="panel-copy">No live markets loaded.</div>
      ) : (
        <div className="activity-list">
          {markets.slice(0, 5).map((market) => (
            <div key={market.id} className="activity-item">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{market.title}</div>
              <div style={{ opacity: 0.82, fontSize: 12 }}>
                {market.slug} · {market.status}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}