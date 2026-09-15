import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { DeliveryModule } from './delivery/delivery.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { LedgerModule } from './ledger/ledger.module';
import { JobsModule } from './jobs/jobs.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { OrderEventsModule } from './events/order-events.module';
import { WorkersHost } from './workers.host';

@Module({
  imports: [
    PrismaModule,
    OrderEventsModule,
    CatalogModule,
    OrdersModule,
    PaymentsModule,
    DeliveryModule,
    SuppliersModule,
    LedgerModule,
    JobsModule,
    ReconciliationModule,
  ],
  providers: [WorkersHost],
})
export class AppModule {}
