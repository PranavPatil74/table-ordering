/**
 * Data access for cafe tables. Runs as the signed-in manager: row-level security still decides
 * what is allowed. There is intentionally no delete: a table that has orders can never be removed
 * (orders.table_id is RESTRICT), so tables are deactivated instead and their history is kept.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { describeDbError } from "@/lib/menu/errors";
import { nextSortOrder } from "@/lib/menu/plan";
import type { RepoResult } from "@/lib/menu/repository";

import type { TableCreateInput, TableRenameInput } from "./table-code";

export interface TableRow {
  id: string;
  code: string;
  label: string;
  is_active: boolean;
  sort_order: number;
}

const COLUMNS = "id, code, label, is_active, sort_order";

function fail(error: {
  code?: string | undefined;
  message?: string | undefined;
}): RepoResult<never> {
  const friendly = describeDbError(error, "table");
  return friendly.field
    ? { ok: false, message: friendly.message, kind: friendly.kind, field: friendly.field }
    : { ok: false, message: friendly.message, kind: friendly.kind };
}

export async function loadTables(supabase: SupabaseClient): Promise<TableRow[]> {
  const { data, error } = await supabase
    .from("cafe_tables")
    .select(COLUMNS)
    .order("sort_order")
    .order("code");
  if (error || !Array.isArray(data)) throw new Error("Could not load tables");
  return data as TableRow[];
}

export async function createTable(
  supabase: SupabaseClient,
  input: TableCreateInput,
): Promise<RepoResult<TableRow>> {
  const existing = await supabase.from("cafe_tables").select("sort_order");
  if (existing.error) return fail(existing.error);

  const { data, error } = await supabase
    .from("cafe_tables")
    .insert({
      code: input.code,
      label: input.label,
      sort_order: nextSortOrder(
        (existing.data ?? []).map((row: { sort_order: number }) => row.sort_order),
      ),
    })
    .select(COLUMNS)
    .single();
  return error ? fail(error) : { ok: true, data: data as TableRow };
}

/** Renames the label only. The code is fixed once created, because it is printed in a QR code. */
export async function renameTable(
  supabase: SupabaseClient,
  id: string,
  input: TableRenameInput,
): Promise<RepoResult<TableRow>> {
  const { data, error } = await supabase
    .from("cafe_tables")
    .update({ label: input.label })
    .eq("id", id)
    .select(COLUMNS)
    .single();
  return error ? fail(error) : { ok: true, data: data as TableRow };
}

export async function setTableActive(
  supabase: SupabaseClient,
  id: string,
  active: boolean,
): Promise<RepoResult<TableRow>> {
  const { data, error } = await supabase
    .from("cafe_tables")
    .update({ is_active: active })
    .eq("id", id)
    .select(COLUMNS)
    .single();
  return error ? fail(error) : { ok: true, data: data as TableRow };
}
