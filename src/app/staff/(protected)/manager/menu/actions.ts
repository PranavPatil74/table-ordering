"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { managerAction, toResult } from "@/lib/auth/manager-action";
import { fail, readAll, readFlag, readText, type ActionResult } from "@/lib/forms";
import * as repo from "@/lib/menu/repository";
import {
  categorySchema,
  groupSchema,
  idSchema,
  itemSchema,
  optionSchema,
  parse,
} from "@/lib/menu/validation";

/**
 * Menu administration Server Actions. Every one is a public endpoint, so each:
 *  - verifies the caller is an active manager (managerAction),
 *  - validates ALL input on the server with zod (ids, flags and money included),
 *  - writes through the manager's own session, so row-level security applies again.
 */

const MENU = "/staff/manager/menu";

const invalid = (errors: Record<string, string>): ActionResult =>
  fail("Please fix the highlighted fields.", errors);

const direction = z.enum(["up", "down"]);
const flag = z.boolean();

// ---------------------------------------------------------------- categories

export async function saveCategoryAction(_prev: ActionResult | null, form: FormData) {
  const id = readText(form, "id");
  const parsed = parse(categorySchema, {
    name: readText(form, "name"),
    description: readText(form, "description"),
  });
  if (!parsed.ok) return invalid(parsed.errors);

  return managerAction(async (supabase) => {
    if (id === "") {
      return toResult(
        await repo.createCategory(supabase, parsed.data),
        `Added "${parsed.data.name}".`,
        (c) => c.id,
      );
    }
    const checked = parse(idSchema, id);
    if (!checked.ok) return fail("That category is not valid.");
    return toResult(await repo.updateCategory(supabase, id, parsed.data), "Category saved.");
  });
}

export async function setCategoryActiveAction(id: string, active: boolean) {
  const args = parse(z.object({ id: idSchema, active: flag }), { id, active });
  if (!args.ok) return fail("That request is not valid.");
  return managerAction(async (supabase) =>
    toResult(
      await repo.setCategoryActive(supabase, id, active),
      active ? "Category restored." : "Category archived. Its items are hidden from customers.",
    ),
  );
}

export async function deleteCategoryAction(id: string) {
  if (!parse(idSchema, id).ok) return fail("That request is not valid.");
  return managerAction(async (supabase) =>
    toResult(await repo.deleteCategory(supabase, id), "Category deleted."),
  );
}

export async function moveCategoryAction(id: string, dir: "up" | "down") {
  if (!parse(z.object({ id: idSchema, dir: direction }), { id, dir }).ok)
    return fail("That request is not valid.");
  return managerAction(async (supabase) =>
    toResult(await repo.moveCategory(supabase, id, dir), "Order updated."),
  );
}

// --------------------------------------------------------------------- items

function readItem(form: FormData) {
  return {
    name: readText(form, "name"),
    categoryId: readText(form, "categoryId"),
    description: readText(form, "description"),
    ingredients: readText(form, "ingredients"),
    dietaryTags: readAll(form, "dietaryTags"),
    pricePaise: readText(form, "price"),
    isActive: readFlag(form, "isActive"),
    isAvailable: readFlag(form, "isAvailable"),
  };
}

/** Field name differs between form (`price`) and schema (`pricePaise`): map errors back. */
const itemErrors = (errors: Record<string, string>) => {
  const { pricePaise, ...rest } = errors;
  return invalid(pricePaise ? { ...rest, price: pricePaise } : rest);
};

export async function saveItemAction(_prev: ActionResult | null, form: FormData) {
  const id = readText(form, "id");
  const parsed = parse(itemSchema, readItem(form));
  if (!parsed.ok) return itemErrors(parsed.errors);
  if (id !== "" && !parse(idSchema, id).ok) return fail("That item is not valid.");

  const result = await managerAction(async (supabase) => {
    if (id === "") {
      return toResult(
        await repo.createItem(supabase, parsed.data),
        `Added "${parsed.data.name}".`,
        (i) => i.id,
      );
    }
    return toResult(await repo.updateItem(supabase, id, parsed.data), "Item saved.", () => id);
  });
  if (result.ok && id === "" && result.id) redirect(`${MENU}/items/${result.id}?created=1`);
  return result;
}

export async function setItemFlagAction(
  id: string,
  which: "is_active" | "is_available",
  value: boolean,
) {
  const args = parse(
    z.object({ id: idSchema, which: z.enum(["is_active", "is_available"]), value: flag }),
    { id, which, value },
  );
  if (!args.ok) return fail("That request is not valid.");
  const message =
    which === "is_available"
      ? value
        ? "Marked available."
        : "Marked sold out."
      : value
        ? "Item restored to the menu."
        : "Item archived. Customers no longer see it.";
  return managerAction(async (supabase) =>
    toResult(await repo.setItemFlag(supabase, id, which, value), message),
  );
}

export async function deleteItemAction(id: string) {
  if (!parse(idSchema, id).ok) return fail("That request is not valid.");
  return managerAction(async (supabase) =>
    toResult(await repo.deleteItem(supabase, id), "Item deleted."),
  );
}

export async function moveItemAction(id: string, dir: "up" | "down") {
  if (!parse(z.object({ id: idSchema, dir: direction }), { id, dir }).ok)
    return fail("That request is not valid.");
  return managerAction(async (supabase) =>
    toResult(await repo.moveItem(supabase, id, dir), "Order updated."),
  );
}

export async function saveItemGroupsAction(_prev: ActionResult | null, form: FormData) {
  const itemId = readText(form, "itemId");
  const groupIds = readAll(form, "groupIds");
  const parsed = parse(z.object({ itemId: idSchema, groupIds: z.array(idSchema).max(50) }), {
    itemId,
    groupIds,
  });
  if (!parsed.ok) return fail("That request is not valid.");
  return managerAction(async (supabase) =>
    toResult(await repo.setItemModifierGroups(supabase, itemId, groupIds), "Choices saved."),
  );
}

// ------------------------------------------------------------ modifier groups

function readGroup(form: FormData) {
  return {
    name: readText(form, "name"),
    minSelect: readText(form, "minSelect"),
    maxSelect: readText(form, "maxSelect"),
    isActive: readFlag(form, "isActive"),
  };
}

export async function saveGroupAction(_prev: ActionResult | null, form: FormData) {
  const id = readText(form, "id");
  const parsed = parse(groupSchema, readGroup(form));
  if (!parsed.ok) return invalid(parsed.errors);
  if (id !== "" && !parse(idSchema, id).ok) return fail("That group is not valid.");

  const result = await managerAction(async (supabase) => {
    if (id === "") {
      return toResult(
        await repo.createGroup(supabase, parsed.data),
        `Added "${parsed.data.name}".`,
        (g) => g.id,
      );
    }
    return toResult(await repo.updateGroup(supabase, id, parsed.data), "Group saved.", () => id);
  });
  if (result.ok && id === "" && result.id) redirect(`${MENU}/modifiers/${result.id}?created=1`);
  return result;
}

export async function setGroupActiveAction(id: string, active: boolean) {
  if (!parse(z.object({ id: idSchema, active: flag }), { id, active }).ok)
    return fail("That request is not valid.");
  return managerAction(async (supabase) =>
    toResult(
      await repo.setGroupActive(supabase, id, active),
      active ? "Group restored." : "Group archived. Customers no longer see it.",
    ),
  );
}

export async function deleteGroupAction(id: string) {
  if (!parse(idSchema, id).ok) return fail("That request is not valid.");
  return managerAction(async (supabase) =>
    toResult(await repo.deleteGroup(supabase, id), "Group deleted."),
  );
}

export async function moveGroupAction(id: string, dir: "up" | "down") {
  if (!parse(z.object({ id: idSchema, dir: direction }), { id, dir }).ok)
    return fail("That request is not valid.");
  return managerAction(async (supabase) =>
    toResult(await repo.moveGroup(supabase, id, dir), "Order updated."),
  );
}

// ------------------------------------------------------------ modifier options

function readOption(form: FormData) {
  return {
    name: readText(form, "name"),
    priceDeltaPaise: readText(form, "price"),
    isDefault: readFlag(form, "isDefault"),
    isActive: readFlag(form, "isActive"),
    isAvailable: readFlag(form, "isAvailable"),
  };
}

export async function saveOptionAction(_prev: ActionResult | null, form: FormData) {
  const id = readText(form, "id");
  const groupId = readText(form, "groupId");
  const parsed = parse(optionSchema, readOption(form));
  if (!parsed.ok) {
    const { priceDeltaPaise, ...rest } = parsed.errors;
    return invalid(priceDeltaPaise ? { ...rest, price: priceDeltaPaise } : rest);
  }
  if (id === "" && !parse(idSchema, groupId).ok) return fail("That group is not valid.");
  if (id !== "" && !parse(idSchema, id).ok) return fail("That option is not valid.");

  return managerAction(async (supabase) => {
    if (id === "") {
      return toResult(
        await repo.createOption(supabase, groupId, parsed.data),
        `Added "${parsed.data.name}".`,
        (o) => o.id,
      );
    }
    return toResult(await repo.updateOption(supabase, id, parsed.data), "Option saved.");
  });
}

export async function setOptionFlagAction(
  id: string,
  which: "is_active" | "is_available" | "is_default",
  value: boolean,
) {
  const args = parse(
    z.object({
      id: idSchema,
      which: z.enum(["is_active", "is_available", "is_default"]),
      value: flag,
    }),
    { id, which, value },
  );
  if (!args.ok) return fail("That request is not valid.");
  const message =
    which === "is_available"
      ? value
        ? "Marked available."
        : "Marked sold out."
      : which === "is_default"
        ? value
          ? "Pre-selected by default."
          : "No longer pre-selected."
        : value
          ? "Option restored."
          : "Option archived.";
  return managerAction(async (supabase) =>
    toResult(await repo.setOptionFlag(supabase, id, which, value), message),
  );
}

export async function deleteOptionAction(id: string) {
  if (!parse(idSchema, id).ok) return fail("That request is not valid.");
  return managerAction(async (supabase) =>
    toResult(await repo.deleteOption(supabase, id), "Option deleted."),
  );
}

export async function moveOptionAction(id: string, dir: "up" | "down") {
  if (!parse(z.object({ id: idSchema, dir: direction }), { id, dir }).ok)
    return fail("That request is not valid.");
  return managerAction(async (supabase) =>
    toResult(await repo.moveOption(supabase, id, dir), "Order updated."),
  );
}
