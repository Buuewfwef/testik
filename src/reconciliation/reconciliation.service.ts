import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { LedgerService } from '../ledger/ledger.service';
import { SuppliersService } from '../suppliers/suppliers.service';

@Injectable()
export class ReconciliationService {
  private timer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly ledger: LedgerService,
    private readonly suppliers: SuppliersService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.recoverStuck(), 5000);
    this.reconcileTimer = setInterval(() => void this.reconcileSupplier(), 7000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  async snapshot() {
    const paidNotDelivered = await this.prisma.$queryRaw<
      Array<{ id: string; status: string; sku: string; updated_at: Date }>
    >`
      SELECT o.id, o.status::text AS status, o.sku, o.updated_at
      FROM orders o
      WHERE o.status IN (
        'paid'::"OrderStatus",
        'delivering'::"OrderStatus",
        'out_of_stock'::"OrderStatus",
        'delivery_failed'::"OrderStatus"
      )
      AND EXISTS (
        SELECT 1 FROM order_line_items li
        WHERE li.order_id = o.id
          AND li.status IN ('pending', 'delivering', 'failed')
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
    const duplicateCodes = await this.suppliers.findDuplicateCodes();
    const unreconciled = await this.suppliers.unreconciledIssues();

    return {
      paid_not_delivered: paidNotDelivered.map((r) => ({
        id: r.id,
        status: r.status,
        sku: r.sku,
        updated_at: r.updated_at,
      })),
      delivered_not_paid: deliveredNotPaid,
      supplier_discrepancies: {
        duplicate_codes: duplicateCodes,
        unreconciled_issues: unreconciled,
      },
      ledger,
    };
  }

  async recoverStuck(): Promise<{ enqueued: number }> {
    const stuck = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT o.id
      FROM orders o
      WHERE EXISTS (
        SELECT 1 FROM order_line_items li
        WHERE li.order_id = o.id
          AND li.status IN ('pending', 'delivering', 'failed')
      )
      AND (
        o.status = 'paid'::"OrderStatus"
        OR (
          o.status = 'delivering'::"OrderStatus"
          AND o.updated_at < NOW() - INTERVAL '20 seconds'
        )
        OR o.status = 'delivery_failed'::"OrderStatus"
        OR (
          o.status = 'out_of_stock'::"OrderStatus"
          AND EXISTS (
            SELECT 1 FROM order_line_items li2
            INNER JOIN sku_stock s ON s.sku = li2.sku
            WHERE li2.order_id = o.id
              AND li2.status IN ('pending', 'failed')
              AND s.available > 0
          )
        )
      )
    `;

    for (const row of stuck) {
      await this.jobs.enqueueDeliver(row.id, 10);
    }

    return { enqueued: stuck.length };
  }

  async reconcileSupplier(): Promise<{ fixed: number }> {
    const issues = await this.suppliers.unreconciledIssues();
    let fixed = 0;
    for (const issue of issues) {
      if (!issue.line_item_id) continue;
      await this.jobs.enqueueDeliver(issue.order_id, 10);
      fixed += 1;
    }
    return { fixed };
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
