import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createApp,
  createOrder,
  newOrderId,
  paidWebhook,
  prisma,
  resetStore,
  waitForOrder,
} from './helpers';

describe('api', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetStore(app);
  });

  it('create and get order', async () => {
    const created = await createOrder(app);
    expect(created.status).toBe('created');
    expect(created.amount).toBe(500);

    const got = await request(app.getHttpServer()).get(`/api/orders/${created.id}`).expect(200);
    expect(got.body.id).toBe(created.id);
    expect(got.body.code).toBeNull();
  });

  it('paid webhook delivers a code', async () => {
    const order = await createOrder(app);
    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_${order.id}`))
      .expect(200);

    const delivered = await waitForOrder(app, order.id, ['delivered']);
    expect(delivered.code).toMatch(/^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+/);
    expect(delivered.supplier).toBe('A');

    const db = prisma(app);
    expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.supplierIssue.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('50 parallel webhooks, one code', async () => {
    const order = await createOrder(app);
    const payloads = Array.from({ length: 50 }, (_, i) =>
      paidWebhook(order, `evt_race_${order.id}_${i}`),
    );

    const results = await Promise.all(
      payloads.map((body) => request(app.getHttpServer()).post('/webhook/payment').send(body)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    const delivered = await waitForOrder(app, order.id, ['delivered']);
    const db = prisma(app);
    expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.supplierIssue.count({ where: { orderId: order.id } })).toBe(1);
    expect(delivered.code).toBeTruthy();

    const keys = await db.inventoryKey.count({
      where: { orderId: order.id, status: 'issued' },
    });
    expect(keys).toBe(1);
  });

  it('same event_id does nothing', async () => {
    const order = await createOrder(app);
    const body = paidWebhook(order, `evt_dup_${order.id}`);

    const first = await request(app.getHttpServer()).post('/webhook/payment').send(body).expect(200);
    expect(first.body.duplicate).toBe(false);

    const delivered = await waitForOrder(app, order.id, ['delivered']);
    const code = delivered.code;

    const second = await request(app.getHttpServer()).post('/webhook/payment').send(body).expect(200);
    expect(second.body.duplicate).toBe(true);

    const again = await request(app.getHttpServer()).get(`/api/orders/${order.id}`).expect(200);
    expect(again.body.status).toBe('delivered');
    expect(again.body.code).toBe(code);
    expect(await prisma(app).delivery.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('webhook before order', async () => {
    const id = newOrderId();
    const early = {
      event_id: `evt_early_${id}`,
      order_id: id,
      status: 'paid' as const,
      amount: 500,
      currency: 'RUB',
      created_at: new Date().toISOString(),
    };

    await request(app.getHttpServer()).post('/webhook/payment').send(early).expect(200);

    const created = await createOrder(app, 'STEAM-TOPUP-500', id);
    expect(['created', 'paid', 'delivering', 'delivered']).toContain(created.status);

    const delivered = await waitForOrder(app, id, ['delivered']);
    expect(delivered.code).toBeTruthy();
  });

  it('failed then paid', async () => {
    const order = await createOrder(app);
    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send({
        event_id: `evt_fail_${order.id}`,
        order_id: order.id,
        status: 'failed',
        amount: order.amount,
        currency: order.currency,
        created_at: new Date().toISOString(),
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_paid_${order.id}`))
      .expect(200);

    const delivered = await waitForOrder(app, order.id, ['delivered']);
    expect(delivered.code).toBeTruthy();
  });

  it('timeout does not issue twice', async () => {
    await request(app.getHttpServer())
      .post('/internal/suppliers/A/behavior')
      .send({ mode: 'always_timeout' })
      .expect(201);

    const order = await createOrder(app);
    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_to_${order.id}`))
      .expect(200);

    const delivered = await waitForOrder(app, order.id, ['delivered'], 25_000);
    const db = prisma(app);
    expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.supplierIssue.count({ where: { orderId: order.id } })).toBe(1);
    expect(delivered.supplier).toBe('A');
    expect(delivered.code).toBeTruthy();
  });

  it('fallback to B', async () => {
    await request(app.getHttpServer())
      .post('/internal/suppliers/A/behavior')
      .send({ mode: 'always_unavailable' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/internal/suppliers/B/behavior')
      .send({ mode: 'normal' })
      .expect(201);

    const order = await createOrder(app);
    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_fb_${order.id}`))
      .expect(200);

    const delivered = await waitForOrder(app, order.id, ['delivered'], 25_000);
    expect(delivered.supplier).toBe('B');
    const db = prisma(app);
    expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
    const issues = await db.supplierIssue.findMany({ where: { orderId: order.id } });
    expect(issues).toHaveLength(1);
    expect(issues[0].supplier).toBe('B');
  });

  it('out of stock then recover', async () => {
    const db = prisma(app);
    await db.inventoryKey.updateMany({
      where: { sku: 'STEAM-TOPUP-500' },
      data: { status: 'issued' },
    });
    await db.skuStock.update({
      where: { sku: 'STEAM-TOPUP-500' },
      data: { available: 0 },
    });

    const order = await createOrder(app);
    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_oos_${order.id}`))
      .expect(200);

    const oos = await waitForOrder(app, order.id, ['out_of_stock']);
    expect(oos.code).toBeNull();

    await request(app.getHttpServer())
      .post('/api/admin/inventory/replenish')
      .send({ sku: order.sku, codes: ['RCVR-TEST-0001'] })
      .expect(201);

    await request(app.getHttpServer()).post(`/api/admin/orders/${order.id}/retry`).expect(201);

    const delivered = await waitForOrder(app, order.id, ['delivered']);
    expect(delivered.code).toBe('RCVR-TEST-0001');
  }, 20_000);

  it('ledger balances', async () => {
    const order = await createOrder(app);
    await request(app.getHttpServer())
      .post('/webhook/payment')
      .send(paidWebhook(order, `evt_led_${order.id}`))
      .expect(200);
    await waitForOrder(app, order.id, ['delivered']);

    const rec = await request(app.getHttpServer()).get('/api/admin/reconciliation').expect(200);
    expect(rec.body.ledger.balanced).toBe(true);
    expect(rec.body.ledger.debit).toBe(rec.body.ledger.credit);
    expect(rec.body.delivered_not_paid).toHaveLength(0);
    expect(rec.body.paid_not_delivered).toHaveLength(0);
  });

  it('catalog', async () => {
    const res = await request(app.getHttpServer()).get('/api/catalog?limit=20').expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.total).toBeGreaterThan(1000);
    expect(res.body.items[0]).toHaveProperty('available');

    const plan = await request(app.getHttpServer()).get('/api/catalog/explain').expect(200);
    expect(JSON.stringify(plan.body)).toMatch(/Index|Scan|Nested Loop|Hash/i);
  });
});
