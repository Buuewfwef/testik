import { Injectable } from '@nestjs/common';
import { LineItemStatus, OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { sleep, supplierRequestId } from '../common/ids';
import { OrderEventsService } from '../events/order-events.service';
import { LedgerService } from '../ledger/ledger.service';
import { SupplierClient } from '../suppliers/supplier-client';
import { SupplierError, SupplierId, SupplierTimeoutError } from '../suppliers/types';

type Attempt =
  | { ok: true; code: string; supplier: SupplierId }
  | { ok: false; reason: 'timeout' | 'unavailable' | 'out_of_stock' | 'duplicate_code' | 'wrong_code' };

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly suppliers: SupplierClient,
    private readonly ledger: LedgerService,
    private readonly events: OrderEventsService,
  ) {}

  async deliver(orderId: string): Promise<void> {
    const claimed = await this.claim(orderId);
    if (!claimed) {
      return;
    }

    const lines = await this.prisma.orderLineItem.findMany({
      where: { orderId, status: { in: ['pending', 'delivering', 'failed'] } },
      orderBy: { lineNo: 'asc' },
    });

    for (const line of lines) {
      if (line.status === 'delivered' || line.status === 'refunded') {
        continue;
      }

      await this.markLineDelivering(orderId, line.id);

      const primary = line.supplier as SupplierId;
      let attempt = await this.trySupplier(primary, orderId, line.id, line.sku, { retries: 3 });
      let usedSupplier = primary;

      if (!attempt.ok && primary === 'A' && attempt.reason !== 'timeout') {
        const fallback = await this.trySupplier('B', orderId, line.id, line.sku, { retries: 3 });
        if (fallback.ok) {
          attempt = fallback;
          usedSupplier = 'B';
        }
      }

      if (attempt.ok) {
        await this.completeLine(orderId, line.id, usedSupplier, attempt.code, line.amount, line.currency);
        continue;
      }

      if (attempt.reason === 'timeout') {
        const recovered = await this.recoverIssued(primary, orderId, line.id);
        if (recovered) {
          await this.completeLine(orderId, line.id, primary, recovered, line.amount, line.currency);
          continue;
        }
      }

      const peeked = await this.recoverIssued(primary, orderId, line.id);
      if (peeked) {
        await this.completeLine(orderId, line.id, primary, peeked, line.amount, line.currency);
        continue;
      }

      if (primary === 'A') {
        const peekedB = await this.recoverIssued('B', orderId, line.id);
        if (peekedB) {
          await this.completeLine(orderId, line.id, 'B', peekedB, line.amount, line.currency);
          continue;
        }
      }

      await this.failLine(orderId, line.id, attempt.reason);
      if (this.shouldRefund(attempt.reason, lines.length)) {
        await this.refundLine(orderId, line.id, line.amount, line.currency, attempt.reason);
      }
    }

    await this.finalizeOrder(orderId);
    await this.reconcileSupplierIssues(orderId);
  }

  private async claim(orderId: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE orders
      SET status = 'delivering', updated_at = NOW()
      WHERE id = ${orderId}
        AND (
          status IN (
            'paid'::"OrderStatus",
            'out_of_stock'::"OrderStatus",
            'delivery_failed'::"OrderStatus",
            'partially_fulfilled'::"OrderStatus"
          )
          OR (
            status = 'delivering'::"OrderStatus"
            AND updated_at < NOW() - INTERVAL '20 seconds'
          )
        )
      RETURNING id
    `;
    return rows[0] ?? null;
  }

  private async markLineDelivering(orderId: string, lineItemId: string): Promise<void> {
    await this.prisma.withOrderLock(orderId, async (tx) => {
      await tx.orderLineItem.updateMany({
        where: { id: lineItemId, status: { in: ['pending', 'failed'] } },
        data: { status: 'delivering' },
      });
      await this.events.append(tx, orderId, 'line_delivering', {}, lineItemId);
    });
  }

  private async trySupplier(
    supplier: SupplierId,
    orderId: string,
    lineItemId: string,
    sku: string,
    opts: { retries: number },
  ): Promise<Attempt> {
    const requestId = supplierRequestId(orderId, lineItemId, supplier);
    let last: Attempt = { ok: false, reason: 'unavailable' };

    for (let i = 0; i < opts.retries; i++) {
      const already = await this.recoverIssued(supplier, orderId, lineItemId);
      if (already) {
        return { ok: true, code: already, supplier };
      }

      try {
        const res = await this.suppliers.issue(supplier, {
          request_id: requestId,
          sku,
          order_id: orderId,
          line_item_id: lineItemId,
        });
        const trusted = await this.trustedCode(requestId, res.code);
        if (!trusted) {
          last = { ok: false, reason: 'wrong_code' };
          await this.backoff(i);
          continue;
        }
        const dup = await this.codeTakenByOther(trusted, lineItemId);
        if (dup) {
          last = { ok: false, reason: 'duplicate_code' };
          await this.backoff(i);
          continue;
        }
        return { ok: true, code: trusted, supplier };
      } catch (err) {
        if (err instanceof SupplierTimeoutError) {
          let issued = await this.recoverIssued(supplier, orderId, lineItemId);
          if (!issued) {
            await sleep(50);
            issued = await this.recoverIssued(supplier, orderId, lineItemId);
          }
          if (issued) {
            return { ok: true, code: issued, supplier };
          }
          last = { ok: false, reason: 'timeout' };
          await this.backoff(i);
          continue;
        }
        if (err instanceof SupplierError) {
          const recovered = await this.recoverIssued(supplier, orderId, lineItemId);
          if (recovered) {
            return { ok: true, code: recovered, supplier };
          }
          if (err.reason === 'out_of_stock' || err.reason === 'duplicate_code' || err.reason === 'wrong_code') {
            return { ok: false, reason: err.reason };
          }
          last = { ok: false, reason: 'unavailable' };
          await this.backoff(i);
          continue;
        }
        throw err;
      }
    }

    const lastChance = await this.recoverIssued(supplier, orderId, lineItemId);
    if (lastChance) {
      return { ok: true, code: lastChance, supplier };
    }
    return last;
  }

  private async trustedCode(requestId: string, responseCode: string): Promise<string | null> {
    const peeked = await this.suppliers.peekIssue(requestId);
    if (!peeked) {
      return null;
    }
    if (peeked.code !== responseCode) {
      return peeked.code;
    }
    return peeked.code;
  }

  private async codeTakenByOther(code: string, lineItemId: string): Promise<boolean> {
    const existing = await this.prisma.delivery.findUnique({ where: { code } });
    return !!existing && existing.lineItemId !== lineItemId;
  }

  private async recoverIssued(
    supplier: SupplierId,
    orderId: string,
    lineItemId: string,
  ): Promise<string | null> {
    const peeked = await this.suppliers.peekIssue(supplierRequestId(orderId, lineItemId, supplier));
    if (!peeked) {
      return null;
    }
    const dup = await this.codeTakenByOther(peeked.code, lineItemId);
    return dup ? null : peeked.code;
  }

  private async completeLine(
    orderId: string,
    lineItemId: string,
    supplier: SupplierId,
    code: string,
    amount: number,
    currency: string,
  ): Promise<void> {
    await this.prisma.withOrderLock(orderId, async (tx) => {
      const existing = await tx.delivery.findUnique({ where: { lineItemId } });
      if (existing) {
        await tx.orderLineItem.update({
          where: { id: lineItemId },
          data: {
            status: 'delivered',
            code: existing.code,
            supplierUsed: existing.supplier,
            deliveredAt: existing.createdAt,
            lastError: null,
          },
        });
        return;
      }

      const dup = await tx.delivery.findUnique({ where: { code } });
      if (dup) {
        await tx.orderLineItem.update({
          where: { id: lineItemId },
          data: { status: 'failed', lastError: 'duplicate_code_rejected' },
        });
        await this.events.append(
          tx,
          orderId,
          'supplier_discrepancy',
          { code, reason: 'duplicate_code' },
          lineItemId,
        );
        return;
      }

      await tx.delivery.create({
        data: {
          orderId,
          lineItemId,
          requestId: supplierRequestId(orderId, lineItemId, supplier),
          supplier,
          code,
        },
      });

      await tx.orderLineItem.update({
        where: { id: lineItemId },
        data: {
          status: 'delivered',
          code,
          supplierUsed: supplier,
          deliveredAt: new Date(),
          lastError: null,
        },
      });

      await this.ledger.recordDelivery(tx, orderId, lineItemId, amount, currency);
      await this.events.append(
        tx,
        orderId,
        'line_delivered',
        { code, amount, supplier },
        lineItemId,
      );
    });
  }

  private async failLine(orderId: string, lineItemId: string, reason: string): Promise<void> {
    await this.prisma.withOrderLock(orderId, async (tx) => {
      const line = await tx.orderLineItem.findUnique({ where: { id: lineItemId } });
      if (!line || line.status === 'delivered' || line.status === 'refunded') {
        return;
      }
      await tx.orderLineItem.update({
        where: { id: lineItemId },
        data: { status: 'failed', lastError: reason },
      });
      await this.events.append(tx, orderId, 'line_failed', { reason }, lineItemId);
    });
  }

  private async refundLine(
    orderId: string,
    lineItemId: string,
    amount: number,
    currency: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.withOrderLock(orderId, async (tx) => {
      const line = await tx.orderLineItem.findUnique({ where: { id: lineItemId } });
      if (!line || line.status === 'delivered' || line.status === 'refunded') {
        return;
      }
      await tx.orderLineItem.update({
        where: { id: lineItemId },
        data: { status: 'refunded', refundedAt: new Date(), lastError: reason },
      });
      await this.ledger.recordRefund(tx, orderId, lineItemId, amount, currency);
      await this.events.append(tx, orderId, 'line_refunded', { amount, reason }, lineItemId);
    });
  }

  private shouldRefund(reason: string, lineCount: number): boolean {
    if (reason === 'out_of_stock' && lineCount === 1) {
      return false;
    }
    return true;
  }

  private async finalizeOrder(orderId: string): Promise<void> {
    await this.prisma.withOrderLock(orderId, async (tx) => {
      const lines = await tx.orderLineItem.findMany({ where: { orderId } });
      const delivered = lines.filter((l) => l.status === 'delivered');
      const refunded = lines.filter((l) => l.status === 'refunded');
      const failed = lines.filter((l) => l.status === 'failed');
      const pending = lines.filter((l) => l.status === 'pending' || l.status === 'delivering');

      if (pending.length > 0) {
        return;
      }

      let status: OrderStatus;
      if (delivered.length === lines.length) {
        status = 'delivered';
      } else if (delivered.length > 0 && (refunded.length > 0 || failed.length > 0)) {
        status = 'partially_fulfilled';
      } else if (delivered.length === 0 && failed.length === lines.length) {
        status = 'out_of_stock';
      } else if (delivered.length === 0 && refunded.length === lines.length) {
        status = 'delivery_failed';
      } else {
        status = 'delivery_failed';
      }

      const firstCode = delivered.length === 1 ? delivered[0].code : null;
      const firstSupplier = delivered.length === 1 ? delivered[0].supplierUsed : null;

      await tx.order.update({
        where: { id: orderId },
        data: {
          status,
          code: firstCode,
          supplier: firstSupplier,
          deliveredAt: delivered.length > 0 ? new Date() : null,
          lastError: refunded.length > 0 ? 'partial_or_full_refund' : null,
        },
      });

      await this.events.append(tx, orderId, 'order_status_changed', { status });
    });
  }

  private async reconcileSupplierIssues(orderId: string): Promise<void> {
    const issues = await this.prisma.supplierIssue.findMany({ where: { orderId } });
    for (const issue of issues) {
      if (!issue.lineItemId) continue;
      const delivery = await this.prisma.delivery.findUnique({
        where: { requestId: issue.requestId },
      });
      const line = await this.prisma.orderLineItem.findUnique({ where: { id: issue.lineItemId } });
      if (!delivery && line && line.status === 'failed') {
        await this.completeLine(
          orderId,
          issue.lineItemId,
          issue.supplier as SupplierId,
          issue.code,
          line.amount,
          line.currency,
        );
      }
    }
  }

  private backoff(attempt: number): Promise<void> {
    const ms = 100 * 2 ** attempt;
    return new Promise((r) => setTimeout(r, ms));
  }
}
