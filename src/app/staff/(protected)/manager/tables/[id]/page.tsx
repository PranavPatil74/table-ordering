import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/admin/page-header";
import { PrintButton } from "@/components/admin/print-button";
import { QrNotice } from "@/components/admin/qr-notice";
import { Button } from "@/components/ui/button";
import { requireStaffPage } from "@/lib/auth/session";
import { idSchema, parse } from "@/lib/menu/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getQrContext } from "@/lib/tables/qr-context";
import { loadTables } from "@/lib/tables/repository";

export const metadata = { title: "Table QR code" };

export default async function TableQrPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaffPage("manager");
  const { id } = await params;
  if (!parse(idSchema, id).ok) notFound();

  const table = (await loadTables(await createSupabaseServerClient())).find((row) => row.id === id);
  if (!table) notFound();

  const qr = getQrContext();
  const link = qr.urlFor(table.code);

  return (
    <>
      <PageHeader
        title={`QR code: ${table.label}`}
        description={`Table code ${table.code}`}
        actions={
          <Link
            href="/staff/manager/tables"
            className="text-base font-semibold underline underline-offset-4"
          >
            Back to tables
          </Link>
        }
      />
      {!table.is_active ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive bg-destructive/5 px-4 py-3 text-base font-semibold text-destructive"
        >
          This table is deactivated. Its QR code doesn&apos;t take orders. Reactivate it on the
          tables page.
        </p>
      ) : (
        <>
          <QrNotice context={qr} />
          <div className="flex flex-col items-start gap-6 sm:flex-row">
            {/* eslint-disable-next-line @next/next/no-img-element -- an inline data: SVG, nothing to optimise */}
            <img
              src={qr.previewSrc(table.code, table.label)}
              alt={`QR code for ${table.label}. It opens ${link}`}
              width={320}
              height={320}
              className="size-80 max-w-full rounded-xl border bg-white p-2"
            />
            <div className="flex flex-col gap-4">
              <p className="text-base">
                The code opens{" "}
                <code className="break-all rounded bg-muted px-1.5 py-0.5">{link}</code>
              </p>
              <p className="text-base text-muted-foreground">
                It carries only the table code. No account details or secrets are stored in it.
              </p>
              {qr.policy.canExport ? (
                <div className="flex flex-wrap gap-3 print:hidden">
                  <Button asChild variant="outline">
                    <a href={`/api/staff/tables/${table.id}/qr?format=svg&download=1`}>
                      Download SVG
                    </a>
                  </Button>
                  <Button asChild variant="outline">
                    <a href={`/api/staff/tables/${table.id}/qr?format=png&download=1`}>
                      Download PNG
                    </a>
                  </Button>
                  <PrintButton>Print this code</PrintButton>
                </div>
              ) : null}
            </div>
          </div>
        </>
      )}
    </>
  );
}
