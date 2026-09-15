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
  private lastEvilCode: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

  setMode(id: SupplierId, mode: SupplierMode): void {
    this.modes[id] = mode;
    if (mode !== 'duplicate_code') {
      this.lastEvilCode = null;
    }
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

    if (mode === 'error_after_issue') {
      throw new SupplierError('unavailable', 503);
    }

    if (mode === 'wrong_code') {
      return { status: 'ok', request_id: body.request_id, code: 'FAKE-CODE-EVIL' };
    }

    if (mode === 'duplicate_code' && this.lastEvilCode) {
      return { status: 'ok', request_id: body.request_id, code: this.lastEvilCode };
    }

    if (mode === 'duplicate_code') {
      this.lastEvilCode = claimed;
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
          lineItemId: body.line_item_id ?? null,
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

  async findDuplicateCodes(): Promise<Array<{ code: string; count: number }>> {
    const rows = await this.prisma.$queryRaw<Array<{ code: string; count: bigint }>>`
      SELECT code, COUNT(*)::bigint AS count
      FROM deliveries
      GROUP BY code
      HAVING COUNT(*) > 1
    `;
    return rows.map((r) => ({ code: r.code, count: Number(r.count) }));
  }

  async unreconciledIssues(): Promise<
    Array<{ request_id: string; order_id: string; code: string; line_item_id: string | null }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{ request_id: string; order_id: string; code: string; line_item_id: string | null }>
    >`
      SELECT si.request_id, si.order_id, si.code, si.line_item_id
      FROM supplier_issues si
      LEFT JOIN deliveries d ON d.request_id = si.request_id
      WHERE d.id IS NULL
    `;
    return rows;
  }
}
