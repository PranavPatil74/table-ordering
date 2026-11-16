import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionForm, CheckField, SubmitButton } from "@/components/admin/action-form";
import { ItemForm } from "@/components/admin/item-form";
import { PageHeader } from "@/components/admin/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaffPage } from "@/lib/auth/session";
import { formatPaise } from "@/lib/money";
import {
  loadAttachments,
  loadCategories,
  loadGroups,
  loadItems,
  loadOptions,
} from "@/lib/menu/repository";
import { idSchema, parse } from "@/lib/menu/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { saveItemGroupsAction } from "../../actions";

export const metadata = { title: "Edit menu item" };

export default async function EditItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  await requireStaffPage("manager");
  const { id } = await params;
  const { created } = await searchParams;
  if (!parse(idSchema, id).ok) notFound();

  const supabase = await createSupabaseServerClient();
  const [items, categories, groups, options, attachments] = await Promise.all([
    loadItems(supabase),
    loadCategories(supabase),
    loadGroups(supabase),
    loadOptions(supabase),
    loadAttachments(supabase),
  ]);
  const item = items.find((candidate) => candidate.id === id);
  if (!item) notFound();

  const attached = new Set(attachments.filter((a) => a.item_id === id).map((a) => a.group_id));

  return (
    <>
      <PageHeader
        title={item.name}
        description={`${formatPaise(item.price_paise)}${item.is_active ? "" : " · archived"}`}
        actions={
          <Link
            href="/staff/manager/menu"
            className="text-base font-semibold underline underline-offset-4"
          >
            Back to menu
          </Link>
        }
      />
      {created ? (
        <p
          role="status"
          className="rounded-lg border border-border bg-secondary px-4 py-3 text-base font-medium"
        >
          Item added. You can now attach choices such as sizes or add-ons below.
        </p>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[3fr_2fr]">
        <ItemForm item={item} categories={categories} />

        <Card className="self-start">
          <CardHeader>
            <CardTitle>Choices for this item</CardTitle>
            <CardDescription>
              Attach modifier groups, such as Size or Extras. Customers pick from them when they add
              the item.
            </CardDescription>
          </CardHeader>
          {groups.length === 0 ? (
            <p className="text-base text-muted-foreground">
              There are no modifier groups yet.{" "}
              <Link
                href="/staff/manager/menu/modifiers"
                className="font-semibold underline underline-offset-4"
              >
                Create one
              </Link>
              .
            </p>
          ) : (
            <ActionForm action={saveItemGroupsAction} label="Choices for this item">
              <input type="hidden" name="itemId" value={item.id} />
              <fieldset className="flex flex-col gap-3">
                <legend className="sr-only">Modifier groups</legend>
                {groups.map((group) => {
                  const optionCount = options.filter(
                    (o) => o.group_id === group.id && o.is_active,
                  ).length;
                  return (
                    <CheckField
                      key={group.id}
                      name="groupIds"
                      value={group.id}
                      label={`${group.name}${group.is_active ? "" : " (archived)"}`}
                      hint={`${optionCount} ${optionCount === 1 ? "option" : "options"} · ${
                        group.min_select > 0 ? "required" : "optional"
                      }, up to ${group.max_select}`}
                      defaultChecked={attached.has(group.id)}
                    />
                  );
                })}
              </fieldset>
              <div>
                <SubmitButton variant="secondary">Save choices</SubmitButton>
              </div>
            </ActionForm>
          )}
        </Card>
      </div>
    </>
  );
}
