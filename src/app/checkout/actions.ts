"use server";

import { loadSavedCheckout, saveCheckout } from "@/lib/customer/checkout";
import type { LoadSavedCheckoutResult, SaveCheckoutResult } from "@/lib/customer/checkout-types";
import { previewOrder } from "@/lib/customer/preview";
import type { PreviewResult } from "@/lib/customer/preview-types";

/**
 * Customer-facing (no login). Re-prices the cart on the server and returns the verdict.
 * It writes nothing and starts no payment.
 */
export async function previewOrderAction(input: unknown): Promise<PreviewResult> {
  return previewOrder(input);
}

/**
 * Customer-facing (no login). Re-prices the cart on the server and SAVES the checkout: one
 * PENDING payment attempt per submission id, safe to repeat. It creates no order and takes no
 * payment. The browser supplies ids, quantities and two text fields; never a price or a total.
 */
export async function saveCheckoutAction(input: unknown): Promise<SaveCheckoutResult> {
  return saveCheckout(input);
}

/** Customer-facing. Re-reads a checkout this browser saved earlier (reload / revisit). */
export async function loadSavedCheckoutAction(input: unknown): Promise<LoadSavedCheckoutResult> {
  return loadSavedCheckout(input);
}
