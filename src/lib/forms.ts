/**
 * Small, framework-free helpers shared by every admin form: the result type Server Actions return,
 * and readers that turn raw `FormData` into plain values. Nothing here trusts the browser: callers
 * validate the values with zod afterwards.
 */

/** What an admin Server Action tells its form. Never contains raw database errors. */
export type ActionResult =
  | { ok: true; message: string; id?: string }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

export const idleResult: ActionResult | null = null;

export function ok(message: string, id?: string): ActionResult {
  return id === undefined ? { ok: true, message } : { ok: true, message, id };
}

export function fail(message: string, fieldErrors?: Record<string, string>): ActionResult {
  return fieldErrors ? { ok: false, message, fieldErrors } : { ok: false, message };
}

/** Text field: a string, or "" when absent or not text (never null, never a File). */
export function readText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** Checkbox: HTML sends the field only when ticked. */
export function readFlag(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === "on" || value === "true" || value === "1";
}

/** Repeated fields (checkbox groups). */
export function readAll(form: FormData, name: string): string[] {
  return form.getAll(name).filter((value): value is string => typeof value === "string");
}
