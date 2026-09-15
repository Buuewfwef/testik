import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createApp,
  createMultiOrder,
  createOrder,
  paidWebhook,
  prisma,
  resetStore,
  waitForOrder,
} from './helpers';

describe('stage 2', () => {
  let app: INestApplication;

  beforeAll(async () => {
    jest.setTimeout(30_000);
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetStore(app);
  });

  it('multi-item partial fulfillment with refund', async () => {
    await request(app.getHttpServer())
      .post('/internal/suppliers/B/behavior')
      .send({ mode: 'always_out_of_stock' })
      .expect(201);

    const order = await createMultiOrder(app, ['STEAM-TOPUP-500', 'KEY-CS2-PRIME']);
    expect(order.amount).toBe(500 + 1290);
    expect(order.items).toHaveLength(2);

    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_multi_${order.id}`))
      .expect(200);

    const done = await waitForOrder(app, order.id, ['partially_fulfilled'], 25_000);
    expect(done.items[0].status).toBe('delivered');
    expect(done.items[0].code).toBeTruthy();
    expect(done.items[1].status).toBe('refunded');
    expect(done.items[1].code).toBeNull();

    const money = await request(app.getHttpServer())
      .get(`/api/admin/orders/${order.id}/money`)
      .expect(200);
    expect(money.body.paid).toBe(order.amount);
    expect(money.body.delivered).toBe(500);
    expect(money.body.refunded).toBe(1290);
    expect(money.body.balanced).toBe(true);
  }, 30_000);

  it('idempotent retry does not double deliver or refund', async () => {
    await request(app.getHttpServer())
      .post('/internal/suppliers/B/behavior')
      .send({ mode: 'always_out_of_stock' })
      .expect(201);

    const order = await createMultiOrder(app, ['STEAM-TOPUP-500', 'KEY-CS2-PRIME']);
    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_idem_${order.id}`))
      .expect(200);

    await waitForOrder(app, order.id, ['partially_fulfilled'], 25_000);

    await request(app.getHttpServer()).post(`/api/admin/orders/${order.id}/retry`).expect(201);
    await request(app.getHttpServer()).post(`/api/admin/orders/${order.id}/retry`).expect(201);

    await new Promise((r) => setTimeout(r, 500));

    const db = prisma(app);
    expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
    const money = await request(app.getHttpServer())
      .get(`/api/admin/orders/${order.id}/money`)
      .expect(200);
    expect(money.body.balanced).toBe(true);
  }, 30_000);

  it('untrustworthy supplier wrong_code still delivers once', async () => {
    await request(app.getHttpServer())
      .post('/internal/suppliers/A/behavior')
      .send({ mode: 'wrong_code' })
      .expect(201);

    const order = await createOrder(app);
    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_wrong_${order.id}`))
      .expect(200);

    const delivered = await waitForOrder(app, order.id, ['delivered'], 25_000);
    expect(delivered.code).toBeTruthy();
    expect(delivered.code).not.toBe('FAKE-CODE-EVIL');

    const db = prisma(app);
    expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.supplierIssue.count({ where: { orderId: order.id } })).toBe(1);
  }, 30_000);

  it('error_after_issue does not double issue on retry', async () => {
    await request(app.getHttpServer())
      .post('/internal/suppliers/A/behavior')
      .send({ mode: 'error_after_issue' })
      .expect(201);

    const order = await createOrder(app);
    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_err_${order.id}`))
      .expect(200);

    const delivered = await waitForOrder(app, order.id, ['delivered'], 25_000);
    expect(delivered.code).toBeTruthy();

    const db = prisma(app);
    expect(await db.supplierIssue.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
  }, 30_000);

  it('duplicate code never reaches two orders', async () => {
    await request(app.getHttpServer())
      .post('/internal/suppliers/A/behavior')
      .send({ mode: 'duplicate_code' })
      .expect(201);

    const o1 = await createOrder(app);
    const o2 = await createOrder(app);

    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(o1, `evt_d1_${o1.id}`))
      .expect(200);
    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(o2, `evt_d2_${o2.id}`))
      .expect(200);

    await waitForOrder(app, o1.id, ['delivered'], 25_000);
    await waitForOrder(app, o2.id, ['delivered'], 25_000);

    const db = prisma(app);
    const deliveries = await db.delivery.findMany({
      where: { orderId: { in: [o1.id, o2.id] } },
    });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].code).not.toBe(deliveries[1].code);
  }, 30_000);

  it('point-in-time order replay', async () => {
    const order = await createOrder(app);
    const beforePay = new Date().toISOString();

    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_pit_${order.id}`))
      .expect(200);

    await waitForOrder(app, order.id, ['delivered'], 25_000);
    const after = new Date().toISOString();

    const atCreated = await request(app.getHttpServer())
      .get(`/api/admin/orders/${order.id}/at`)
      .query({ ts: beforePay })
      .expect(200);
    expect(atCreated.body.status).toBe('created');
    expect(atCreated.body.delivered_amount).toBe(0);

    const atDone = await request(app.getHttpServer())
      .get(`/api/admin/orders/${order.id}/at`)
      .query({ ts: after })
      .expect(200);
    expect(atDone.body.status).toBe('delivered');
    expect(atDone.body.delivered_amount).toBe(order.amount);
    expect(atDone.body.money_balanced).toBe(true);
  }, 30_000);

  it('queue stats visible under load', async () => {
    const orders = [];
    for (let i = 0; i < 6; i++) {
      orders.push(await createOrder(app));
    }

    for (const o of orders) {
      await request(app.getHttpServer())
        .post('/webhook/payment')
        .send(paidWebhook(o, `evt_q_${o.id}`))
        .expect(200);
    }

    await new Promise((r) => setTimeout(r, 800));

    const q = await request(app.getHttpServer()).get('/api/admin/queue').expect(200);
    expect(q.body.jobs).toHaveProperty('pending_jobs');
    expect(q.body.jobs).toHaveProperty('delivered_orders');
    expect(q.body.suppliers.A).toHaveProperty('limit');
    expect(q.body.suppliers.A).toHaveProperty('used');
  }, 30_000);
});
