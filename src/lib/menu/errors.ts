/**
 * Turns a database error into a message a cafe manager can act on. Raw database text is never
 * shown to the user (it can name tables, constraints and columns), and is never logged beyond the
 * SQLSTATE code.
 *
 * PostgREST returns the Postgres SQLSTATE in `code` and Postgres's own text in `message`.
 */

export interface DbErrorLike {
  code?: string | undefined;
  message?: string | undefined;
}

export type DbErrorKind =
  "duplicate" | "in_use" | "invalid" | "forbidden" | "not_found" | "unavailable" | "unknown";

export interface FriendlyError {
  kind: DbErrorKind;
  message: string;
  /** Form field the problem belongs to, when it is clear. */
  field?: string;
}

/** What the user was doing, so "already exists" can say what already exists. */
export type Subject =
  "category" | "item" | "modifier group" | "modifier option" | "table" | "attachment";

const article = (subject: Subject) => (subject === "item" || subject === "attachment" ? "An" : "A");

export function describeDbError(
  error: DbErrorLike,
  subject: Subject,
  action: "save" | "delete" = "save",
): FriendlyError {
  const code = error.code ?? "";
  const text = error.message ?? "";

  // 23505 unique_violation
  if (code === "23505") {
    if (/cafe_tables_code_unique/.test(text)) {
      return {
        kind: "duplicate",
        message: "A table with this code already exists.",
        field: "code",
      };
    }
    if (/slug_unique/.test(text)) {
      return {
        kind: "duplicate",
        message: `${article(subject)} ${subject} with a very similar name already exists.`,
        field: "name",
      };
    }
    return {
      kind: "duplicate",
      message:
        subject === "item"
          ? "An item with this name already exists in this category."
          : `${article(subject)} ${subject} with this name already exists.`,
      field: "name",
    };
  }

  // 23503 foreign_key_violation, 23001 restrict_violation (the menu-item delete guard)
  if (code === "23503" || code === "23001") {
    if (action === "delete") {
      switch (subject) {
        case "item":
          return {
            kind: "in_use",
            message:
              "This item has been ordered before, or is in an unpaid checkout, so it can't be deleted. Archive it instead.",
          };
        case "category":
          return {
            kind: "in_use",
            message:
              "This category still contains items. Move or delete them first, or archive the category.",
          };
        case "modifier group":
          return {
            kind: "in_use",
            message:
              "This group is still used by menu items. Remove it from them first, or archive it.",
          };
        default:
          return { kind: "in_use", message: `This ${subject} is in use and can't be deleted.` };
      }
    }
    return {
      kind: "invalid",
      message: "One of the selected items no longer exists. Refresh the page and try again.",
    };
  }

  // 23514 check_violation (a database limit the form check should already have caught)
  if (code === "23514") {
    return { kind: "invalid", message: "Some of the values are outside the allowed limits." };
  }
  if (code === "23502" || code === "22P02" || code === "22001" || code === "22003") {
    return {
      kind: "invalid",
      message: "Some of the values are not valid. Check the form and try again.",
    };
  }

  // 42501 insufficient_privilege (no grant, row-level security, or a guard trigger)
  if (code === "42501" || code === "PGRST301") {
    return {
      kind: "forbidden",
      message: "You don't have permission to do that.",
    };
  }

  // PGRST116: `.single()` found no row (deleted meanwhile, or hidden by row-level security)
  if (code === "PGRST116") {
    return {
      kind: "not_found",
      message: `That ${subject} wasn't found. It may have been deleted. Refresh the page.`,
    };
  }

  // Network and server problems
  if (/fetch failed|network|ECONNREFUSED|ETIMEDOUT/i.test(text) || /^5\d\d$/.test(code)) {
    return {
      kind: "unavailable",
      message: "We couldn't reach the database. Nothing was saved. Try again in a moment.",
    };
  }

  return { kind: "unknown", message: "Something went wrong. Nothing was saved. Try again." };
}
