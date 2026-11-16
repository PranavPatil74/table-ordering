import Link from "next/link";

import { PageHeader } from "@/components/admin/page-header";
import { PrintButton } from "@/components/admin/print-button";
import { QrNotice } from "@/components/admin/qr-notice";
import { requireStaffPage } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getQrContext } from "@/lib/tables/qr-context";
import { loadTables } from "@/lib/tables/repository";

export const metadata = { title: "Printable QR sheet" };

/** One card per ACTIVE table, laid out for A4 paper. Refused in production while the URL is local. */
export default async function PrintSheetPage() {
  await requireStaffPage("manager");
  const tables = (await loadTables(await createSupabaseServerClient())).filter(
    (table) => table.is_active,
  );
  const qr = getQrContext();

  return (
    <>
      <PageHeader
        title="Printable QR sheet"
        description="Print, cut along the cards and place one on each table."
        actions={
          <>
            <Link
              href="/staff/manager/tables"
              className="text-base font-semibold underline underline-offset-4"
            >
              Back to tables
            </Link>
            {qr.policy.canExport && tables.length > 0 ? (
              <PrintButton>Print sheet</PrintButton>
            ) : null}
          </>
        }
      />
      <QrNotice context={qr} />
      {!qr.policy.canExport ? null : tables.length === 0 ? (
        <p className="text-base text-muted-foreground">There are no active tables to print.</p>
      ) : (
        <ul
          aria-label="QR codes to print"
          className="grid grid-cols-2 gap-4 print:gap-3 lg:grid-cols-3"
        >
          {tables.map((table) => (
            <li
              key={table.id}
              className="flex break-inside-avoid flex-col items-center gap-2 rounded-xl border bg-white p-4 text-center text-black"
            >
              {qr.policy.testOnly ? (
                <p className="text-sm font-bold text-red-700">TEST ONLY</p>
              ) : null}
              <h2 className="font-display text-2xl font-semibold">{table.label}</h2>
              {/* eslint-disable-next-line @next/next/no-img-element -- an inline data: SVG */}
              <img
                src={qr.previewSrc(table.code, table.label)}
                alt={`QR code for ${table.label}`}
                className="w-full max-w-56"
              />
              <p className="text-base font-medium">Scan to order</p>
              <p className="text-xs text-neutral-600">{table.code}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
