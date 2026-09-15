import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JobsService {
  private running = 0;
  private readonly concurrency = 8;
  private timer: NodeJS.Timeout | null = null;
  private deliverFn: ((orderId: string) => Promise<void>) | null = null;

  constructor(private readonly prisma: PrismaService) {}

  setDeliverHandler(fn: (orderId: string) => Promise<void>): void {
    this.deliverFn = fn;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pump(), 300);
    void this.pump();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async enqueueDeliver(orderId: string, priority = 10): Promise<void> {
    await this.prisma.job.create({
      data: { type: 'deliver', orderId, status: 'pending', priority },
    });
    void this.pump();
  }

  async queueStats() {
    const [pending, processing, done] = await Promise.all([
      this.prisma.job.count({ where: { type: 'deliver', status: 'pending' } }),
      this.prisma.job.count({ where: { type: 'deliver', status: 'processing' } }),
      this.prisma.job.count({ where: { type: 'deliver', status: 'done' } }),
    ]);

    const deliveredOrders = await this.prisma.order.count({
      where: { status: { in: ['delivered', 'partially_fulfilled'] } },
    });

    return {
      pending_jobs: pending,
      processing_jobs: processing,
      done_jobs: done,
      delivered_orders: deliveredOrders,
      worker_concurrency: this.concurrency,
      running_workers: this.running,
    };
  }

  private async pump(): Promise<void> {
    while (this.running < this.concurrency) {
      const job = await this.claim();
      if (!job) return;
      this.running += 1;
      void this.run(job).finally(() => {
        this.running -= 1;
        void this.pump();
      });
    }
  }

  private async claim() {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; type: string; order_id: string | null; attempts: number }>
    >`
      UPDATE jobs
      SET status = 'processing', attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending' AND run_at <= NOW()
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, order_id, attempts
    `;
    return rows[0] ?? null;
  }

  private async run(job: {
    id: string;
    type: string;
    order_id: string | null;
    attempts: number;
  }): Promise<void> {
    try {
      if (job.type === 'deliver' && job.order_id && this.deliverFn) {
        const order = await this.prisma.order.findUnique({ where: { id: job.order_id } });
        if (order?.status === 'created' || order?.status === 'payment_failed') {
          await this.prisma.job.update({
            where: { id: job.id },
            data: { status: 'done', lastError: 'skipped_unpaid' },
          });
          return;
        }
        await this.deliverFn(job.order_id);
      }
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: 'done', lastError: null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.job.updateMany({
        where: { id: job.id },
        data: {
          status: 'pending',
          lastError: message,
          runAt: new Date(Date.now() + 1000 * Math.min(job.attempts, 8)),
        },
      });
    }
  }
}
