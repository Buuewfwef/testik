import { Module } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';
import { SupplierClient } from './supplier-client';

@Module({
  controllers: [SuppliersController],
  providers: [SuppliersService, SupplierClient],
  exports: [SuppliersService, SupplierClient],
})
export class SuppliersModule {}
