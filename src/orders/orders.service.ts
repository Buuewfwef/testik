import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { JobsService } from '../jobs/jobs.service';
import { OrderEventsService } from '../events/order-events.service';
import { newOrderId } from '../common/ids';

type CreateInput = {
  sku?: string;
  items?: Array<{ sku: string }>;
  id?: string;
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly jobs: JobsService,
    private readonly events: OrderEventsService,
  ) {}

  async create(input: CreateInput) {
    const skus = input.items?.map((i) => i.sku) ?? (input.sku ? [input.sku] : []);
    if (skus.length === 0) {
      throw new BadRequestException({ error: 'items_required' });
    }

    const products = await this.prisma.product.findMany({
      where: { sku: { in: skus }, isActive: true },
    });
    if (products.length !== skus.length) {
      const found = new Set(products.map((p) => p.sku));
      const missing = skus.filter((s) => !found.has(s));
      throw new BadRequestException({ error: 'sku_not_found', skus: missing });
    }

    const bySku = new Map(products.map((p) => [p.sku, p]));
    const lines = skus.map((sku, idx) => {
      const p = bySku.get(sku)!;
      return {
        lineNo: idx + 1,
        sku: p.sku,
        supplier: p.supplier,
        amount: p.price,
        currency: p.currency,
      };
    });

    const amount = lines.reduce((s, l) => s + l.amount, 0);
    const currency = lines[0].currency;
    const id = input.id ?? newOrderId();
    const primarySku = lines[0].sku;

    let shouldDeliver = false;

    const order = await this.prisma.withOrderLock(id, async (tx) => {
      const created = await tx.order.create({
        data: {
          id,
          sku: primarySku,
          amount,
          currency,
          status: 'created',
          lineItems: {
            create: lines,
          },
        },
        include: { lineItems: { orderBy: { lineNo: 'asc' } } },
      });

      await this.events.append(tx, id, 'order_created', {
        amount,
        currency,
        items: lines.map((l) => ({ sku: l.sku, supplier: l.supplier, amount: l.amount })),
      });

      shouldDeliver = await this.payments.applyForNewOrder(tx, id);
      return tx.order.findUniqueOrThrow({
        where: { id: created.id },
        include: { lineItems: { orderBy: { lineNo: 'asc' } } },
      });
    });

    await this.jobs.enqueueDeliver(order.id, 0);
    if (shouldDeliver) {
      await this.jobs.enqueueDeliver(order.id, 10);
    }

    return this.present(order);
  }

  async get(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        lineItems: { orderBy: { lineNo: 'asc' } },
        deliveries: true,
      },
    });
    if (!order) {
      throw new NotFoundException({ error: 'order_not_found', id });
    }
    return this.present(order);
  }

  private present(order: {
    id: string;
    sku: string;
    amount: number;
    currency: string;
    status: string;
    code: string | null;
    supplier: string | null;
    lastError: string | null;
    createdAt: Date;
    paidAt: Date | null;
    deliveredAt: Date | null;
    lineItems?: Array<{
      id: string;
      lineNo: number;
      sku: string;
      supplier: string;
      amount: number;
      currency: string;
      status: string;
      code: string | null;
      supplierUsed: string | null;
      lastError: string | null;
      deliveredAt: Date | null;
      refundedAt: Date | null;
    }>;
  }) {
    const items = (order.lineItems ?? []).map((l) => ({
      id: l.id,
      line_no: l.lineNo,
      sku: l.sku,
      supplier: l.supplier,
      amount: l.amount,
      currency: l.currency,
      status: l.status,
      code: l.status === 'delivered' ? l.code : null,
      supplier_used: l.supplierUsed,
      last_error: l.lastError,
      delivered_at: l.deliveredAt?.toISOString() ?? null,
      refunded_at: l.refundedAt?.toISOString() ?? null,
    }));

    const singleDelivered = items.length === 1 && items[0].status === 'delivered';

    return {
      id: order.id,
      sku: order.sku,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      code: singleDelivered ? items[0].code : order.status === 'delivered' ? order.code : null,
      supplier: singleDelivered ? items[0].supplier_used : order.supplier,
      items,
      last_error: order.lastError,
      created_at: order.createdAt.toISOString(),
      paid_at: order.paidAt?.toISOString() ?? null,
      delivered_at: order.deliveredAt?.toISOString() ?? null,
    };
  }
}
