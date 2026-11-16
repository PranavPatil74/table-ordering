/**
 * The staff directory as plain data, with the pure search/filter logic the screen uses.
 * Client-safe: no database, no secrets.
 */
import type { StaffRole } from "@/lib/auth/staff";

export interface StaffRow {
  userId: string;
  displayName: string;
  /** From the Auth system. Null when it could not be loaded; the screen says so. */
  email: string | null;
  role: StaffRole;
  isActive: boolean;
  createdAt: string;
}

export type RoleFilter = "all" | StaffRole;
export type StatusFilter = "all" | "active" | "inactive";

export interface StaffFilters {
  query: string;
  role: RoleFilter;
  status: StatusFilter;
}

export const NO_FILTERS: StaffFilters = { query: "", role: "all", status: "all" };

export const isFiltered = (filters: StaffFilters) =>
  filters.query.trim() !== "" || filters.role !== "all" || filters.status !== "all";

export function filterStaff(rows: readonly StaffRow[], filters: StaffFilters): StaffRow[] {
  const needle = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.role !== "all" && row.role !== filters.role) return false;
    if (filters.status === "active" && !row.isActive) return false;
    if (filters.status === "inactive" && row.isActive) return false;
    if (!needle) return true;
    return (
      row.displayName.toLowerCase().includes(needle) ||
      (row.email?.toLowerCase().includes(needle) ?? false)
    );
  });
}

/** Active managers first, then by name: the people who can run the cafe come first. */
export function sortStaff(rows: readonly StaffRow[]): StaffRow[] {
  const rank = (row: StaffRow) => (row.isActive ? 0 : 2) + (row.role === "manager" ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
}

export const activeManagerCount = (rows: readonly StaffRow[]) =>
  rows.filter((row) => row.role === "manager" && row.isActive).length;

export type DeactivationBlock = "self" | "last_manager" | null;

/**
 * Why this person's account must not be deactivated from the screen. The database independently
 * enforces the last-manager rule; "self" is an application rule that stops a manager locking
 * themselves out by accident.
 */
export function deactivationBlock(
  row: StaffRow,
  currentUserId: string,
  rows: readonly StaffRow[],
): DeactivationBlock {
  if (row.userId === currentUserId) return "self";
  if (row.role === "manager" && row.isActive && activeManagerCount(rows) <= 1) {
    return "last_manager";
  }
  return null;
}
