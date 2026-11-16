"use server";

import { z } from "zod";

import { managerAction, toResult } from "@/lib/auth/manager-action";
import { fail, readText, type ActionResult } from "@/lib/forms";
import { idSchema, parse } from "@/lib/menu/validation";
import { createTable, renameTable, setTableActive } from "@/lib/tables/repository";
import { tableCreateSchema, tableRenameSchema } from "@/lib/tables/table-code";

/** Table administration Server Actions: manager-only, server-validated, RLS-enforced. */

export async function createTableAction(_prev: ActionResult | null, form: FormData) {
  const parsed = parse(tableCreateSchema, {
    code: readText(form, "code"),
    label: readText(form, "label"),
  });
  if (!parsed.ok) return fail("Please fix the highlighted fields.", parsed.errors);
  return managerAction(async (supabase) =>
    toResult(
      await createTable(supabase, parsed.data),
      `Added table ${parsed.data.code}.`,
      (t) => t.id,
    ),
  );
}

export async function renameTableAction(_prev: ActionResult | null, form: FormData) {
  const id = readText(form, "id");
  if (!parse(idSchema, id).ok) return fail("That table is not valid.");
  const parsed = parse(tableRenameSchema, { label: readText(form, "label") });
  if (!parsed.ok) return fail("Please fix the highlighted fields.", parsed.errors);
  return managerAction(async (supabase) =>
    toResult(await renameTable(supabase, id, parsed.data), "Table renamed."),
  );
}

export async function setTableActiveAction(id: string, active: boolean) {
  if (!parse(z.object({ id: idSchema, active: z.boolean() }), { id, active }).ok) {
    return fail("That request is not valid.");
  }
  return managerAction(async (supabase) =>
    toResult(
      await setTableActive(supabase, id, active),
      active
        ? "Table reactivated. Its QR code works again."
        : "Table deactivated. Its QR code no longer takes orders.",
    ),
  );
}
