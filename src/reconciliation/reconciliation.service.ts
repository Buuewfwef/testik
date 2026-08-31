import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class ReconciliationService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly ledger: LedgerService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.recoverStuck(), 5000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async snapshot() {
    const paidNotDelivered = await this.prisma.$queryRaw<
      Array<{ id: string; status: string; sku: string; updated_at: Date }>
    >`
      SELECT o.id, o.status::text AS status, o.sku, o.updated_at
      FROM orders o
      LEFT JOIN deliveries d ON d.order_id = o.id
      WHERE d.id IS NULL
        AND (
          o.status IN ('paid'::"OrderStatus", 'delivering'::"OrderStatus",
                       'out_of_stock'::"OrderStatus", 'delivery_failed'::"OrderStatus")
          OR EXISTS (
            SELECT 1 FROM payment_events pe
            WHERE pe.order_id = o.id AND pe.status = 'paid'
          )
        )
      ORDER BY o.created_at
    `;

    const deliveredNotPaid = await this.prisma.$queryRaw<
      Array<{ id: string; status: string }>
    >`
      SELECT o.id, o.status::text AS status
      FROM orders o
      INNER JOIN deliveries d ON d.order_id = o.id
      WHERE NOT EXISTS (
        SELECT 1 FROM payment_events pe
        WHERE pe.order_id = o.id AND pe.status = 'paid'
      )
    `;

    const ledger = await this.ledger.totals();

    return {
      paid_not_delivered: paidNotDelivered.map((r) => ({
        id: r.id,
        status: r.status,
        sku: r.sku,
        updated_at: r.updated_at,
      })),
      delivered_not_paid: deliveredNotPaid,
      ledger,
    };
  }

  async recoverStuck(): Promise<{ enqueued: number }> {
    const stuck = await this.prisma.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT o.id, o.status::text AS status
      FROM orders o
      LEFT JOIN deliveries d ON d.order_id = o.id
      LEFT JOIN sku_stock s ON s.sku = o.sku
      WHERE d.id IS NULL
        AND (
          o.status = 'paid'::"OrderStatus"
          OR (
            o.status = 'delivering'::"OrderStatus"
            AND o.updated_at < NOW() - INTERVAL '20 seconds'
          )
          OR (
            o.status = 'out_of_stock'::"OrderStatus"
            AND COALESCE(s.available, 0) > 0
          )
          OR o.status = 'delivery_failed'::"OrderStatus"
        )
    `;

    for (const row of stuck) {
      await this.jobs.enqueueDeliver(row.id);
    }

    return { enqueued: stuck.length };
  }

  async replenish(sku: string, codes: string[]) {
    await this.prisma.$transaction(async (tx) => {
      for (const code of codes) {
        await tx.inventoryKey.upsert({
          where: { code },
          create: { sku, code, status: 'available' },
          update: {
            sku,
            status: 'available',
            orderId: null,
            supplier: null,
            issuedAt: null,
          },
        });
      }
      const available = await tx.inventoryKey.count({
        where: { sku, status: 'available' },
      });
      await tx.skuStock.upsert({
        where: { sku },
        update: { available },
        create: { sku, available },
      });
    });
    return this.prisma.skuStock.findUnique({ where: { sku } });
  }
}
