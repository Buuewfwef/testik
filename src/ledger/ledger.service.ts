import { Injectable } from '@nestjs/common';
import { PrismaService, Tx } from '../prisma/prisma.service';

const ACCOUNTS = {
  cash: 'cash',
  deferred: 'deferred_revenue',
  revenue: 'revenue',
} as const;

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async recordPayment(tx: Tx, orderId: string, amount: number, currency: string): Promise<void> {
    await this.post(tx, [
      { orderId, account: ACCOUNTS.cash, direction: 'debit', amount, currency, reason: 'payment' },
      {
        orderId,
        account: ACCOUNTS.deferred,
        direction: 'credit',
        amount,
        currency,
        reason: 'payment',
      },
    ]);
  }

  async recordDelivery(
    tx: Tx,
    orderId: string,
    lineItemId: string,
    amount: number,
    currency: string,
  ): Promise<void> {
    const reason = `delivery:${lineItemId}`;
    await this.post(tx, [
      { orderId, lineItemId, account: ACCOUNTS.deferred, direction: 'debit', amount, currency, reason },
      { orderId, lineItemId, account: ACCOUNTS.revenue, direction: 'credit', amount, currency, reason },
    ]);
  }

  async recordRefund(
    tx: Tx,
    orderId: string,
    lineItemId: string,
    amount: number,
    currency: string,
  ): Promise<void> {
    const reason = `refund:${lineItemId}`;
    await this.post(tx, [
      { orderId, lineItemId, account: ACCOUNTS.deferred, direction: 'debit', amount, currency, reason },
      { orderId, lineItemId, account: ACCOUNTS.cash, direction: 'credit', amount, currency, reason },
    ]);
  }

  async orderMoney(orderId: string) {
    const rows = await this.prisma.ledgerEntry.findMany({ where: { orderId } });

    let paid = 0;
    let delivered = 0;
    let refunded = 0;

    for (const r of rows) {
      if (r.reason === 'payment' && r.account === ACCOUNTS.cash && r.direction === 'debit') {
        paid += r.amount;
      }
      if (r.reason.startsWith('delivery:') && r.account === ACCOUNTS.revenue && r.direction === 'credit') {
        delivered += r.amount;
      }
      if (r.reason.startsWith('refund:') && r.account === ACCOUNTS.cash && r.direction === 'credit') {
        refunded += r.amount;
      }
    }

    return {
      paid,
      delivered,
      refunded,
      balanced: paid === delivered + refunded,
    };
  }

  async totals() {
    const rows = await this.prisma.$queryRaw<
      Array<{ account: string; direction: string; sum: bigint }>
    >`
      SELECT account, direction, COALESCE(SUM(amount), 0)::bigint AS sum
      FROM ledger_entries
      GROUP BY account, direction
    `;

    const bag: Record<string, number> = {};
    for (const r of rows) {
      const sign = r.direction === 'debit' ? 1 : -1;
      bag[r.account] = (bag[r.account] ?? 0) + sign * Number(r.sum);
    }

    const debit = rows
      .filter((r) => r.direction === 'debit')
      .reduce((s, r) => s + Number(r.sum), 0);
    const credit = rows
      .filter((r) => r.direction === 'credit')
      .reduce((s, r) => s + Number(r.sum), 0);

    return {
      balanced: debit === credit,
      debit,
      credit,
      accounts: {
        cash: bag.cash ?? 0,
        deferred_revenue: bag.deferred_revenue ?? 0,
        revenue: -(bag.revenue ?? 0),
      },
    };
  }

  private async post(
    tx: Tx,
    entries: Array<{
      orderId: string;
      lineItemId?: string;
      account: string;
      direction: string;
      amount: number;
      currency: string;
      reason: string;
    }>,
  ): Promise<void> {
    for (const e of entries) {
      await tx.ledgerEntry.createMany({
        data: {
          orderId: e.orderId,
          lineItemId: e.lineItemId ?? null,
          account: e.account,
          direction: e.direction,
          amount: e.amount,
          currency: e.currency,
          reason: e.reason,
        },
        skipDuplicates: true,
      });
    }
  }
}
