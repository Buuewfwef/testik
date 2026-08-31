import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';
import { ReconciliationService } from './reconciliation.service';
import { JobsService } from '../jobs/jobs.service';

class ReplenishDto {
  @IsString()
  sku!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  codes!: string[];
}

@Controller('api/admin')
export class ReconciliationController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly jobs: JobsService,
  ) {}

  @Get('reconciliation')
  snapshot() {
    return this.reconciliation.snapshot();
  }

  @Post('reconciliation/run')
  run() {
    return this.reconciliation.recoverStuck();
  }

  @Post('inventory/replenish')
  replenish(@Body() body: ReplenishDto) {
    return this.reconciliation.replenish(body.sku, body.codes);
  }

  @Post('orders/:id/retry')
  async retry(@Param('id') id: string) {
    await this.jobs.enqueueDeliver(id);
    return { enqueued: true, order_id: id };
  }
}
