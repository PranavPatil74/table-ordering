import "server-only";

import { z } from "zod";

import { getServerEnv } from "@/lib/env/server";
import { deriveTrackingToken, hashTrackingToken } from "@/lib/security/tracking-token";

import { createServiceRoleClient } from "./service-client";

/**
 * The ONLY module that talks to `payment_attempts`, and only through two service-role functions:
 * `create_checkout_attempt` (atomic create-or-return) and `get_checkout_attempt`. It never creates
 * an order, never sets a gateway id, never marks anything PAID, and never calls
 * `finalize_paid_order`. Internal row ids are never selected, so they cannot leak.
 * Callers must have priced the cart and resolved the table on the server first.
 */

const rowSchema = z.object({
  out_status: z.enum(["PENDING", "PAID", "FAILED"]),
  out_amount_paise: z.number().int(),
  out_created_at: z.string(),
  out_expires_at: z.string(),
  out_order_created: z.boolean(),
  out_cart_snapshot: z.object({
    version: z.literal(1),
    table: z.object({ id: z.string(), code: z.string(), label: z.string() }),
    items: z.array(
      z.object({
        item_name: z.string(),
        unit_price_paise: z.number().int(),
        quantity: z.number().int(),
        options: z.array(
          z.object({ option_name: z.string(), price_delta_paise: z.number().int() }),
        ),
      }),
    ),
    total_paise: z.number().int(),
  }),
});

export interface AttemptRecord {
  status: "PENDING" | "PAID" | "FAILED";
  amountPaise: number;
  createdAt: string;
  expiresAt: string;
  orderCreated: boolean;
  snapshot: z.infer<typeof rowSchema>["out_cart_snapshot"];
}

const toRecord = (row: z.infer<typeof rowSchema>): AttemptRecord => ({
  status: row.out_status,
  amountPaise: row.out_amount_paise,
  createdAt: row.out_created_at,
  expiresAt: row.out_expires_at,
  orderCreated: row.out_order_created,
  snapshot: row.out_cart_snapshot,
});

export type CreateAttemptResult =
  | { status: "created" | "existing"; attempt: AttemptRecord }
  | { status: "conflict" }
  | { status: "table_unavailable" }
  | { status: "error" };

const outcomeSchema = z.object({ out_outcome: z.string() }).passthrough();

/** Saves (or returns) the PENDING attempt for `submissionId`. One transaction, in the database. */
export async function createCheckoutAttempt(input: {
  submissionId: string;
  tableId: string;
  amountPaise: number;
  snapshot: unknown;
}): Promise<CreateAttemptResult> {
  try {
    const token = deriveTrackingToken(getServerEnv().supabaseServiceRoleKey, input.submissionId);
    const { data, error } = await createServiceRoleClient().rpc("create_checkout_attempt", {
      p_idempotency_key: input.submissionId,
      p_table_id: input.tableId,
      p_amount_paise: input.amountPaise,
      p_cart_snapshot: input.snapshot,
      p_tracking_token_hash: `\\x${hashTrackingToken(token).toString("hex")}`,
    });
    if (error || !Array.isArray(data) || data.length !== 1) return { status: "error" };
    const outcome = outcomeSchema.parse(data[0]);
    switch (outcome.out_outcome) {
      case "conflict":
        return { status: "conflict" };
      case "table_unavailable":
        return { status: "table_unavailable" };
      case "created":
      case "existing":
        return { status: outcome.out_outcome, attempt: toRecord(rowSchema.parse(data[0])) };
      default:
        return { status: "error" };
    }
  } catch {
    return { status: "error" };
  }
}

export type ReadAttemptResult =
  { status: "found"; attempt: AttemptRecord } | { status: "not_found" } | { status: "error" };

/** Reads one saved checkout by the submission id its own browser holds. */
export async function readCheckoutAttempt(submissionId: string): Promise<ReadAttemptResult> {
  try {
    const { data, error } = await createServiceRoleClient().rpc("get_checkout_attempt", {
      p_idempotency_key: submissionId,
    });
    if (error || !Array.isArray(data)) return { status: "error" };
    if (data.length === 0) return { status: "not_found" };
    return { status: "found", attempt: toRecord(rowSchema.parse(data[0])) };
  } catch {
    return { status: "error" };
  }
}
