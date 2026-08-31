import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async storefront(params: { limit: number; offset: number; type?: string }) {
    const limit = Math.min(Math.max(params.limit, 1), 100);
    const offset = Math.max(params.offset, 0);
    const typeFilter = params.type
      ? Prisma.sql`AND p.type = ${params.type}`
      : Prisma.empty;

    const items = await this.prisma.$queryRaw<
      Array<{
        sku: string;
        name: string;
        type: string;
        price: number;
        currency: string;
        image: string;
        available: number;
      }>
    >`
      SELECT p.sku, p.name, p.type, p.price, p.currency, p.image, s.available
      FROM products p
      INNER JOIN sku_stock s ON s.sku = p.sku
      WHERE p.is_active = true
        AND s.available > 0
        ${typeFilter}
      ORDER BY p.type ASC, p.price ASC, p.sku ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const totalRows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM products p
      INNER JOIN sku_stock s ON s.sku = p.sku
      WHERE p.is_active = true
        AND s.available > 0
        ${typeFilter}
    `;

    return {
      items,
      limit,
      offset,
      total: Number(totalRows[0]?.count ?? 0),
    };
  }

  async getBySku(sku: string) {
    return this.prisma.product.findUnique({
      where: { sku },
      include: { stock: true },
    });
  }

  async explainStorefront() {
    const plan = await this.prisma.$queryRawUnsafe<unknown[]>(
      `EXPLAIN (FORMAT JSON)
       SELECT p.sku, p.name, p.type, p.price, p.currency, p.image, s.available
       FROM products p
       INNER JOIN sku_stock s ON s.sku = p.sku
       WHERE p.is_active = true
         AND s.available > 0
       ORDER BY p.type ASC, p.price ASC, p.sku ASC
       LIMIT 50`,
    );
    return plan[0];
  }
}
