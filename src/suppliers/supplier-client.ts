import { Injectable } from '@nestjs/common';
import { SuppliersService } from './suppliers.service';
import {
  IssueOk,
  IssueRequest,
  SupplierId,
  SupplierTimeoutError,
} from './types';

@Injectable()
export class SupplierClient {
  private readonly timeoutMs = Number(process.env.SUPPLIER_CLIENT_TIMEOUT_MS ?? 1500);
  private readonly inFlight = new Map<string, Promise<IssueOk>>();

  constructor(private readonly suppliers: SuppliersService) {}

  peekIssue(requestId: string): Promise<IssueOk | null> {
    return this.suppliers.peekIssue(requestId);
  }

  async issue(supplier: SupplierId, body: IssueRequest): Promise<IssueOk> {
    const work = this.joinOrStart(supplier, body);

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SupplierTimeoutError()), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private joinOrStart(supplier: SupplierId, body: IssueRequest): Promise<IssueOk> {
    const existing = this.inFlight.get(body.request_id);
    if (existing) {
      return existing;
    }

    const work = this.suppliers.issue(supplier, body);
    this.inFlight.set(body.request_id, work);
    void work.catch(() => undefined).finally(() => {
      if (this.inFlight.get(body.request_id) === work) {
        this.inFlight.delete(body.request_id);
      }
    });

    return work;
  }
}
