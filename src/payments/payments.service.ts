import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { JobsService } from '../jobs/jobs.service';
import { OrderEventsService } from '../events/order-events.service';

export interface PaymentWebhook {
  event_id: string;
  order_id: string;
  status: 'paid' | 'failed';
  amount: number;
  currency: string;
  created_at: string;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly jobs: JobsService,
    private readonly events: OrderEventsService,
  ) {}

  async handleWebhook(body: PaymentWebhook): Promise<{ accepted: true; duplicate: boolean }> {
    if (body.status !== 'paid' && body.status !== 'failed') {
      throw new BadRequestException({ error: 'invalid_status' });
    }

    let duplicate = false;
    let shouldDeliver = false;

    await this.prisma.withOrderLock(body.order_id, async (tx) => {
      const inserted = await tx.paymentEvent.createMany({
        data: {
          eventId: body.event_id,
          orderId: body.order_id,
          status: body.status,
          amount: body.amount,
          currency: body.currency,
          payload: body as unknown as Prisma.InputJsonValue,
          occurredAt: new Date(body.created_at),
        },
        skipDuplicates: true,
      });

      duplicate = inserted.count === 0;
      if (duplicate) {
        return;
      }

      shouldDeliver = await this.applyLocked(tx, body.order_id);
    });

    if (shouldDeliver) {
      await this.jobs.enqueueDeliver(body.order_id, 10);
    }

    return { accepted: true, duplicate };
  }

  async applyForNewOrder(tx: Tx, orderId: string): Promise<boolean> {
    return this.applyLocked(tx, orderId);
  }

  private async applyLocked(tx: Tx, orderId: string): Promise<boolean> {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return false;
    }

    if (
      order.status === 'delivered' ||
      order.status === 'delivering' ||
      order.status === 'partially_fulfilled'
    ) {
      return false;
    }

    const events = await tx.paymentEvent.findMany({ where: { orderId } });
    const paid = events.find((e) => e.status === 'paid');
    const failed = events.find((e) => e.status === 'failed');

    if (paid) {
      if (paid.amount !== order.amount || paid.currency !== order.currency) {
        return false;
      }

      if (order.status === 'created' || order.status === 'payment_failed') {
        await tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.paid, paidAt: new Date(), lastError: null },
        });
        await this.ledger.recordPayment(tx, orderId, order.amount, order.currency);
        await this.events.append(tx, orderId, 'payment_applied', {
          amount: order.amount,
          currency: order.currency,
        });
        return true;
      }

      return order.status === 'out_of_stock' || order.status === 'delivery_failed';
    }

    if (failed && order.status === 'created') {
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.payment_failed },
      });
    }

    return false;
  }
}
