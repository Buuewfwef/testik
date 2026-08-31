import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DeliveryService } from './delivery/delivery.service';
import { JobsService } from './jobs/jobs.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';

@Injectable()
export class WorkersHost implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly jobs: JobsService,
    private readonly delivery: DeliveryService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  onModuleInit(): void {
    this.jobs.setDeliverHandler((orderId) => this.delivery.deliver(orderId));
    this.jobs.start();
    this.reconciliation.start();
  }

  onModuleDestroy(): void {
    this.jobs.stop();
    this.reconciliation.stop();
  }
}
