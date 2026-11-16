import "server-only";

import type { CafeSettings, Catalog } from "./catalog";
import { loadMenu } from "./menu-loader";
import { resolveTable, tableProblemCopy, type ResolvedTable } from "./table-resolver";

export type CustomerPageData =
  | { kind: "no_table" }
  | { kind: "table_problem"; title: string; body: string; retry: boolean }
  | { kind: "menu_error"; table: ResolvedTable }
  | { kind: "ready"; table: ResolvedTable; catalog: Catalog; settings: CafeSettings };

/** Shared by /menu, /cart and /checkout: validate the table, then load the live menu. */
export async function loadCustomerPage(tableParam: unknown): Promise<CustomerPageData> {
  const raw = Array.isArray(tableParam) ? tableParam[0] : tableParam;
  if (raw === undefined || raw === "") return { kind: "no_table" };

  const resolution = await resolveTable(raw);
  if (resolution.status !== "ok") {
    return { kind: "table_problem", ...tableProblemCopy(resolution) };
  }
  const menu = await loadMenu();
  if (!menu.ok) return { kind: "menu_error", table: resolution.table };
  return { kind: "ready", table: resolution.table, catalog: menu.catalog, settings: menu.settings };
}
