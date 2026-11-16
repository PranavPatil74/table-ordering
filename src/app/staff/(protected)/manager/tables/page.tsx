import Link from "next/link";

import { ActionButton } from "@/components/admin/action-button";
import { ActionForm, SubmitButton, TextField } from "@/components/admin/action-form";
import { EmptyState, PageHeader } from "@/components/admin/page-header";
import { QrNotice } from "@/components/admin/qr-notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaffPage } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getQrContext } from "@/lib/tables/qr-context";
import { loadTables, type TableRow } from "@/lib/tables/repository";
import { suggestNextCode } from "@/lib/tables/table-code";

import { createTableAction, renameTableAction, setTableActiveAction } from "./actions";

export const metadata = { title: "Cafe tables and QR codes" };

function TableEditor({ table }: { table: TableRow }) {
  return (
    <li className="flex flex-col gap-4 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">{table.label}</h2>
        <Badge variant="outline">{table.code}</Badge>
        {table.is_active ? (
          <Badge variant="statusReady">Active</Badge>
        ) : (
          <Badge variant="statusCancelled">Deactivated</Badge>
        )}
      </div>
      <ActionForm action={renameTableAction} label={`Rename table ${table.code}`}>
        <input type="hidden" name="id" value={table.id} />
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <TextField
              name="label"
              label="Name"
              defaultValue={table.label}
              maxLength={40}
              required
            />
          </div>
          <SubmitButton variant="secondary" aria-label={`Save name of table ${table.code}`}>
            Save name
          </SubmitButton>
        </div>
      </ActionForm>
      <div className="flex flex-wrap gap-2">
        {table.is_active ? (
          <Button asChild size="sm" variant="outline">
            <Link
              href={`/staff/manager/tables/${table.id}`}
              aria-label={`QR code for table ${table.code}`}
            >
              QR code
            </Link>
          </Button>
        ) : null}
        <ActionButton
          action={setTableActiveAction.bind(null, table.id, !table.is_active)}
          aria-label={`${table.is_active ? "Deactivate" : "Reactivate"} table ${table.code}`}
          confirm={
            table.is_active
              ? {
                  title: `Deactivate table ${table.code}?`,
                  description:
                    "Its QR code will stop taking orders straight away. Past orders keep their table. You can reactivate it any time.",
                  confirmLabel: "Deactivate",
                  destructive: true,
                }
              : undefined
          }
        >
          {table.is_active ? "Deactivate" : "Reactivate"}
        </ActionButton>
      </div>
    </li>
  );
}

export default async function TablesPage() {
  await requireStaffPage("manager");
  const supabase = await createSupabaseServerClient();
  const tables = await loadTables(supabase);
  const qr = getQrContext();
  const active = tables.filter((table) => table.is_active);

  return (
    <>
      <PageHeader
        title="Cafe tables and QR codes"
        description="One QR code per table. Guests scan it to order from their seat."
        actions={
          active.length > 0 ? (
            <Button asChild variant="outline">
              <Link href="/staff/manager/tables/print">Printable sheet</Link>
            </Button>
          ) : null
        }
      />
      <QrNotice context={qr} />

      <Card>
        <CardHeader>
          <CardTitle>Add a table</CardTitle>
        </CardHeader>
        <ActionForm action={createTableAction} label="Add table" resetOnSuccess key={tables.length}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="code"
              label="Code"
              hint="Printed in the QR link. Capital letters and digits, e.g. T06. It can't be changed later."
              defaultValue={suggestNextCode(tables.map((table) => table.code))}
              maxLength={16}
              autoCapitalize="characters"
              autoComplete="off"
              required
            />
            <TextField
              name="label"
              label="Name"
              hint="What staff and guests see, e.g. Table 6 or Window seat."
              maxLength={40}
              required
            />
          </div>
          <div>
            <SubmitButton>Add table</SubmitButton>
          </div>
        </ActionForm>
      </Card>

      {tables.length === 0 ? (
        <EmptyState title="No tables yet">
          <p>Add your first table above. You can then preview, download and print its QR code.</p>
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-xl border bg-card px-5">
          {tables.map((table) => (
            <TableEditor key={`${table.id}-${table.label}`} table={table} />
          ))}
        </ul>
      )}
    </>
  );
}
