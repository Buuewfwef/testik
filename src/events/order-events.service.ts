import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';

export type OrderEventType =
  | 'order_created'
  | 'payment_applied'
  | 'line_delivering'
  | 'line_delivered'
  | 'line_failed'
  | 'line_refunded'
  | 'order_status_changed'
  | 'supplier_discrepancy';

@Injectable()
export class OrderEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async append(
    tx: Tx,
    orderId: string,
    type: OrderEventType,
    payload: Record<string, unknown>,
    lineItemId?: string,
  ): Promise<void> {
    await tx.orderEvent.create({
      data: {
        orderId,
        lineItemId: lineItemId ?? null,
        type,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  async replayAt(orderId: string, at: Date) {
    const events = await this.prisma.orderEvent.findMany({
      where: { orderId, createdAt: { lte: at } },
      orderBy: { createdAt: 'asc' },
    });

    const lines = await this.prisma.orderLineItem.findMany({
      where: { orderId },
      orderBy: { lineNo: 'asc' },
    });

    let status = 'created';
    const lineState = new Map(
      lines.map((l) => [
        l.id,
        {
          line_no: l.lineNo,
          sku: l.sku,
          amount: l.amount,
          status: 'pending' as string,
          code: null as string | null,
        },
      ]),
    );

    let paidAmount = 0;
    let deliveredAmount = 0;
    let refundedAmount = 0;

    for (const e of events) {
      const p = e.payload as Record<string, unknown>;
      switch (e.type) {
        case 'order_created':
          status = 'created';
          break;
        case 'payment_applied':
          status = 'paid';
          paidAmount = Number(p.amount ?? 0);
          break;
        case 'line_delivering':
          if (e.lineItemId) {
            const s = lineState.get(e.lineItemId);
            if (s) s.status = 'delivering';
          }
          status = 'delivering';
          break;
        case 'line_delivered':
          if (e.lineItemId) {
            const s = lineState.get(e.lineItemId);
            if (s) {
              s.status = 'delivered';
              s.code = String(p.code ?? '');
              deliveredAmount += Number(p.amount ?? 0);
            }
          }
          break;
        case 'line_failed':
          if (e.lineItemId) {
            const s = lineState.get(e.lineItemId);
            if (s) s.status = 'failed';
          }
          break;
        case 'line_refunded':
          if (e.lineItemId) {
            const s = lineState.get(e.lineItemId);
            if (s) {
              s.status = 'refunded';
              refundedAmount += Number(p.amount ?? 0);
            }
          }
          break;
        case 'order_status_changed':
          status = String(p.status ?? status);
          break;
        default:
          break;
      }
    }

    const items = [...lineState.values()].sort((a, b) => a.line_no - b.line_no);

    return {
      order_id: orderId,
      at: at.toISOString(),
      status,
      paid_amount: paidAmount,
      delivered_amount: deliveredAmount,
      refunded_amount: refundedAmount,
      money_balanced: paidAmount === 0 || paidAmount === deliveredAmount + refundedAmount,
      items,
      events: events.map((e) => ({
        type: e.type,
        line_item_id: e.lineItemId,
        payload: e.payload,
        at: e.createdAt.toISOString(),
      })),
    };
  }

  async periodTotals(from: Date, to: Date) {
    const rows = await this.prisma.ledgerEntry.findMany({
      where: { createdAt: { gte: from, lte: to } },
    });

    let debit = 0;
    let credit = 0;
    for (const r of rows) {
      if (r.direction === 'debit') debit += r.amount;
      else credit += r.amount;
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      entries: rows.length,
      debit,
      credit,
      balanced: debit === credit,
    };
  }
}
