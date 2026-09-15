import request from 'supertest';
import { createApp, paidWebhook } from '../test/helpers';

async function main() {
  const app = await createApp();
  const server = app.getHttpServer();

  await request(server).post('/internal/suppliers/B/behavior').send({ mode: 'always_out_of_stock' });

  const order = (
    await request(server)
      .post('/api/orders')
      .send({ items: [{ sku: 'STEAM-TOPUP-500' }, { sku: 'KEY-CS2-PRIME' }] })
      .expect(201)
  ).body;

  console.log('заказ', order.id, 'сумма', order.amount);

  await request(server)
    .post('/webhook/payment')
    .send(paidWebhook(order, `evt_partial_${order.id}`))
    .expect(200);

  for (let i = 0; i < 100; i++) {
    const got = (await request(server).get(`/api/orders/${order.id}`)).body;
    if (got.status === 'partially_fulfilled') {
      console.log('статус', got.status);
      console.log('позиции', got.items);
      const money = (await request(server).get(`/api/admin/orders/${order.id}/money`)).body;
      console.log('деньги', money);
      await app.close();
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error('timeout waiting partially_fulfilled');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
