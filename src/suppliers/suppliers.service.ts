import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { sleep } from '../common/ids';
import {
  IssueOk,
  IssueRequest,
  SupplierError,
  SupplierId,
  SupplierMode,
} from './types';

const DEFAULT_MODES: Record<SupplierId, SupplierMode> = {
  A: (process.env.SUPPLIER_A_MODE as SupplierMode) || 'normal',
  B: (process.env.SUPPLIER_B_MODE as SupplierMode) || 'normal',
};

@Injectable()
export class SuppliersService {
  private modes: Record<SupplierId, SupplierMode> = { ...DEFAULT_MODES };
  private readonly timeoutDelayMs = Number(process.env.SUPPLIER_TIMEOUT_DELAY_MS ?? 4000);

  constructor(private readonly prisma: PrismaService) {}

  setMode(id: SupplierId, mode: SupplierMode): void {
    this.modes[id] = mode;
  }

  getMode(id: SupplierId): SupplierMode {
    return this.modes[id];
  }

  async peekIssue(requestId: string): Promise<IssueOk | null> {
    const row = await this.prisma.supplierIssue.findUnique({
      where: { requestId },
    });
    if (!row) {
      return null;
    }
    return { status: 'ok', request_id: row.requestId, code: row.code };
  }

  async issue(supplier: SupplierId, body: IssueRequest): Promise<IssueOk> {
    const existing = await this.prisma.supplierIssue.findUnique({
      where: { requestId: body.request_id },
    });
    if (existing) {
      return { status: 'ok', request_id: body.request_id, code: existing.code };
    }

    const mode = this.modes[supplier];
    this.maybeFailBeforeIssue(mode);

    const claimed = await this.claimKey(supplier, body);
    if (!claimed) {
      throw new SupplierError('out_of_stock', 409);
    }

    if (mode === 'always_timeout' || (mode === 'random' && Math.random() < 0.25)) {
      await sleep(this.timeoutDelayMs);
    }

    return { status: 'ok', request_id: body.request_id, code: claimed };
  }

  private maybeFailBeforeIssue(mode: SupplierMode): void {
    if (mode === 'always_unavailable') {
      throw new SupplierError('unavailable', 503);
    }
    if (mode === 'always_out_of_stock') {
      throw new SupplierError('out_of_stock', 409);
    }
    if (mode === 'random' && Math.random() < 0.2) {
      throw new SupplierError('unavailable', 503);
    }
  }

  private async claimKey(supplier: SupplierId, body: IssueRequest): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${body.request_id}))`;

      const replay = await tx.supplierIssue.findUnique({
        where: { requestId: body.request_id },
      });
      if (replay) {
        return replay.code;
      }

      const rows = await tx.$queryRaw<Array<{ id: string; code: string }>>`
        UPDATE inventory_keys
        SET status = 'issued',
            order_id = ${body.order_id},
            supplier = ${supplier},
            issued_at = NOW()
        WHERE id = (
          SELECT id FROM inventory_keys
          WHERE sku = ${body.sku} AND status = 'available'
          ORDER BY id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, code
      `;

      if (rows.length === 0) {
        return null;
      }

      await tx.supplierIssue.create({
        data: {
          requestId: body.request_id,
          supplier,
          sku: body.sku,
          orderId: body.order_id,
          code: rows[0].code,
        },
      });

      await tx.skuStock.update({
        where: { sku: body.sku },
        data: { available: { decrement: 1 } },
      });

      return rows[0].code;
    });
  }
}
