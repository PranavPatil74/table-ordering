/**
 * Pure planning helpers for the menu repository (no network), so they are unit tested.
 */

export interface Sortable {
  id: string;
  sort_order: number;
}

export type Direction = "up" | "down";

/**
 * Moves one row one place up or down among its siblings and returns the `sort_order` updates
 * needed. Siblings must already be in display order. Positions are renormalised to 10, 20, 30...
 * so rows that share a sort_order (new rows default to 0) still move predictably. Only rows whose
 * value changes are returned; an empty list means "already at the edge" or "unknown id".
 */
export function planMove(
  siblings: readonly Sortable[],
  id: string,
  direction: Direction,
): { id: string; sort_order: number }[] {
  const from = siblings.findIndex((row) => row.id === id);
  if (from === -1) return [];
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= siblings.length) return [];

  const order = siblings.map((row) => row.id);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);

  const current = new Map(siblings.map((row) => [row.id, row.sort_order]));
  return order
    .map((rowId, index) => ({ id: rowId, sort_order: (index + 1) * 10 }))
    .filter((row) => current.get(row.id) !== row.sort_order);
}

/** Next sort_order for a row added at the end of a list. */
export function nextSortOrder(existing: readonly number[]): number {
  return existing.length === 0 ? 10 : Math.max(...existing) + 10;
}

/** `base`, `base-2`, `base-3`... for slug collisions (slugs are capped well under 80 chars). */
export function slugCandidates(base: string, count = 6): string[] {
  return Array.from({ length: count }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`));
}

/** Which ids to add and remove to turn `current` into `wanted` (order-insensitive, no repeats). */
export function diffIds(current: readonly string[], wanted: readonly string[]) {
  const have = new Set(current);
  const want = new Set(wanted);
  return {
    add: [...want].filter((id) => !have.has(id)),
    remove: [...have].filter((id) => !want.has(id)),
  };
}

/** Integer paise -> the text a manager types and edits: 24950 -> "249.50". Integer maths only. */
export function paiseToInput(paise: number): string {
  const whole = Math.trunc(paise / 100);
  return `${whole}.${String(paise % 100).padStart(2, "0")}`;
}
