import Link from "next/link";

import { ActionButton } from "@/components/admin/action-button";
import { ActionForm, SubmitButton, TextAreaField, TextField } from "@/components/admin/action-form";
import { EmptyState, PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaffPage } from "@/lib/auth/session";
import { LIMITS } from "@/lib/menu/validation";
import { loadCategories, loadItems, type CategoryRow } from "@/lib/menu/repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import {
  deleteCategoryAction,
  moveCategoryAction,
  saveCategoryAction,
  setCategoryActiveAction,
} from "../actions";

export const metadata = { title: "Categories" };

function CategoryEditor({
  category,
  count,
  first,
  last,
}: {
  category: CategoryRow;
  count: number;
  first: boolean;
  last: boolean;
}) {
  return (
    <li className="flex flex-col gap-4 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">{category.name}</h2>
        {!category.is_active ? <Badge variant="outline">Archived</Badge> : null}
        <span className="text-sm text-muted-foreground">
          {count} {count === 1 ? "item" : "items"}
        </span>
      </div>
      <ActionForm action={saveCategoryAction} label={`Edit ${category.name}`}>
        <input type="hidden" name="id" value={category.id} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="name"
            label="Name"
            defaultValue={category.name}
            maxLength={LIMITS.name}
            required
          />
          <TextAreaField
            name="description"
            label="Description (optional)"
            defaultValue={category.description ?? ""}
            maxLength={LIMITS.text}
            className="min-h-11"
            rows={2}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <SubmitButton size="sm" variant="secondary" aria-label={`Save ${category.name}`}>
            Save
          </SubmitButton>
          <ActionButton
            action={moveCategoryAction.bind(null, category.id, "up")}
            disabled={first}
            aria-label={`Move ${category.name} up`}
          >
            Up
          </ActionButton>
          <ActionButton
            action={moveCategoryAction.bind(null, category.id, "down")}
            disabled={last}
            aria-label={`Move ${category.name} down`}
          >
            Down
          </ActionButton>
          <ActionButton
            action={setCategoryActiveAction.bind(null, category.id, !category.is_active)}
            aria-label={`${category.is_active ? "Archive" : "Restore"} category ${category.name}`}
            confirm={
              category.is_active
                ? {
                    title: `Archive "${category.name}"?`,
                    description:
                      "Customers will no longer see this category or the items in it. You can restore it later.",
                    confirmLabel: "Archive",
                  }
                : undefined
            }
          >
            {category.is_active ? "Archive" : "Restore"}
          </ActionButton>
          <ActionButton
            variant="ghost"
            action={deleteCategoryAction.bind(null, category.id)}
            aria-label={`Delete category ${category.name}`}
            confirm={{
              title: `Delete "${category.name}"?`,
              description:
                "Only an empty category can be deleted. Move or delete its items first, or archive the category instead.",
              confirmLabel: "Delete",
              destructive: true,
            }}
          >
            Delete
          </ActionButton>
        </div>
      </ActionForm>
    </li>
  );
}

export default async function CategoriesPage() {
  await requireStaffPage("manager");
  const supabase = await createSupabaseServerClient();
  const [categories, items] = await Promise.all([loadCategories(supabase), loadItems(supabase)]);

  return (
    <>
      <PageHeader
        title="Categories"
        description="Group items the way customers scroll the menu."
        actions={
          <Link
            href="/staff/manager/menu"
            className="text-base font-semibold underline underline-offset-4"
          >
            Back to menu
          </Link>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Add a category</CardTitle>
        </CardHeader>
        <ActionForm action={saveCategoryAction} label="Add category" resetOnSuccess>
          <input type="hidden" name="id" value="" />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="name"
              label="Name"
              placeholder="Sandwiches"
              maxLength={LIMITS.name}
              required
            />
            <TextAreaField
              name="description"
              label="Description (optional)"
              maxLength={LIMITS.text}
              className="min-h-11"
              rows={2}
            />
          </div>
          <div>
            <SubmitButton>Add category</SubmitButton>
          </div>
        </ActionForm>
      </Card>

      {categories.length === 0 ? (
        <EmptyState title="No categories yet">
          <p>Add one above, then you can add menu items to it.</p>
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-xl border bg-card px-5">
          {categories.map((category, index) => (
            <CategoryEditor
              key={category.id}
              category={category}
              count={items.filter((item) => item.category_id === category.id).length}
              first={index === 0}
              last={index === categories.length - 1}
            />
          ))}
        </ul>
      )}
    </>
  );
}
