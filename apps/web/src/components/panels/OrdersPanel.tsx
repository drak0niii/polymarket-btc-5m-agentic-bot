import { useOrders } from '../../hooks/useOrders';

export function OrdersPanel() {
  const { orders } = useOrders();

  return (
    <section className="panel">
      <h2 className="panel-title">orders</h2>

      {orders.length === 0 ? (
        <div className="panel-copy">No live orders available.</div>
      ) : (
        <div className="activity-list">
          {orders.slice(0, 5).map((order) => (
            <div key={order.id} className="activity-item">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {order.side} · {order.status}
              </div>
              <div style={{ opacity: 0.82, fontSize: 12 }}>
                price {order.price.toFixed(4)} · size {order.size.toFixed(4)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}