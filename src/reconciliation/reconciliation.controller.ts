import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsISO8601, IsOptional, IsString } from 'class-validator';
import { ReconciliationService } from './reconciliation.service';
import { JobsService } from '../jobs/jobs.service';
import { LedgerService } from '../ledger/ledger.service';
import { OrderEventsService } from '../events/order-events.service';
import { SupplierRateLimiterService } from '../suppliers/supplier-rate-limiter.service';

class ReplenishDto {
  @IsString()
  sku!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  codes!: string[];
}

class AtQuery {
  @IsISO8601()
  ts!: string;
}

class PeriodQuery {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;
}

@Controller('api/admin')
export class ReconciliationController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly jobs: JobsService,
    private readonly ledger: LedgerService,
    private readonly events: OrderEventsService,
    private readonly rateLimiter: SupplierRateLimiterService,
  ) {}

  @Get('reconciliation')
  snapshot() {
    return this.reconciliation.snapshot();
  }

  @Post('reconciliation/run')
  run() {
    return this.reconciliation.recoverStuck();
  }

  @Get('queue')
  async queue() {
    const jobs = await this.jobs.queueStats();
    const suppliers = await this.rateLimiter.stats();
    return { jobs, suppliers };
  }

  @Get('orders/:id/money')
  money(@Param('id') id: string) {
    return this.ledger.orderMoney(id);
  }

  @Get('orders/:id/at')
  at(@Param('id') id: string, @Query() q: AtQuery) {
    return this.events.replayAt(id, new Date(q.ts));
  }

  @Get('ledger/period')
  period(@Query() q: PeriodQuery) {
    return this.events.periodTotals(new Date(q.from), new Date(q.to));
  }

  @Post('inventory/replenish')
  replenish(@Body() body: ReplenishDto) {
    return this.reconciliation.replenish(body.sku, body.codes);
  }

  @Post('orders/:id/retry')
  async retry(@Param('id') id: string) {
    await this.jobs.enqueueDeliver(id, 10);
    return { enqueued: true, order_id: id };
  }
}
