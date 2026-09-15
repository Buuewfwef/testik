import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupplierId } from './types';

@Injectable()
export class SupplierRateLimiterService {
  private readonly limits: Record<SupplierId, number> = {
    A: Number(process.env.SUPPLIER_A_RPM ?? 30),
    B: Number(process.env.SUPPLIER_B_RPM ?? 30),
  };

  private readonly waiters = new Map<SupplierId, Array<() => void>>();

  constructor(private readonly prisma: PrismaService) {}

  getLimit(supplier: SupplierId): number {
    return this.limits[supplier];
  }

  private windowKey(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}${d.getUTCMonth()}${d.getUTCDate()}${d.getUTCHours()}${d.getUTCMinutes()}`;
  }

  async acquire(supplier: SupplierId): Promise<void> {
    while (true) {
      const allowed = await this.tryConsume(supplier);
      if (allowed) return;
      await new Promise<void>((resolve) => {
        const q = this.waiters.get(supplier) ?? [];
        q.push(resolve);
        this.waiters.set(supplier, q);
      });
    }
  }

  private wake(supplier: SupplierId): void {
    const q = this.waiters.get(supplier);
    if (!q || q.length === 0) return;
    const next = q.shift();
    next?.();
  }

  private async tryConsume(supplier: SupplierId): Promise<boolean> {
    const key = this.windowKey();
    const limit = this.limits[supplier];

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.supplierRateState.findUnique({ where: { supplier } });
      if (!row || row.windowKey !== key) {
        await tx.supplierRateState.upsert({
          where: { supplier },
          create: { supplier, windowKey: key, used: 1 },
          update: { windowKey: key, used: 1 },
        });
        return true;
      }
      if (row.used >= limit) {
        return false;
      }
      await tx.supplierRateState.update({
        where: { supplier },
        data: { used: { increment: 1 } },
      });
      return true;
    }).then((ok) => {
      if (ok) this.wake(supplier);
      return ok;
    });
  }

  async stats() {
    const key = this.windowKey();
    const rows = await this.prisma.supplierRateState.findMany();
    const bag: Record<string, { used: number; limit: number; window: string }> = {};
    for (const s of ['A', 'B'] as SupplierId[]) {
      const row = rows.find((r) => r.supplier === s);
      bag[s] = {
        used: row?.windowKey === key ? row.used : 0,
        limit: this.limits[s],
        window: key,
      };
    }
    return bag;
  }
}
