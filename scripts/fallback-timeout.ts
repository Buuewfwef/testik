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

async function payAndWait(label: string, sku = 'STEAM-TOPUP-500') {
  const order = await json('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ sku, id: newOrderId() }),
  });
  await json('/webhook/payment', {
    method: 'POST',
    body: JSON.stringify({
      event_id: `evt_${label}_${order.id}`,
      order_id: order.id,
      status: 'paid',
      amount: order.amount,
      currency: order.currency,
      created_at: new Date().toISOString(),
    }),
  });
  const started = Date.now();
  while (Date.now() - started < 25_000) {
    const current = await json(`/api/orders/${order.id}`);
    if (['delivered', 'out_of_stock', 'delivery_failed'].includes(current.status)) {
      return current;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${label}: слишком долго`);
}

async function main() {
  await json('/internal/suppliers/A/behavior', {
    method: 'POST',
    body: JSON.stringify({ mode: 'always_timeout' }),
  });
  await json('/internal/suppliers/B/behavior', {
    method: 'POST',
    body: JSON.stringify({ mode: 'normal' }),
  });
  const timeoutCase = await payAndWait('timeout');
  console.log('таймаут A', {
    status: timeoutCase.status,
    supplier: timeoutCase.supplier,
    code: timeoutCase.code,
  });

  await json('/internal/suppliers/A/behavior', {
    method: 'POST',
    body: JSON.stringify({ mode: 'always_unavailable' }),
  });
  const fallbackCase = await payAndWait('fallback');
  console.log('A недоступен, выдал B', {
    status: fallbackCase.status,
    supplier: fallbackCase.supplier,
    code: fallbackCase.code,
  });

  await json('/internal/suppliers/A/behavior', {
    method: 'POST',
    body: JSON.stringify({ mode: 'normal' }),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
