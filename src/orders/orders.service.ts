import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { JobsService } from '../jobs/jobs.service';
import { newOrderId } from '../common/ids';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly jobs: JobsService,
  ) {}

  async create(sku: string, id = newOrderId()) {
    const product = await this.prisma.product.findUnique({
      where: { sku },
      include: { stock: true },
    });
    if (!product || !product.isActive) {
      throw new BadRequestException({ error: 'sku_not_found', sku });
    }

    let shouldDeliver = false;

    const order = await this.prisma.withOrderLock(id, async (tx) => {
      const created = await tx.order.create({
        data: {
          id,
          sku: product.sku,
          amount: product.price,
          currency: product.currency,
          status: 'created',
        },
      });
      shouldDeliver = await this.payments.applyForNewOrder(tx, id);
      return tx.order.findUniqueOrThrow({ where: { id: created.id } });
    });

    if (shouldDeliver) {
      await this.jobs.enqueueDeliver(order.id);
    }

    return this.present(order);
  }

  async get(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { deliveries: true },
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
  }) {
    return {
      id: order.id,
      sku: order.sku,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      code: order.status === 'delivered' ? order.code : null,
      supplier: order.supplier,
      last_error: order.lastError,
      created_at: order.createdAt.toISOString(),
      paid_at: order.paidAt?.toISOString() ?? null,
      delivered_at: order.deliveredAt?.toISOString() ?? null,
    };
  }
}
