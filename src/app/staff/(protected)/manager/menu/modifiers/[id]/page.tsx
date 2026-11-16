import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState, PageHeader } from "@/components/admin/page-header";
import { GroupForm } from "@/components/admin/group-form";
import { NewOptionForm, OptionEditor } from "@/components/admin/option-form";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaffPage } from "@/lib/auth/session";
import { loadAttachments, loadGroups, loadItems, loadOptions } from "@/lib/menu/repository";
import { idSchema, parse } from "@/lib/menu/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata = { title: "Edit modifier group" };

export default async function EditGroupPage({
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
  const [groups, options, attachments, items] = await Promise.all([
    loadGroups(supabase),
    loadOptions(supabase),
    loadAttachments(supabase),
    loadItems(supabase),
  ]);
  const group = groups.find((candidate) => candidate.id === id);
  if (!group) notFound();

  const own = options.filter((option) => option.group_id === id);
  const usedBy = items.filter((item) =>
    attachments.some((a) => a.group_id === id && a.item_id === item.id),
  );

  return (
    <>
      <PageHeader
        title={group.name}
        description={
          usedBy.length === 0
            ? "Not attached to any item yet. Attach it from an item's edit page."
            : `Used by ${usedBy.map((item) => item.name).join(", ")}.`
        }
        actions={
          <Link
            href="/staff/manager/menu/modifiers"
            className="text-base font-semibold underline underline-offset-4"
          >
            Back to groups
          </Link>
        }
      />
      {created ? (
        <p
          role="status"
          className="rounded-lg border border-border bg-secondary px-4 py-3 text-base font-medium"
        >
          Group added. Add its options below.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Group settings</CardTitle>
          <CardDescription>
            The group needs enough active options for its minimum, and at most one pre-selected
            option when only one may be chosen.
          </CardDescription>
        </CardHeader>
        <GroupForm group={group} />
      </Card>

      <section aria-labelledby="options-title" className="flex flex-col gap-4">
        <h2 id="options-title" className="text-2xl font-semibold">
          Options
        </h2>
        <Card>
          <CardHeader>
            <CardTitle>Add an option</CardTitle>
          </CardHeader>
          <NewOptionForm groupId={group.id} />
        </Card>
        {own.length === 0 ? (
          <EmptyState title="No options yet">
            <p>Add the first option above, for example Small, Medium and Large.</p>
          </EmptyState>
        ) : (
          <ul className="divide-y rounded-xl border bg-card px-5">
            {own.map((option, index) => (
              <OptionEditor
                key={option.id}
                option={option}
                first={index === 0}
                last={index === own.length - 1}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
