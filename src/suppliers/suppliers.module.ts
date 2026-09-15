import { Module } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import { SupplierClient } from './supplier-client';
import { SupplierRateLimiterService } from './supplier-rate-limiter.service';
import { SuppliersService } from './suppliers.service';

@Module({
  controllers: [SuppliersController],
  providers: [SuppliersService, SupplierClient, SupplierRateLimiterService],
  exports: [SuppliersService, SupplierClient, SupplierRateLimiterService],
})
export class SuppliersModule {}
