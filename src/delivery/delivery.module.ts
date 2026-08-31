import { Module } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import { LedgerModule } from '../ledger/ledger.module';
import { SuppliersModule } from '../suppliers/suppliers.module';

@Module({
  imports: [LedgerModule, SuppliersModule],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
