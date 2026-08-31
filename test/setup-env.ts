import 'reflect-metadata';

process.env.DATABASE_URL ??=
  'postgresql://store:store@localhost:5433/store?schema=public';
process.env.SUPPLIER_CLIENT_TIMEOUT_MS ??= '1500';
process.env.SUPPLIER_TIMEOUT_DELAY_MS ??= '4000';
