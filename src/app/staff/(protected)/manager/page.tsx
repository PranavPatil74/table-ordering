import Link from "next/link";

import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaffPage } from "@/lib/auth/session";
import { loadCategories, loadGroups, loadItems } from "@/lib/menu/repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadTables } from "@/lib/tables/repository";

export const metadata = { title: "Manager overview" };

/** Manager landing page: what exists and what needs attention. */
export default async function ManagerOverview() {
  await requireStaffPage("manager");
  const supabase = await createSupabaseServerClient();
  const [items, categories, groups, tables] = await Promise.all([
    loadItems(supabase),
    loadCategories(supabase),
    loadGroups(supabase),
    loadTables(supabase),
  ]);

  const live = items.filter((item) => item.is_active);
  const soldOut = live.filter((item) => !item.is_available);
  const activeTables = tables.filter((table) => table.is_active);

  const stats = [
    { label: "Menu items on the menu", value: live.length },
    { label: "Sold out right now", value: soldOut.length },
    { label: "Categories", value: categories.filter((c) => c.is_active).length },
    { label: "Modifier groups", value: groups.filter((g) => g.is_active).length },
    { label: "Active tables", value: activeTables.length },
  ];

  return (
    <>
      <PageHeader
        eyebrow={<Badge variant="gold">Manager</Badge>}
        title="Manager overview"
        description="Set up what customers can order and the tables they scan from."
      />

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col gap-1 rounded-xl border bg-card p-4">
            <dd className="font-display text-3xl font-semibold">{stat.value}</dd>
            <dt className="text-sm text-muted-foreground">{stat.label}</dt>
          </div>
        ))}
      </dl>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <Link href="/staff/manager/menu" className="underline-offset-4 hover:underline">
                Menu management
              </Link>
            </CardTitle>
            <CardDescription>
              Categories, items, prices and modifier groups such as sizes and add-ons.
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <Link href="/staff/manager/tables" className="underline-offset-4 hover:underline">
                Cafe tables and QR codes
              </Link>
            </CardTitle>
            <CardDescription>
              Add tables, then print a QR code for each so guests can order from their seat.
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <Link href="/staff/manager/staff" className="underline-offset-4 hover:underline">
                Staff
              </Link>
            </CardTitle>
            <CardDescription>
              See who can sign in, and deactivate or reactivate accounts.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    </>
  );
}
