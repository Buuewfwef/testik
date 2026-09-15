import request from 'supertest';
import { createApp, paidWebhook } from '../test/helpers';

async function main() {
  const app = await createApp();
  const server = app.getHttpServer();

  for (const mode of ['wrong_code', 'error_after_issue', 'duplicate_code'] as const) {
    await request(server).post('/internal/suppliers/A/behavior').send({ mode });

    const order = (
      await request(server).post('/api/orders').send({ sku: 'STEAM-TOPUP-500' }).expect(201)
    ).body;

    await request(server)
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_evil_${mode}_${order.id}`))
      .expect(200);

    for (let i = 0; i < 80; i++) {
      const got = (await request(server).get(`/api/orders/${order.id}`)).body;
      if (got.status === 'delivered') {
        console.log(mode, '→ код', got.code, 'поставщик', got.supplier);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
