/**
 * Table identifiers. The `code` (for example "T05") is what a QR code carries. It is NOT a secret:
 * it only lets a customer start an order for that table, and the order still has to be paid for.
 *
 * Phase 4's customer menu must use these helpers so "valid table" means the same thing everywhere.
 */
import { z } from "zod";

/** Mirrors the database constraint `cafe_tables_code_format`. */
export const TABLE_CODE_FORMAT = /^[A-Z][A-Z0-9_-]{1,15}$/;

/**
 * Normalises a code typed or scanned by a person. Returns null when it cannot be a table code at
 * all (wrong characters, too long, not text); this never says whether the table exists.
 */
export function normalizeTableCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return TABLE_CODE_FORMAT.test(code) ? code : null;
}

/** A table may take orders only while it exists AND is active. Deactivated tables never do. */
export function isOrderableTable(table: { is_active: boolean } | null | undefined): boolean {
  return table?.is_active === true;
}

/** "T06" after "T05": the next free numeric code in the T01, T02... series. */
export function suggestNextCode(existing: readonly string[]): string {
  const numbers = existing
    .map((code) => /^T(\d{1,4})$/.exec(code)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number);
  const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
  return `T${String(next).padStart(2, "0")}`;
}

const cleanLabel = (value: string) => value.replace(/\s+/g, " ").trim();

const labelField = z
  .string("Name is required.")
  .transform(cleanLabel)
  .pipe(z.string().min(1, "Name is required.").max(40, "Name can be at most 40 characters."));

export const tableCreateSchema = z.object({
  code: z
    .string("Code is required.")
    .transform((value) => value.trim().toUpperCase())
    .pipe(
      z
        .string()
        .min(1, "Code is required.")
        .regex(
          TABLE_CODE_FORMAT,
          "Use 2 to 16 capital letters, digits, dashes or underscores, starting with a letter (for example T06).",
        ),
    ),
  label: labelField,
});
export type TableCreateInput = z.output<typeof tableCreateSchema>;

export const tableRenameSchema = z.object({ label: labelField });
export type TableRenameInput = z.output<typeof tableRenameSchema>;
