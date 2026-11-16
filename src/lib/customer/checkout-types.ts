import type { PaymentState, PreviewLine, PreviewResult } from "./preview-types";

/**
 * Types and pure helpers shared by the checkout screen (browser) and the server. No server code.
 *
 * The four things a customer must never confuse, as distinct stages:
 *   saved            the checkout details are stored. NOT a payment and NOT an order.
 *   payment_verified the gateway confirmed the money (only after Phase 6 verification).
 *   order_created    the cafe has the order (only finalize_paid_order creates one).
 *   closed           the saved checkout expired or failed; nothing was charged for it.
 * Phase 5 can only ever produce `saved` (payment is not configured), but the others are modelled
 * so the screen can never be tempted to reuse "saved" wording for them.
 */
export type CheckoutStage = "saved" | "payment_verified" | "order_created" | "closed";

export interface SavedCheckout {
  /** Short human reference the customer can quote to staff. Derived from the submission id. */
  reference: string;
  stage: CheckoutStage;
  /** Always "not_configured" until the gateway phase exists. */
  payment: PaymentState;
  table: { code: string; label: string };
  lines: PreviewLine[];
  totalPaise: number;
  createdAt: string;
  expiresAt: string;
}

export type SaveCheckoutResult =
  | ({ status: "saved"; replay: boolean } & SavedCheckout)
  /** The same submission id was already used for a different cart (or the menu changed since). */
  | { status: "conflict"; message: string }
  | Exclude<PreviewResult, { status: "ready" }>;

export type LoadSavedCheckoutResult =
  | ({ status: "saved"; replay: true } & SavedCheckout)
  | { status: "not_found" }
  | Extract<PreviewResult, { status: "table_problem" | "invalid_input" | "busy" | "error" }>;

/** "CK-1A2B3C4D": the first 8 hex digits of the submission id. For quoting to staff, not for lookup. */
export function checkoutReference(submissionId: string): string {
  return `CK-${submissionId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/** The subset of a stored `cart_snapshot` v1 the summary needs. Validated by the caller. */
export interface SnapshotLike {
  table: { code: string; label: string };
  items: {
    item_name: string;
    unit_price_paise: number;
    quantity: number;
    options: { option_name: string; price_delta_paise: number }[];
  }[];
  total_paise: number;
}

/** Item summary for the confirmation panel, from the SAVED snapshot (never from the browser). */
export function summariseSnapshot(snapshot: SnapshotLike): PreviewLine[] {
  return snapshot.items.map((item, index) => {
    const each =
      item.unit_price_paise +
      item.options.reduce((sum, option) => sum + option.price_delta_paise, 0);
    return {
      key: String(index),
      status: "ok" as const,
      problems: [],
      name: item.item_name,
      options: item.options.map((option) => option.option_name),
      quantity: item.quantity,
      eachPaise: each,
      totalPaise: each * item.quantity,
    };
  });
}

export function checkoutStage(attempt: {
  status: "PENDING" | "PAID" | "FAILED";
  orderCreated: boolean;
  expiresAt: string;
  now?: number;
}): CheckoutStage {
  if (attempt.orderCreated) return "order_created";
  if (attempt.status === "PAID") return "payment_verified";
  if (attempt.status === "FAILED") return "closed";
  return Date.parse(attempt.expiresAt) <= (attempt.now ?? Date.now()) ? "closed" : "saved";
}
