import Link from "next/link";

import { ItemForm } from "@/components/admin/item-form";
import { EmptyState, PageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { requireStaffPage } from "@/lib/auth/session";
import { loadCategories } from "@/lib/menu/repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata = { title: "Add menu item" };

export default async function NewItemPage() {
  await requireStaffPage("manager");
  const categories = await loadCategories(await createSupabaseServerClient());
  return (
    <>
      <PageHeader
        title="Add item"
        actions={
          <Link
            href="/staff/manager/menu"
            className="text-base font-semibold underline underline-offset-4"
          >
            Back to menu
          </Link>
        }
      />
      {categories.length === 0 ? (
        <EmptyState title="Add a category first">
          <Button asChild>
            <Link href="/staff/manager/menu/categories">Add a category</Link>
          </Button>
        </EmptyState>
      ) : (
        <div className="max-w-2xl">
          <ItemForm categories={categories} />
        </div>
      )}
    </>
  );
}
