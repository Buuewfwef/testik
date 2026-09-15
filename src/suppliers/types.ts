export type SupplierId = 'A' | 'B';

export type SupplierMode =
  | 'normal'
  | 'always_timeout'
  | 'always_unavailable'
  | 'always_out_of_stock'
  | 'random'
  | 'duplicate_code'
  | 'wrong_code'
  | 'error_after_issue';

export class SupplierError extends Error {
  constructor(
    public readonly reason: 'unavailable' | 'out_of_stock' | 'duplicate_code' | 'wrong_code',
    public readonly httpStatus: number,
  ) {
    super(reason);
  }
}

export class SupplierTimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'SupplierTimeoutError';
  }
}

export interface IssueRequest {
  request_id: string;
  sku: string;
  order_id: string;
  line_item_id?: string;
}

export interface IssueOk {
  status: 'ok';
  request_id: string;
  code: string;
}
