import "server-only";

import { z } from "zod";

import { hitRateLimit } from "@/lib/privileged/rate-limit";
import {
  createCheckoutAttempt,
  readCheckoutAttempt,
  type AttemptRecord,
} from "@/lib/privileged/checkout-attempts";

import {
  checkoutReference,
  checkoutStage,
  summariseSnapshot,
  type LoadSavedCheckoutResult,
  type SaveCheckoutResult,
  type SavedCheckout,
} from "./checkout-types";
import { PAYMENT_STATE } from "./preview-types";
import { prepareCheckout, previewInputSchema } from "./preview";
import { resolveTable, tableProblemCopy } from "./table-resolver";

/** Saving is a write, so the submission id must be a random v4 UUID (what `crypto.randomUUID()` makes). */
export const saveInputSchema = previewInputSchema.extend({ submissionId: z.uuidv4() });
const loadInputSchema = z.object({ tableCode: z.string().max(32), submissionId: z.uuidv4() });

const INVALID = {
  status: "invalid_input" as const,
  message: "That request wasn't valid. Please go back to your cart and try again.",
};

function toSaved(submissionId: string, attempt: AttemptRecord): SavedCheckout {
  return {
    reference: checkoutReference(submissionId),
    stage: checkoutStage(attempt),
    payment: PAYMENT_STATE,
    table: { code: attempt.snapshot.table.code, label: attempt.snapshot.table.label },
    lines: summariseSnapshot(attempt.snapshot),
    totalPaise: attempt.amountPaise,
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
  };
}

/**
 * Persists the checkout: the same server pipeline as the preview, then ONE atomic database call
 * that creates the PENDING payment attempt or returns the one this submission already has.
 * It never creates an order, takes no payment and cannot mark anything paid.
 */
export async function saveCheckout(input: unknown): Promise<SaveCheckoutResult> {
  const parsed = saveInputSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const data = parsed.data;

  const prepared = await prepareCheckout(data, {
    route: "checkout-save",
    max: 30,
    windowSeconds: 60,
  });
  if (!prepared.ok) return prepared.result;

  const saved = await createCheckoutAttempt({
    submissionId: data.submissionId,
    tableId: prepared.table.id,
    amountPaise: prepared.snapshot.total_paise,
    snapshot: prepared.snapshot,
  });

  switch (saved.status) {
    case "created":
    case "existing":
      return {
        status: "saved",
        replay: saved.status === "existing",
        ...toSaved(data.submissionId, saved.attempt),
      };
    case "conflict":
      return {
        status: "conflict",
        message:
          "This checkout was already saved with a different order, or the menu changed since. Review your order again to save the latest version.",
      };
    case "table_unavailable":
      return {
        status: "table_problem",
        title: "This table isn't taking orders",
        body: "Orders from this table are switched off right now. Please ask a member of staff and they'll sort you out.",
      };
    default:
      return {
        status: "error",
        message: "We couldn't save your checkout. You haven't been charged. Please try again.",
      };
  }
}

/**
 * Looks a saved checkout up again (reload, or coming back to the screen). The submission id is a
 * random UUID that only this customer's browser holds; the table must also match, so an id can
 * never be used to see a checkout from another table. Nothing about the customer's name or notes
 * is returned.
 */
export async function loadSavedCheckout(input: unknown): Promise<LoadSavedCheckoutResult> {
  const parsed = loadInputSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const { tableCode, submissionId } = parsed.data;

  const gate = await hitRateLimit("checkout-lookup", 30, 60);
  if (gate === "limited") {
    return { status: "busy", message: "Please wait a moment and try again." };
  }
  if (gate === "unavailable") {
    return { status: "error", message: "We couldn't check your saved checkout just now." };
  }

  const table = await resolveTable(tableCode);
  if (table.status !== "ok") {
    if (table.status === "rate_limited" || table.status === "unavailable") {
      return { status: "error", message: "We couldn't check your table just now." };
    }
    const copy = tableProblemCopy(table);
    return { status: "table_problem", title: copy.title, body: copy.body };
  }

  const found = await readCheckoutAttempt(submissionId);
  if (found.status === "error") {
    return { status: "error", message: "We couldn't check your saved checkout just now." };
  }
  // Unknown id and another table's id look identical: no hint that a checkout exists elsewhere.
  if (found.status === "not_found" || found.attempt.snapshot.table.id !== table.table.id) {
    return { status: "not_found" };
  }
  return { status: "saved", replay: true, ...toSaved(submissionId, found.attempt) };
}
