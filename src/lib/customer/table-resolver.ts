import "server-only";

import { createServiceRoleClient } from "@/lib/privileged/service-client";
import { hitRateLimit } from "@/lib/privileged/rate-limit";
import { normalizeTableCode, isOrderableTable } from "@/lib/tables/table-code";

export interface ResolvedTable {
  id: string;
  code: string;
  label: string;
}

export type TableResolution =
  | { status: "ok"; table: ResolvedTable }
  /** Missing, malformed or unknown code. Deliberately one outcome: no hint whether a table exists. */
  | { status: "invalid" }
  /** The table exists but has been switched off by the manager. */
  | { status: "inactive"; label: string }
  | { status: "rate_limited" }
  | { status: "unavailable" };

/**
 * Turns the `?table=` value from a QR code into a table, on the server. The browser's claim is
 * only a CODE to look up; the id used for everything afterwards comes from this lookup, never from
 * the client. Lookups are rate-limited so the endpoint cannot be used to enumerate table codes.
 */
export async function resolveTable(raw: unknown): Promise<TableResolution> {
  const code = normalizeTableCode(Array.isArray(raw) ? raw[0] : raw);
  if (!code) return { status: "invalid" };

  const limited = await hitRateLimit("table-lookup", 60, 60);
  if (limited === "limited") return { status: "rate_limited" };
  if (limited === "unavailable") return { status: "unavailable" };

  try {
    const { data, error } = await createServiceRoleClient()
      .from("cafe_tables")
      .select("id, code, label, is_active")
      .eq("code", code)
      .maybeSingle();
    if (error) return { status: "unavailable" };
    if (!data) return { status: "invalid" };
    if (!isOrderableTable(data)) return { status: "inactive", label: data.label as string };
    return {
      status: "ok",
      table: { id: data.id as string, code: data.code as string, label: data.label as string },
    };
  } catch {
    return { status: "unavailable" };
  }
}

/** The message shown for every non-ok outcome. Helpful, and never reveals internals. */
export function tableProblemCopy(resolution: Exclude<TableResolution, { status: "ok" }>): {
  title: string;
  body: string;
  retry: boolean;
} {
  switch (resolution.status) {
    case "invalid":
      return {
        title: "We couldn't find that table",
        body: "This QR code doesn't match a table at Sandwich Express. Please scan the code on your table again, or ask a member of staff for help.",
        retry: false,
      };
    case "inactive":
      return {
        title: "This table isn't taking orders",
        body: "Orders from this table are switched off right now. Please ask a member of staff and they'll sort you out.",
        retry: false,
      };
    case "rate_limited":
      return {
        title: "Too many tries",
        body: "Please wait a minute and scan your table's QR code again.",
        retry: true,
      };
    default:
      return {
        title: "We couldn't load the menu",
        body: "Something went wrong on our side. Please try again in a moment.",
        retry: true,
      };
  }
}
