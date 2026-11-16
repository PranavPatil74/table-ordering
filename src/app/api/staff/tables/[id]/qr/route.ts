import { NextResponse, type NextRequest } from "next/server";

import { requireStaffApi } from "@/lib/auth/session";
import { getQrBaseUrl } from "@/lib/env/app-url";
import { idSchema, parse } from "@/lib/menu/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { renderQrPng } from "@/lib/tables/png";
import {
  buildTableQrUrl,
  classifyBaseUrl,
  qrExportPolicy,
  qrFilename,
  renderQrSvg,
} from "@/lib/tables/qr";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const json = (body: Record<string, string>, status: number) =>
  NextResponse.json(body, { status, headers: NO_STORE });

/**
 * Download one table's QR code as SVG or PNG. Managers only (401 signed out, 403 counter).
 * Refused for a deactivated table, and refused when the public URL is local in a production build.
 * The code only ever encodes `<public origin>/menu?table=<CODE>`.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const guard = await requireStaffApi("manager");
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  if (!parse(idSchema, id).ok) return json({ error: "not_found" }, 404);
  const format = request.nextUrl.searchParams.get("format") ?? "svg";
  if (format !== "svg" && format !== "png") return json({ error: "unsupported_format" }, 400);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("cafe_tables")
    .select("code, label, is_active")
    .eq("id", id)
    .maybeSingle();
  if (error) return json({ error: "unavailable" }, 503);
  if (!data) return json({ error: "not_found" }, 404);
  if (!data.is_active) return json({ error: "table_inactive" }, 409);

  const info = classifyBaseUrl(getQrBaseUrl().origin);
  const policy = qrExportPolicy(info, process.env.NODE_ENV);
  if (!policy.canExport) return json({ error: "base_url_not_public" }, 403);

  const url = buildTableQrUrl(info.origin, data.code);
  const filename = qrFilename(data.code, format, policy.testOnly);
  const disposition =
    request.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  const headers = {
    ...NO_STORE,
    "Content-Disposition": `${disposition}; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
  };

  if (format === "png") {
    return new NextResponse(new Uint8Array(renderQrPng(url, { testOnly: policy.testOnly })), {
      headers: { ...headers, "Content-Type": "image/png" },
    });
  }
  return new NextResponse(renderQrSvg(url, `Table ${data.label}`, { testOnly: policy.testOnly }), {
    headers: { ...headers, "Content-Type": "image/svg+xml; charset=utf-8" },
  });
}
