/**
 * Order and payment state machines.
 *
 * These mirror the database (supabase/migrations/..._orders_payments.sql), which is the
 * authority: the database trigger rejects any illegal change no matter what the app does.
 * The TypeScript copy exists so the UI can show only valid next actions. A database test
 * (src/db/orders.db.test.ts) checks every status pair against the real trigger, so the two
 * cannot silently drift apart.
 */

export const ORDER_STATUSES = [
  "NEW",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "SERVED",
  "CANCELLED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** PENDING and FAILED only exist on payment attempts; an order is always PAID or later. */
export const PAYMENT_STATUSES = [
  "PENDING",
  "PAID",
  "FAILED",
  "REFUND_PENDING",
  "REFUNDED",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const ORDER_STATUS_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  NEW: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["SERVED", "CANCELLED"],
  SERVED: [],
  CANCELLED: [],
};

/** REFUNDED is only reachable through REFUND_PENDING (i.e. after a refund was requested). */
export const PAYMENT_STATUS_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> =
  {
    PENDING: [],
    PAID: ["REFUND_PENDING"],
    FAILED: [],
    REFUND_PENDING: ["REFUNDED", "PAID"],
    REFUNDED: [],
  };

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_STATUS_TRANSITIONS[from].includes(to);
}

/** The single forward step in normal preparation, or null when finished or cancelled. */
export function nextPreparationStatus(status: OrderStatus): OrderStatus | null {
  const next = ORDER_STATUS_TRANSITIONS[status].find((candidate) => candidate !== "CANCELLED");
  return next ?? null;
}
