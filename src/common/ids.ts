import { nanoid } from 'nanoid';

export function newOrderId(): string {
  return `ord_${nanoid(12)}`; //) 
}

export function supplierRequestId(orderId: string, supplier: 'A' | 'B'): string {
  return `${orderId}:${supplier}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
