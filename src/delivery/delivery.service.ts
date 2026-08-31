import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { sleep, supplierRequestId } from '../common/ids';
import { LedgerService } from '../ledger/ledger.service';
import { SupplierClient } from '../suppliers/supplier-client';
import { SupplierError, SupplierId, SupplierTimeoutError } from '../suppliers/types';

type Attempt =
  | { ok: true; code: string; supplier: SupplierId }
  | { ok: false; reason: 'timeout' | 'unavailable' | 'out_of_stock' };

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly suppliers: SupplierClient,
    private readonly ledger: LedgerService,
  ) {}

  async deliver(orderId: string): Promise<void> {
    const claimed = await this.claim(orderId);
    if (!claimed) {
      return;
    }

    const a = await this.trySupplier('A', claimed.id, claimed.sku, { retries: 3 });
    if (a.ok) {
      await this.complete(claimed.id, 'A', a.code, claimed.amount, claimed.currency);
      return;
    }

    if (a.reason === 'timeout') {
      const recovered = await this.recoverIssued('A', claimed.id);
      if (recovered) {
        await this.complete(claimed.id, 'A', recovered, claimed.amount, claimed.currency);
        return;
      }
      await this.fail(claimed.id, 'delivery_failed', 'supplier_A_timeout_ambiguous');
      return;
    }

    const b = await this.trySupplier('B', claimed.id, claimed.sku, { retries: 3 });
    if (b.ok) {
      await this.complete(claimed.id, 'B', b.code, claimed.amount, claimed.currency);
      return;
    }

    if (a.reason === 'out_of_stock' && b.reason === 'out_of_stock') {
      await this.fail(claimed.id, 'out_of_stock', 'both_suppliers_out_of_stock');
      return;
    }

    await this.fail(claimed.id, 'delivery_failed', `A:${a.reason}|B:${b.reason}`);
  }

  private async claim(orderId: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; sku: string; amount: number; currency: string; status: OrderStatus }>
    >`
      UPDATE orders
      SET status = 'delivering', updated_at = NOW()
      WHERE id = ${orderId}
        AND (
          status IN ('paid'::"OrderStatus", 'out_of_stock'::"OrderStatus", 'delivery_failed'::"OrderStatus")
          OR (
            status = 'delivering'::"OrderStatus"
            AND updated_at < NOW() - INTERVAL '20 seconds'
          )
        )
      RETURNING id, sku, amount, currency, status
    `;
    return rows[0] ?? null;
  }

  private async trySupplier(
    supplier: SupplierId,
    orderId: string,
    sku: string,
    opts: { retries: number },
  ): Promise<Attempt> {
    const requestId = supplierRequestId(orderId, supplier);
    let last: Attempt = { ok: false, reason: 'unavailable' };

    for (let i = 0; i < opts.retries; i++) {
      const already = await this.recoverIssued(supplier, orderId);
      if (already) {
        return { ok: true, code: already, supplier };
      }

      try {
        const res = await this.suppliers.issue(supplier, {
          request_id: requestId,
          sku,
          order_id: orderId,
        });
        return { ok: true, code: res.code, supplier };
      } catch (err) {
        if (err instanceof SupplierTimeoutError) {
          let issued = await this.recoverIssued(supplier, orderId);
          if (!issued) {
            await sleep(50);
            issued = await this.recoverIssued(supplier, orderId);
          }
          if (issued) {
            return { ok: true, code: issued, supplier };
          }
          last = { ok: false, reason: 'timeout' };
          await this.backoff(i);
          continue;
        }
        if (err instanceof SupplierError) {
          last = { ok: false, reason: err.reason };
          if (err.reason === 'out_of_stock') {
            return last;
          }
          await this.backoff(i);
          continue;
        }
        throw err;
      }
    }

    const lastChance = await this.recoverIssued(supplier, orderId);
    if (lastChance) {
      return { ok: true, code: lastChance, supplier };
    }
    return last;
  }

  private async recoverIssued(supplier: SupplierId, orderId: string): Promise<string | null> {
    const peeked = await this.suppliers.peekIssue(supplierRequestId(orderId, supplier));
    return peeked?.code ?? null;
  }

  private async complete(
    orderId: string,
    supplier: SupplierId,
    code: string,
    amount: number,
    currency: string,
  ): Promise<void> {
    await this.prisma.withOrderLock(orderId, async (tx) => {
      const existing = await tx.delivery.findUnique({ where: { orderId } });
      if (existing) {
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: 'delivered',
            code: existing.code,
            supplier: existing.supplier,
            deliveredAt: existing.createdAt,
            lastError: null,
          },
        });
        return;
      }

      await tx.delivery.create({
        data: {
          orderId,
          requestId: supplierRequestId(orderId, supplier),
          supplier,
          code,
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'delivered',
          code,
          supplier,
          deliveredAt: new Date(),
          lastError: null,
        },
      });

      await this.ledger.recordDelivery(tx, orderId, amount, currency);
    });
  }

  private async fail(
    orderId: string,
    status: 'out_of_stock' | 'delivery_failed',
    reason: string,
  ): Promise<void> {
    await this.prisma.withOrderLock(orderId, async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || order.status === 'delivered') {
        return;
      }
      await tx.order.update({
        where: { id: orderId },
        data: { status, lastError: reason },
      });
    });
  }

  private backoff(attempt: number): Promise<void> {
    const ms = 100 * 2 ** attempt;
    return new Promise((r) => setTimeout(r, ms));
  }
}
