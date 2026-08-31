import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { newOrderId } from '../src/common/ids';

export { newOrderId };

export async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  await app.init();
  return app;
}

export function prisma(app: INestApplication): PrismaService {
  return app.get(PrismaService);
}

export async function resetStore(app: INestApplication): Promise<void> {
  const db = prisma(app);
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      jobs,
      ledger_entries,
      deliveries,
      payment_events,
      supplier_issues,
      orders
    RESTART IDENTITY CASCADE
  `);
  await db.$executeRawUnsafe(`
    UPDATE inventory_keys
    SET status = 'available', order_id = NULL, supplier = NULL, issued_at = NULL
  `);
  await db.$executeRawUnsafe(`
    UPDATE sku_stock s
    SET available = COALESCE(k.cnt, 0)
    FROM (
      SELECT sku, COUNT(*)::int AS cnt
      FROM inventory_keys
      WHERE status = 'available'
      GROUP BY sku
    ) k
    WHERE s.sku = k.sku
  `);
  await request(app.getHttpServer())
    .post('/internal/suppliers/A/behavior')
    .send({ mode: 'normal' });
  await request(app.getHttpServer())
    .post('/internal/suppliers/B/behavior')
    .send({ mode: 'normal' });
}

export async function createOrder(app: INestApplication, sku = 'STEAM-TOPUP-500', id?: string) {
  const res = await request(app.getHttpServer())
    .post('/api/orders')
    .send(id ? { sku, id } : { sku })
    .expect(201);
  return res.body as {
    id: string;
    sku: string;
    amount: number;
    currency: string;
    status: string;
  };
}

export function paidWebhook(order: { id: string; amount: number; currency: string }, eventId: string) {
  return {
    event_id: eventId,
    order_id: order.id,
    status: 'paid' as const,
    amount: order.amount,
    currency: order.currency,
    created_at: new Date().toISOString(),
  };
}

export async function waitForOrder(
  app: INestApplication,
  id: string,
  statuses: string[],
  timeoutMs = 20_000,
) {
  const started = Date.now();
  let last: Record<string, unknown> | undefined;
  while (Date.now() - started < timeoutMs) {
    const res = await request(app.getHttpServer()).get(`/api/orders/${id}`);
    last = res.body;
    if (statuses.includes(res.body.status)) {
      return res.body;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `order ${id} did not reach ${statuses.join('|')} within ${timeoutMs}ms, last=${JSON.stringify(last)}`,
  );
}
