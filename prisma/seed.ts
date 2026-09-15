import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { CATALOG_PRODUCTS, TEST_KEYS } from './catalog-data';

config();

const prisma = new PrismaClient();
const TYPES = ['topup', 'key', 'subscription', 'giftcard'] as const;

function genKey(sku: string, n: number): string {
  const raw = `${sku}-${n}`.replace(/[^A-Z0-9]/gi, '').toUpperCase().padEnd(12, 'X');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${n.toString(36).toUpperCase().padStart(4, '0')}`;
}

async function extraIndexes() {
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_stock_available
      ON sku_stock (available)
      WHERE available > 0
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_products_active_type_price
      ON products (type, price)
      WHERE is_active = true
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_keys_available
      ON inventory_keys (sku)
      WHERE status = 'available'
  `);
}

type SeedProduct = {
  sku: string;
  name: string;
  type: string;
  price: number;
  currency: string;
  image: string;
  supplier: string;
  isActive: boolean;
};

async function main() {
  const products: SeedProduct[] = CATALOG_PRODUCTS.map((p, i) => ({
    ...p,
    supplier: i % 2 === 0 ? 'A' : 'B',
    isActive: true,
  }));

  for (let i = 1; i <= 5000; i++) {
    const type = TYPES[i % TYPES.length];
    products.push({
      sku: `GEN-${String(i).padStart(5, '0')}`,
      name: `товар ${type} ${i}`,
      type,
      price: 100 + (i % 50) * 10,
      currency: 'RUB',
      image: 'assets/gen.png',
      supplier: i % 2 === 0 ? 'A' : 'B',
      isActive: true,
    });
  }

  const chunk = 500;
  for (let i = 0; i < products.length; i += chunk) {
    await prisma.product.createMany({
      data: products.slice(i, i + chunk),
      skipDuplicates: true,
    });
  }

  for (const p of products) {
    await prisma.product.update({
      where: { sku: p.sku },
      data: { supplier: p.supplier },
    });
  }

  const keys: Array<{ sku: string; code: string; status: string }> = [];
  const featuredSkus = CATALOG_PRODUCTS.map((p) => p.sku);

  for (let i = 0; i < TEST_KEYS.length; i++) {
    keys.push({ sku: featuredSkus[i % featuredSkus.length], code: TEST_KEYS[i], status: 'available' });
  }
  for (const p of CATALOG_PRODUCTS) {
    for (let n = 1; n <= 8; n++) {
      keys.push({ sku: p.sku, code: genKey(p.sku, n), status: 'available' });
    }
  }
  for (let i = 1; i <= 5000; i++) {
    const sku = `GEN-${String(i).padStart(5, '0')}`;
    const count = i % 7 === 0 ? 0 : 1 + (i % 3);
    for (let n = 1; n <= count; n++) {
      keys.push({ sku, code: genKey(sku, n), status: 'available' });
    }
  }

  for (let i = 0; i < keys.length; i += 1000) {
    await prisma.inventoryKey.createMany({
      data: keys.slice(i, i + 1000),
      skipDuplicates: true,
    });
  }

  await extraIndexes();

  await prisma.$executeRawUnsafe(`
    INSERT INTO sku_stock (sku, available, updated_at)
    SELECT p.sku, COALESCE(k.cnt, 0), NOW()
    FROM products p
    LEFT JOIN (
      SELECT sku, COUNT(*)::int AS cnt
      FROM inventory_keys
      WHERE status = 'available'
      GROUP BY sku
    ) k ON k.sku = p.sku
    ON CONFLICT (sku) DO UPDATE
      SET available = EXCLUDED.available, updated_at = NOW()
  `);

  const productCount = await prisma.product.count();
  const keyCount = await prisma.inventoryKey.count({ where: { status: 'available' } });
  console.log(`готово: ${productCount} товаров, ${keyCount} ключей`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
