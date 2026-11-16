import { expect } from "vitest";

import { denialMessage, isPermissionDenied } from "./harness";
import { describeResult, type ApiResultLike } from "./helpers";

/**
 * The API refused the request because of the caller's privileges: a missing GRANT, an RLS check,
 * or a guard trigger (SQLSTATE 42501), or the table/function is invisible to the role. A bad key,
 * an expired token or a constraint error does NOT count, so a broken test setup cannot pass here.
 */
export function expectDenied(what: string, result: ApiResultLike) {
  expect(isPermissionDenied(result), denialMessage(what, result)).toBe(true);
}

/**
 * The write did not take effect for this caller: either refused outright, or accepted by the API
 * but filtered to zero rows by row-level security (PostgREST answers 2xx with an empty list).
 * Callers must ALSO read the row back as the service role to prove nothing changed.
 */
export function expectNotApplied(what: string, result: ApiResultLike & { data?: unknown }) {
  if (result.error) {
    expect(isPermissionDenied(result), `${what}: ${describeResult(result)}`).toBe(true);
    return;
  }
  expect(result.data, `${what} should affect no rows, got ${describeResult(result)}`).toEqual([]);
}

/** A successful read that RLS filtered to nothing (HTTP 200 with an empty list). */
export function expectNoRows(what: string, result: ApiResultLike & { data: unknown[] | null }) {
  expect(result.error, `${what}: ${describeResult(result)}`).toBeNull();
  expect(result.data, `${what} should return no rows`).toEqual([]);
}
