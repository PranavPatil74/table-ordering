import Link from "next/link";

import { ActionButton } from "@/components/admin/action-button";
import { EmptyState, PageHeader } from "@/components/admin/page-header";
import { GroupForm } from "@/components/admin/group-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaffPage } from "@/lib/auth/session";
import { loadGroups, loadOptions } from "@/lib/menu/repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { deleteGroupAction, moveGroupAction, setGroupActiveAction } from "../actions";

export const metadata = { title: "Modifier groups" };

export default async function ModifiersPage() {
  await requireStaffPage("manager");
  const supabase = await createSupabaseServerClient();
  const [groups, options] = await Promise.all([loadGroups(supabase), loadOptions(supabase)]);

  return (
    <>
      <PageHeader
        title="Modifier groups"
        description="Reusable sets of choices, like Size or Extras, that you attach to items."
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
          <CardTitle>Add a modifier group</CardTitle>
        </CardHeader>
        <GroupForm />
      </Card>

      {groups.length === 0 ? (
        <EmptyState title="No modifier groups yet">
          <p>Add a group above, then add its options on the next screen.</p>
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-xl border bg-card px-5">
          {groups.map((group, index) => {
            const own = options.filter((option) => option.group_id === group.id);
            return (
              <li
                key={group.id}
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/staff/manager/menu/modifiers/${group.id}`}
                      className="text-lg font-semibold underline-offset-4 hover:underline"
                    >
                      {group.name}
                    </Link>
                    {!group.is_active ? <Badge variant="outline">Archived</Badge> : null}
                  </div>
                  <p className="text-base text-muted-foreground">
                    {own.length} {own.length === 1 ? "option" : "options"} ·{" "}
                    {group.min_select > 0
                      ? `choose ${group.min_select === group.max_select ? group.min_select : `${group.min_select}–${group.max_select}`}`
                      : `optional, up to ${group.max_select}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    action={moveGroupAction.bind(null, group.id, "up")}
                    disabled={index === 0}
                    aria-label={`Move ${group.name} up`}
                  >
                    Up
                  </ActionButton>
                  <ActionButton
                    action={moveGroupAction.bind(null, group.id, "down")}
                    disabled={index === groups.length - 1}
                    aria-label={`Move ${group.name} down`}
                  >
                    Down
                  </ActionButton>
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={`/staff/manager/menu/modifiers/${group.id}`}
                      aria-label={`Edit ${group.name}`}
                    >
                      Edit
                    </Link>
                  </Button>
                  <ActionButton
                    action={setGroupActiveAction.bind(null, group.id, !group.is_active)}
                    aria-label={`${group.is_active ? "Archive" : "Restore"} group ${group.name}`}
                    confirm={
                      group.is_active
                        ? {
                            title: `Archive "${group.name}"?`,
                            description:
                              "Customers stop seeing this group on every item it is attached to. You can restore it later.",
                            confirmLabel: "Archive",
                          }
                        : undefined
                    }
                  >
                    {group.is_active ? "Archive" : "Restore"}
                  </ActionButton>
                  <ActionButton
                    variant="ghost"
                    action={deleteGroupAction.bind(null, group.id)}
                    aria-label={`Delete group ${group.name}`}
                    confirm={{
                      title: `Delete "${group.name}"?`,
                      description:
                        "This removes the group, its options and its links to items. A group used by a past order can't be deleted: archive it instead.",
                      confirmLabel: "Delete",
                      destructive: true,
                    }}
                  >
                    Delete
                  </ActionButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
