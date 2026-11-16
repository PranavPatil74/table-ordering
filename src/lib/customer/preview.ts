import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import { hitRateLimit } from "@/lib/privileged/rate-limit";

import { parseStoredCart, type CartLine } from "./cart";
import { loadMenu } from "./menu-loader";
import { priceCart } from "./pricing";
import { PAYMENT_STATE, type PreviewLine, type PreviewResult } from "./preview-types";
import {
  buildOrderSnapshot,
  type OrderSnapshot,
  CUSTOMER_NAME_MAX,
  SPECIAL_INSTRUCTIONS_MAX,
  cleanCustomerName,
  cleanInstructions,
} from "./snapshot";
import { resolveTable, tableProblemCopy, type ResolvedTable } from "./table-resolver";

export const previewInputSchema = z.object({
  tableCode: z.string().max(32),
  /** Client-generated per checkout screen. Used as the idempotency key of the saved checkout (Phase 5). */
  submissionId: z.uuid(),
  customerName: z
    .string()
    .max(CUSTOMER_NAME_MAX * 3)
    .optional(),
  specialInstructions: z
    .string()
    .max(SPECIAL_INSTRUCTIONS_MAX * 3)
    .optional(),
  lines: z
    .array(
      z.object({
        menuItemId: z.uuid(),
        optionIds: z.array(z.uuid()).max(40),
        quantity: z.number().int().min(1).max(99),
      }),
    )
    .max(50),
});

const toLine = (line: ReturnType<typeof priceCart>["lines"][number]): PreviewLine => ({
  key: line.key,
  status: line.status,
  problems: line.problems,
  name: line.item?.name ?? null,
  options: line.chosen.map((c) => c.option.name),
  quantity: line.quantity,
  eachPaise: line.price?.eachPaise ?? null,
  totalPaise: line.price?.totalPaise ?? null,
});

export type PreviewInput = z.infer<typeof previewInputSchema>;

export type Preparation =
  | { ok: true; table: ResolvedTable; snapshot: OrderSnapshot; lines: PreviewLine[] }
  | {
      ok: false;
      result: Extract<
        PreviewResult,
        { status: "needs_attention" | "table_problem" | "busy" | "error" }
      >;
    };

/**
 * The shared server pipeline behind BOTH the side-effect-free preview and the persistent save:
 * rate limit, resolve the table, load the live menu, re-price with the shared code and build the
 * authoritative snapshot. Every figure comes from the database; the request carries only ids,
 * quantities and two free-text fields.
 */
export async function prepareCheckout(
  data: PreviewInput,
  limit: { route: string; max: number; windowSeconds: number },
): Promise<Preparation> {
  const gate = await hitRateLimit(limit.route, limit.max, limit.windowSeconds);
  if (gate === "limited") {
    return {
      ok: false,
      result: {
        status: "busy",
        message: "You're going a little fast. Please wait a moment and try again.",
      },
    };
  }
  if (gate === "unavailable") {
    return {
      ok: false,
      result: {
        status: "error",
        message: "We couldn't check your order just now. Please try again.",
      },
    };
  }

  const table = await resolveTable(data.tableCode);
  if (table.status !== "ok") {
    if (table.status === "rate_limited" || table.status === "unavailable") {
      return {
        ok: false,
        result: {
          status: "error",
          message: "We couldn't check your table just now. Please try again in a moment.",
        },
      };
    }
    const copy = tableProblemCopy(table);
    return {
      ok: false,
      result: { status: "table_problem", title: copy.title, body: copy.body },
    };
  }

  const menu = await loadMenu();
  if (!menu.ok) {
    return {
      ok: false,
      result: { status: "error", message: "We couldn't load the menu. Please try again." },
    };
  }

  // Re-normalise through the same cart code the browser uses (merges duplicates, sorts options).
  const lines: CartLine[] = parseStoredCart(JSON.stringify({ version: 1, lines: data.lines }));
  const pricing = priceCart(menu.catalog, menu.settings, lines);
  const previewLines = pricing.lines.map(toLine);

  if (!pricing.canCheckout) {
    return {
      ok: false,
      result: {
        status: "needs_attention",
        lines: previewLines,
        totalPaise: pricing.totalPaise,
        blockers: pricing.blockers,
      },
    };
  }

  const snapshot = buildOrderSnapshot(table.table, pricing, {
    customerName: cleanCustomerName(data.customerName),
    specialInstructions: cleanInstructions(data.specialInstructions),
  });
  return { ok: true, table: table.table, snapshot, lines: previewLines };
}

/**
 * The server's verdict on a cart. Has NO side effects (nothing is written, no payment is
 * started), so repeating it is always safe.
 */
export async function previewOrder(input: unknown): Promise<PreviewResult> {
  const parsed = previewInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid_input",
      message: "That request wasn't valid. Please go back to your cart and try again.",
    };
  }
  const data = parsed.data;
  const prepared = await prepareCheckout(data, {
    route: "checkout-preview",
    max: 30,
    windowSeconds: 60,
  });
  if (!prepared.ok) return prepared.result;

  const { table, snapshot, lines } = prepared;
  return {
    status: "ready",
    submissionId: data.submissionId,
    table: { code: table.code, label: table.label },
    lines,
    totalPaise: snapshot.total_paise,
    fingerprint: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    payment: PAYMENT_STATE,
  };
}
