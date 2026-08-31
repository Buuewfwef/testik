import { newOrderId } from '../src/common/ids';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

async function json(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitDelivered(id: string) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const order = await json(`/api/orders/${id}`);
    if (order.status === 'delivered') return order;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('выдача не дождалась');
}

async function main() {
  const order = await json('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ sku: 'STEAM-TOPUP-500', id: newOrderId() }),
  });
  console.log('order', order.id, order.status);

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      json('/webhook/payment', {
        method: 'POST',
        body: JSON.stringify({
          event_id: `evt_race_${order.id}_${i}`,
          order_id: order.id,
          status: 'paid',
          amount: order.amount,
          currency: order.currency,
          created_at: new Date().toISOString(),
        }),
      }),
    ),
  );
  console.log(`50 вебхуков за ${Date.now() - started}ms, ok=${results.length}`);

  const delivered = await waitDelivered(order.id);
  const rec = await json('/api/admin/reconciliation');

  console.log(
    JSON.stringify(
      {
        status: delivered.status,
        code: delivered.code,
        supplier: delivered.supplier,
        ledger_balanced: rec.ledger.balanced,
        paid_not_delivered: rec.paid_not_delivered.length,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
