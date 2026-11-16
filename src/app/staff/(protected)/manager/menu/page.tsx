import Link from "next/link";

import { ActionButton } from "@/components/admin/action-button";
import { EmptyState, PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireStaffPage } from "@/lib/auth/session";
import { formatPaise } from "@/lib/money";
import { loadCategories, loadItems, type ItemRow } from "@/lib/menu/repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { deleteItemAction, moveItemAction, setItemFlagAction } from "./actions";

export const metadata = { title: "Menu management" };

function ItemRowView({ item, first, last }: { item: ItemRow; first: boolean; last: boolean }) {
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/staff/manager/menu/items/${item.id}`}
            className="text-lg font-semibold underline-offset-4 hover:underline"
          >
            {item.name}
          </Link>
          {!item.is_active ? <Badge variant="outline">Archived</Badge> : null}
          {item.is_active && !item.is_available ? (
            <Badge variant="statusCancelled">Sold out</Badge>
          ) : null}
        </div>
        <p className="text-base text-muted-foreground">{formatPaise(item.price_paise)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          action={moveItemAction.bind(null, item.id, "up")}
          disabled={first}
          aria-label={`Move ${item.name} up`}
        >
          Up
        </ActionButton>
        <ActionButton
          action={moveItemAction.bind(null, item.id, "down")}
          disabled={last}
          aria-label={`Move ${item.name} down`}
        >
          Down
        </ActionButton>
        <ActionButton
          action={setItemFlagAction.bind(null, item.id, "is_available", !item.is_available)}
          aria-label={`${item.is_available ? "Mark sold out" : "Mark available"}: ${item.name}`}
        >
          {item.is_available ? "Mark sold out" : "Mark available"}
        </ActionButton>
        <Button asChild size="sm" variant="outline">
          <Link href={`/staff/manager/menu/items/${item.id}`} aria-label={`Edit ${item.name}`}>
            Edit
          </Link>
        </Button>
        <ActionButton
          action={setItemFlagAction.bind(null, item.id, "is_active", !item.is_active)}
          aria-label={`${item.is_active ? "Archive" : "Restore"} ${item.name}`}
          confirm={
            item.is_active
              ? {
                  title: `Archive "${item.name}"?`,
                  description:
                    "Customers will no longer see it. You can restore it later, and past orders keep it.",
                  confirmLabel: "Archive",
                }
              : undefined
          }
        >
          {item.is_active ? "Archive" : "Restore"}
        </ActionButton>
        <ActionButton
          variant="ghost"
          action={deleteItemAction.bind(null, item.id)}
          aria-label={`Delete ${item.name}`}
          confirm={{
            title: `Delete "${item.name}"?`,
            description:
              "This permanently removes the item. An item that has ever been ordered can't be deleted: archive it instead.",
            confirmLabel: "Delete",
            destructive: true,
          }}
        >
          Delete
        </ActionButton>
      </div>
    </li>
  );
}

export default async function MenuManagementPage() {
  await requireStaffPage("manager");
  const supabase = await createSupabaseServerClient();
  const [categories, items] = await Promise.all([loadCategories(supabase), loadItems(supabase)]);

  return (
    <>
      <PageHeader
        title="Menu management"
        description="Everything customers can order. Prices are in rupees."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/staff/manager/menu/categories">Categories</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/staff/manager/menu/modifiers">Modifier groups</Link>
            </Button>
            {categories.length > 0 ? (
              <Button asChild>
                <Link href="/staff/manager/menu/items/new">Add item</Link>
              </Button>
            ) : null}
          </>
        }
      />

      {categories.length === 0 ? (
        <EmptyState title="Start with a category">
          <p>Items live inside categories such as Sandwiches or Drinks. Add your first category.</p>
          <Button asChild>
            <Link href="/staff/manager/menu/categories">Add a category</Link>
          </Button>
        </EmptyState>
      ) : (
        categories.map((category) => {
          const inCategory = items.filter((item) => item.category_id === category.id);
          return (
            <section
              key={category.id}
              aria-labelledby={`cat-${category.id}`}
              className="flex flex-col gap-2"
            >
              <div className="flex flex-wrap items-center gap-3">
                <h2 id={`cat-${category.id}`} className="text-2xl font-semibold">
                  {category.name}
                </h2>
                {!category.is_active ? <Badge variant="outline">Archived</Badge> : null}
              </div>
              {inCategory.length === 0 ? (
                <p className="rounded-xl border border-dashed bg-card px-4 py-5 text-base text-muted-foreground">
                  No items in this category yet.
                </p>
              ) : (
                <ul className="divide-y rounded-xl border bg-card px-4">
                  {inCategory.map((item, index) => (
                    <ItemRowView
                      key={item.id}
                      item={item}
                      first={index === 0}
                      last={index === inCategory.length - 1}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </>
  );
}
