/**
 * Data access for menu administration. Every function takes a Supabase client and runs AS THE
 * SIGNED-IN MANAGER: Phase 1's grants, row-level security and guard triggers still decide what is
 * allowed, so a bug here can never exceed a manager's database privileges. (The service-role key
 * is deliberately not used.)
 *
 * No `server-only` import: the integration tests call these exact functions with real manager and
 * counter sessions.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { describeDbError, type DbErrorKind, type Subject } from "./errors";
import { diffIds, nextSortOrder, planMove, slugCandidates, type Direction } from "./plan";
import {
  checkGroupRules,
  slugify,
  type CategoryInput,
  type DietaryTag,
  type GroupInput,
  type ItemInput,
  type OptionInput,
} from "./validation";

export type RepoResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; message: string; kind: DbErrorKind | "rule"; field?: string };

const good = <T>(data: T): RepoResult<T> => ({ ok: true, data });
const bad = (
  message: string,
  kind: DbErrorKind | "rule" = "invalid",
  field?: string,
): RepoResult<never> =>
  field ? { ok: false, message, kind, field } : { ok: false, message, kind };

function dbFail(
  error: { code?: string | undefined; message?: string | undefined },
  subject: Subject,
  action: "save" | "delete" = "save",
): RepoResult<never> {
  const friendly = describeDbError(error, subject, action);
  return bad(friendly.message, friendly.kind, friendly.field);
}

// ------------------------------------------------------------------------------------------
// Row types (exactly the columns the admin screens use)
// ------------------------------------------------------------------------------------------

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface ItemRow {
  id: string;
  category_id: string;
  slug: string;
  name: string;
  description: string | null;
  ingredients: string | null;
  dietary_tags: DietaryTag[];
  price_paise: number;
  image_path: string | null;
  sort_order: number;
  is_active: boolean;
  is_available: boolean;
}

export interface GroupRow {
  id: string;
  slug: string;
  name: string;
  min_select: number;
  max_select: number;
  sort_order: number;
  is_active: boolean;
}

export interface OptionRow {
  id: string;
  group_id: string;
  name: string;
  price_delta_paise: number;
  is_default: boolean;
  sort_order: number;
  is_active: boolean;
  is_available: boolean;
}

export interface AttachmentRow {
  item_id: string;
  group_id: string;
  sort_order: number;
}

const CATEGORY_COLUMNS = "id, slug, name, description, sort_order, is_active";
const ITEM_COLUMNS =
  "id, category_id, slug, name, description, ingredients, dietary_tags, price_paise, image_path, sort_order, is_active, is_available";
const GROUP_COLUMNS = "id, slug, name, min_select, max_select, sort_order, is_active";
const OPTION_COLUMNS =
  "id, group_id, name, price_delta_paise, is_default, sort_order, is_active, is_available";

// ------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------

/** Thrown by page loaders so the route's error boundary shows a retry screen. */
export class AdminLoadError extends Error {
  constructor(what: string) {
    super(`Could not load ${what}`);
    this.name = "AdminLoadError";
  }
}

async function list<T>(
  query: PromiseLike<{ data: unknown; error: unknown }>,
  what: string,
): Promise<T[]> {
  const { data, error } = await query;
  if (error || !Array.isArray(data)) throw new AdminLoadError(what);
  return data as T[];
}

export const loadCategories = (supabase: SupabaseClient) =>
  list<CategoryRow>(
    supabase.from("menu_categories").select(CATEGORY_COLUMNS).order("sort_order").order("name"),
    "categories",
  );

export const loadItems = (supabase: SupabaseClient) =>
  list<ItemRow>(
    supabase.from("menu_items").select(ITEM_COLUMNS).order("sort_order").order("name"),
    "menu items",
  );

export const loadGroups = (supabase: SupabaseClient) =>
  list<GroupRow>(
    supabase.from("modifier_groups").select(GROUP_COLUMNS).order("sort_order").order("name"),
    "modifier groups",
  );

export const loadOptions = (supabase: SupabaseClient) =>
  list<OptionRow>(
    supabase.from("modifier_options").select(OPTION_COLUMNS).order("sort_order").order("name"),
    "modifier options",
  );

export const loadAttachments = (supabase: SupabaseClient) =>
  list<AttachmentRow>(
    supabase
      .from("menu_item_modifier_groups")
      .select("item_id, group_id, sort_order")
      .order("sort_order"),
    "modifier attachments",
  );

// ------------------------------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------------------------------

type Table = "menu_categories" | "menu_items" | "modifier_groups" | "modifier_options";

async function nextOrderIn(
  supabase: SupabaseClient,
  table: Table,
  scope?: { column: string; value: string },
): Promise<number> {
  let query = supabase.from(table).select("sort_order");
  if (scope) query = query.eq(scope.column, scope.value);
  const { data } = await query;
  return nextSortOrder((data ?? []).map((row: { sort_order: number }) => row.sort_order));
}

/** Insert with a slug derived from the name, retrying `-2`, `-3`... when the slug is taken. */
async function insertWithSlug<Row extends { id: string }>(
  supabase: SupabaseClient,
  table: Table,
  name: string,
  subject: Subject,
  columns: string,
  values: Record<string, unknown>,
): Promise<RepoResult<Row>> {
  for (const slug of slugCandidates(slugify(name))) {
    const { data, error } = await supabase
      .from(table)
      .insert({ ...values, slug })
      .select(columns)
      .single();
    if (!error) return good(data as unknown as Row);
    const slugTaken = error.code === "23505" && /slug_unique/.test(error.message ?? "");
    if (!slugTaken) return dbFail(error, subject);
  }
  return bad(`A ${subject} with a very similar name already exists.`, "duplicate", "name");
}

async function applySortOrders(
  supabase: SupabaseClient,
  table: Table,
  updates: { id: string; sort_order: number }[],
  subject: Subject,
): Promise<RepoResult> {
  for (const update of updates) {
    const { error } = await supabase
      .from(table)
      .update({ sort_order: update.sort_order })
      .eq("id", update.id);
    if (error) return dbFail(error, subject);
  }
  return good(undefined);
}

async function move(
  supabase: SupabaseClient,
  table: Table,
  id: string,
  direction: Direction,
  subject: Subject,
  scope?: { column: string; value: string },
): Promise<RepoResult> {
  let query = supabase.from(table).select("id, sort_order").order("sort_order").order("name");
  if (scope) query = query.eq(scope.column, scope.value);
  const { data, error } = await query;
  if (error) return dbFail(error, subject);
  return applySortOrders(
    supabase,
    table,
    planMove((data ?? []) as { id: string; sort_order: number }[], id, direction),
    subject,
  );
}

// ------------------------------------------------------------------------------------------
// Categories
// ------------------------------------------------------------------------------------------

export async function createCategory(supabase: SupabaseClient, input: CategoryInput) {
  return insertWithSlug<CategoryRow>(
    supabase,
    "menu_categories",
    input.name,
    "category",
    CATEGORY_COLUMNS,
    {
      name: input.name,
      description: input.description,
      sort_order: await nextOrderIn(supabase, "menu_categories"),
    },
  );
}

export async function updateCategory(supabase: SupabaseClient, id: string, input: CategoryInput) {
  const { data, error } = await supabase
    .from("menu_categories")
    .update({ name: input.name, description: input.description })
    .eq("id", id)
    .select(CATEGORY_COLUMNS)
    .single();
  return error ? dbFail(error, "category") : good(data as CategoryRow);
}

export async function setCategoryActive(supabase: SupabaseClient, id: string, active: boolean) {
  const { error, data } = await supabase
    .from("menu_categories")
    .update({ is_active: active })
    .eq("id", id)
    .select("id")
    .single();
  return error || !data ? dbFail(error ?? { code: "PGRST116" }, "category") : good(undefined);
}

export async function deleteCategory(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("menu_categories").delete().eq("id", id);
  return error ? dbFail(error, "category", "delete") : good(undefined);
}

export const moveCategory = (supabase: SupabaseClient, id: string, direction: Direction) =>
  move(supabase, "menu_categories", id, direction, "category");

// ------------------------------------------------------------------------------------------
// Items
// ------------------------------------------------------------------------------------------

function itemValues(input: ItemInput) {
  return {
    category_id: input.categoryId,
    name: input.name,
    description: input.description,
    ingredients: input.ingredients,
    dietary_tags: input.dietaryTags,
    price_paise: input.pricePaise,
    is_active: input.isActive,
    is_available: input.isAvailable,
  };
}

export async function createItem(supabase: SupabaseClient, input: ItemInput) {
  return insertWithSlug<ItemRow>(supabase, "menu_items", input.name, "item", ITEM_COLUMNS, {
    ...itemValues(input),
    sort_order: await nextOrderIn(supabase, "menu_items", {
      column: "category_id",
      value: input.categoryId,
    }),
  });
}

/** `image_path` and `slug` are deliberately not touched: an edit never changes either. */
export async function updateItem(supabase: SupabaseClient, id: string, input: ItemInput) {
  const { data, error } = await supabase
    .from("menu_items")
    .update(itemValues(input))
    .eq("id", id)
    .select(ITEM_COLUMNS)
    .single();
  return error ? dbFail(error, "item") : good(data as ItemRow);
}

export type ItemFlag = "is_active" | "is_available";

export async function setItemFlag(
  supabase: SupabaseClient,
  id: string,
  flag: ItemFlag,
  value: boolean,
) {
  const { error, data } = await supabase
    .from("menu_items")
    .update({ [flag]: value })
    .eq("id", id)
    .select("id")
    .single();
  return error || !data ? dbFail(error ?? { code: "PGRST116" }, "item") : good(undefined);
}

export async function deleteItem(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("menu_items").delete().eq("id", id);
  return error ? dbFail(error, "item", "delete") : good(undefined);
}

export async function moveItem(supabase: SupabaseClient, id: string, direction: Direction) {
  const { data, error } = await supabase
    .from("menu_items")
    .select("category_id")
    .eq("id", id)
    .single();
  if (error || !data) return dbFail(error ?? { code: "PGRST116" }, "item");
  return move(supabase, "menu_items", id, direction, "item", {
    column: "category_id",
    value: (data as { category_id: string }).category_id,
  });
}

/** Replaces the set of modifier groups attached to an item. */
export async function setItemModifierGroups(
  supabase: SupabaseClient,
  itemId: string,
  groupIds: readonly string[],
): Promise<RepoResult<{ added: number; removed: number }>> {
  const current = await supabase
    .from("menu_item_modifier_groups")
    .select("group_id")
    .eq("item_id", itemId);
  if (current.error) return dbFail(current.error, "attachment");

  const { add, remove } = diffIds(
    (current.data ?? []).map((row: { group_id: string }) => row.group_id),
    groupIds,
  );

  if (remove.length > 0) {
    const { error } = await supabase
      .from("menu_item_modifier_groups")
      .delete()
      .eq("item_id", itemId)
      .in("group_id", remove);
    if (error) return dbFail(error, "attachment", "delete");
  }
  if (add.length > 0) {
    const start = nextSortOrder(
      (current.data ?? []).map((_row: unknown, index: number) => index * 10),
    );
    const { error } = await supabase.from("menu_item_modifier_groups").insert(
      add.map((group_id, index) => ({
        item_id: itemId,
        group_id,
        sort_order: start + index * 10,
      })),
    );
    if (error) return dbFail(error, "attachment");
  }
  return good({ added: add.length, removed: remove.length });
}

// ------------------------------------------------------------------------------------------
// Modifier groups and options
// ------------------------------------------------------------------------------------------

async function loadGroupWithOptions(supabase: SupabaseClient, groupId: string) {
  const group = await supabase
    .from("modifier_groups")
    .select(GROUP_COLUMNS)
    .eq("id", groupId)
    .single();
  if (group.error || !group.data) return null;
  const options = await supabase
    .from("modifier_options")
    .select(OPTION_COLUMNS)
    .eq("group_id", groupId);
  if (options.error) return null;
  return { group: group.data as GroupRow, options: (options.data ?? []) as OptionRow[] };
}

const countRules = (min: number, max: number, options: readonly OptionRow[]) => {
  const active = options.filter((option) => option.is_active);
  return checkGroupRules({
    minSelect: min,
    maxSelect: max,
    activeOptions: active.length,
    defaultOptions: active.filter((option) => option.is_default).length,
  });
};

export async function createGroup(supabase: SupabaseClient, input: GroupInput) {
  // A new group has no options yet, so it cannot require any: make it required after adding some.
  if (input.minSelect > 0) {
    return bad(
      "Add the options first, then make the group required. A new group has no options yet.",
      "rule",
      "minSelect",
    );
  }
  return insertWithSlug<GroupRow>(
    supabase,
    "modifier_groups",
    input.name,
    "modifier group",
    GROUP_COLUMNS,
    {
      name: input.name,
      min_select: input.minSelect,
      max_select: input.maxSelect,
      is_active: input.isActive,
      sort_order: await nextOrderIn(supabase, "modifier_groups"),
    },
  );
}

export async function updateGroup(supabase: SupabaseClient, id: string, input: GroupInput) {
  const existing = await loadGroupWithOptions(supabase, id);
  if (!existing) return dbFail({ code: "PGRST116" }, "modifier group");
  if (input.isActive) {
    const problems = countRules(input.minSelect, input.maxSelect, existing.options);
    if (problems.length > 0) return bad(problems.join(" "), "rule", "minSelect");
  }
  const { data, error } = await supabase
    .from("modifier_groups")
    .update({
      name: input.name,
      min_select: input.minSelect,
      max_select: input.maxSelect,
      is_active: input.isActive,
    })
    .eq("id", id)
    .select(GROUP_COLUMNS)
    .single();
  return error ? dbFail(error, "modifier group") : good(data as GroupRow);
}

export async function setGroupActive(supabase: SupabaseClient, id: string, active: boolean) {
  const existing = await loadGroupWithOptions(supabase, id);
  if (!existing) return dbFail({ code: "PGRST116" }, "modifier group");
  if (active) {
    const problems = countRules(
      existing.group.min_select,
      existing.group.max_select,
      existing.options,
    );
    if (problems.length > 0) return bad(problems.join(" "), "rule");
  }
  const { error } = await supabase
    .from("modifier_groups")
    .update({ is_active: active })
    .eq("id", id);
  return error ? dbFail(error, "modifier group") : good(undefined);
}

export async function deleteGroup(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("modifier_groups").delete().eq("id", id);
  return error ? dbFail(error, "modifier group", "delete") : good(undefined);
}

export const moveGroup = (supabase: SupabaseClient, id: string, direction: Direction) =>
  move(supabase, "modifier_groups", id, direction, "modifier group");

/** Applies a proposed change to one option, then checks the group's rules still hold. */
async function checkOptionChange(
  supabase: SupabaseClient,
  groupId: string,
  change: (options: OptionRow[]) => OptionRow[],
): Promise<RepoResult<void>> {
  const existing = await loadGroupWithOptions(supabase, groupId);
  if (!existing) return dbFail({ code: "PGRST116" }, "modifier group");
  if (!existing.group.is_active) return good(undefined);
  const problems = countRules(
    existing.group.min_select,
    existing.group.max_select,
    change(existing.options),
  );
  return problems.length > 0 ? bad(problems.join(" "), "rule") : good(undefined);
}

function optionValues(input: OptionInput) {
  return {
    name: input.name,
    price_delta_paise: input.priceDeltaPaise,
    is_default: input.isDefault,
    is_active: input.isActive,
    is_available: input.isAvailable,
  };
}

export async function createOption(supabase: SupabaseClient, groupId: string, input: OptionInput) {
  const draft: OptionRow = {
    id: "new",
    group_id: groupId,
    name: input.name,
    price_delta_paise: input.priceDeltaPaise,
    is_default: input.isDefault,
    sort_order: 0,
    is_active: input.isActive,
    is_available: input.isAvailable,
  };
  const rules = await checkOptionChange(supabase, groupId, (options) => [...options, draft]);
  if (!rules.ok) return rules;

  const { data, error } = await supabase
    .from("modifier_options")
    .insert({
      ...optionValues(input),
      group_id: groupId,
      sort_order: await nextOrderIn(supabase, "modifier_options", {
        column: "group_id",
        value: groupId,
      }),
    })
    .select(OPTION_COLUMNS)
    .single();
  return error ? dbFail(error, "modifier option") : good(data as OptionRow);
}

export async function updateOption(supabase: SupabaseClient, id: string, input: OptionInput) {
  const found = await supabase.from("modifier_options").select("group_id").eq("id", id).single();
  if (found.error || !found.data)
    return dbFail(found.error ?? { code: "PGRST116" }, "modifier option");
  const groupId = (found.data as { group_id: string }).group_id;

  const rules = await checkOptionChange(supabase, groupId, (options) =>
    options.map((option) =>
      option.id === id
        ? {
            ...option,
            is_default: input.isDefault,
            is_active: input.isActive,
            is_available: input.isAvailable,
          }
        : option,
    ),
  );
  if (!rules.ok) return rules;

  const { data, error } = await supabase
    .from("modifier_options")
    .update(optionValues(input))
    .eq("id", id)
    .select(OPTION_COLUMNS)
    .single();
  return error ? dbFail(error, "modifier option") : good(data as OptionRow);
}

export type OptionFlag = "is_active" | "is_available" | "is_default";

export async function setOptionFlag(
  supabase: SupabaseClient,
  id: string,
  flag: OptionFlag,
  value: boolean,
) {
  const found = await supabase.from("modifier_options").select("group_id").eq("id", id).single();
  if (found.error || !found.data)
    return dbFail(found.error ?? { code: "PGRST116" }, "modifier option");
  const groupId = (found.data as { group_id: string }).group_id;

  if (flag !== "is_available") {
    const rules = await checkOptionChange(supabase, groupId, (options) =>
      options.map((option) => (option.id === id ? { ...option, [flag]: value } : option)),
    );
    if (!rules.ok) return rules;
  }
  const { error } = await supabase
    .from("modifier_options")
    .update({ [flag]: value })
    .eq("id", id);
  return error ? dbFail(error, "modifier option") : good(undefined);
}

export async function deleteOption(supabase: SupabaseClient, id: string) {
  const found = await supabase.from("modifier_options").select("group_id").eq("id", id).single();
  if (found.error || !found.data)
    return dbFail(found.error ?? { code: "PGRST116" }, "modifier option");
  const groupId = (found.data as { group_id: string }).group_id;

  const rules = await checkOptionChange(supabase, groupId, (options) =>
    options.filter((option) => option.id !== id),
  );
  if (!rules.ok) return rules;

  const { error } = await supabase.from("modifier_options").delete().eq("id", id);
  return error ? dbFail(error, "modifier option", "delete") : good(undefined);
}

export async function moveOption(supabase: SupabaseClient, id: string, direction: Direction) {
  const found = await supabase.from("modifier_options").select("group_id").eq("id", id).single();
  if (found.error || !found.data)
    return dbFail(found.error ?? { code: "PGRST116" }, "modifier option");
  return move(supabase, "modifier_options", id, direction, "modifier option", {
    column: "group_id",
    value: (found.data as { group_id: string }).group_id,
  });
}
