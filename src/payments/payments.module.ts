import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { LedgerModule } from '../ledger/ledger.module';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [LedgerModule, JobsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
