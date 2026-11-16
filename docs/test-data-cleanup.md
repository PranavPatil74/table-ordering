# Leftover test data in the local database (`IT <tag>` categories, items and tables)

## What these records are

Categories named like `IT 0805fb Category` (each with **Grilled Sandwich ₹149** and **Cold Coffee ₹119**)
and tables named like `IT table 0805fb` (code `IT0805FB`) are created by the **real-Supabase integration
suite** (`pnpm test:supabase`), not by the Playwright browser tests. `src/supabase-it/harness.ts`
(`createWorld`) builds, for each test file that needs a menu, with one random 6-hex **tag**:

| Record         | Exact shape                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Category       | slug `it-<tag>-cat`, name `IT <tag> Category`                                                                                                                                         |
| Items          | `it-<tag>-sandwich` Grilled Sandwich 14900, `it-<tag>-coffee` Cold Coffee 11900, `it-<tag>-archived` Archived item 100 (inactive), `it-<tag>-soldout` Sold out item 100 (unavailable) |
| Table          | code `IT<TAG>` (upper case), label `IT table <tag>` (lower case), created active                                                                                                      |
| Modifier group | slug `it-<tag>-extras`, name `IT <tag> Extras`                                                                                                                                        |

It then places **paid orders at that table** for the two real items through `finalize_paid_order`.
The Playwright (`pnpm e2e`) data looks different (`Cat C87652`, `Club ...`, `Plain ...`) and lives in the
test double.

## Why they cannot be deleted

Intentional database guards (never weakened):

1. **Order history.** `order_items.menu_item_id` and `orders.table_id` are `ON DELETE RESTRICT`. An item
   or table that appears on any order (orders are immutable) can never be deleted. The app has no "delete
   table" at all: tables are deactivated.
2. **Unpaid checkout.** `payment_attempts.table_id` is `RESTRICT` too, and the `menu_items_guard_delete`
   trigger refuses to delete an item that a `PENDING` payment attempt contains.

The test harness could not delete these rows either, so it used to leave them behind **active**. It now
**deactivates/archives** everything it cannot delete (menu items, categories, tables, modifier groups) and
never touches history. A table left deactivated can no longer take orders (the customer lookup refuses
inactive tables); its orders keep pointing at it.

## 1. Look first (read-only)

Run the SQL in Supabase Studio's SQL editor, or run the preview of the tool below. Both only read, and both
show counts, never customer data:

- `scripts/test-menu-cleanup/diagnostic.sql`: menu fixtures and what references them.
- `scripts/test-menu-cleanup/diagnostic-tables.sql`: tables, whether each matches the fixture pattern, and
  its order history / unpaid checkouts / other payment attempts.

## 2. Preview, then clean up

Set the same variables as `pnpm test:supabase` (local stack only; the tool refuses anything that is not a
loopback address and never prints a key). PowerShell:

```powershell
$s = @{}
pnpm exec supabase status -o env | ForEach-Object {
  if ($_ -match '^([A-Z_]+)="?(.*?)"?$') { $s[$Matches[1]] = $Matches[2] }
}
$env:SUPABASE_URL = $s['API_URL']
$env:SUPABASE_SERVICE_ROLE_KEY = if ($s['SERVICE_ROLE_KEY']) { $s['SERVICE_ROLE_KEY'] } else { $s['SECRET_KEY'] }

pnpm cleanup:test-data                                # preview: changes nothing, prints a token
pnpm cleanup:test-data --apply --confirm <token>      # applies exactly that preview
```

`pnpm cleanup:test-menu` still works (alias, same flags). bash:
`eval "$(pnpm exec supabase status -o env | sed 's/^/export /')"; export SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-$SECRET_KEY}"`.

The preview lists, separately: confirmed test categories with each item's order history and unpaid-checkout
counts; **test tables** with name, code, active state, "fixture pattern: yes (code, label, same-run
category/group)", order history, unpaid checkouts, other payment attempts and the proposed action; and the
look-alikes that **will not be touched**, each with the reason.

### What the tool does

- **Archives** (`is_active = false`, the app's own "Archive") every fixture item and then its category, and
  **deactivates** (`is_active = false`, the app's own "Deactivate") every fixture table. Orders, order
  items, payment attempts and audit rows keep their references. This is the default.
- A table with a **`PENDING` payment attempt** (an unpaid checkout) is **skipped and reported**
  (`skip-unpaid-checkout`). `finalize_paid_order` does not read `cafe_tables.is_active`, so deactivation would
  not break a payment already in progress; it is skipped anyway so a customer mid-payment is never affected.
  Run again once the attempt is no longer `PENDING` (paid or failed).
- With `--delete-unreferenced` it also **deletes** fixture menu items that nothing references, and a category
  only when all its items were deleted. **Tables are never deleted.** Referenced records are never deleted.
- It **never writes** to `orders`, `order_items`, `payment_attempts`, `order_events` or any other table
  except `is_active` on `menu_items` / `menu_categories` / `cafe_tables` and DELETE of single unreferenced
  `menu_items` / `menu_categories` rows by id. Row counts of the four history tables are compared before and
  after, and the run fails if any changed.
- It uses the service-role key, so it bypasses row-level security; the database's own constraints and
  triggers still apply. To stay within the manager workflow instead, use **Archive** / **Deactivate** in the
  manager menu and tables pages.

### What counts as a test fixture (and what never does)

A **category** is touched only when its slug and name are the exact pair for one tag; every item in it is one
of the four items `createWorld` creates (slug, name **and** price equal); and the same run's test table or
modifier group exists and was created within 10 minutes of it.

A **table** is touched only when its code is `IT<TAG>`, its label is exactly `IT table <tag>` with the **same**
tag, and the same run's category `IT <tag> Category` or modifier group `it-<tag>-extras` exists and was created
within 10 minutes of the table. These are reported and left alone: a matching label with another code (the
manager test's `Z<TAG>` table), a matching code with another label, different tags, an upper-case tag in the
label, a perfect-looking table with no same-run category or group, real tables such as `T05`, and anything
that merely starts with `IT`.

### Confirmation

`--apply` needs `--confirm <token>`. The token is a hash of the exact steps in the preview (including each
table's action); if the data or the options changed since the preview, the tool stops and changes nothing.

## Future test runs

`Tracker.cleanup()` in the harness deletes what it created, newest first (the table last). Whatever the
database refuses to delete is deactivated/archived instead. Every row is attempted independently; a thrown
error (dropped connection) is treated like a refused delete; `cleanup()` never throws; and vitest runs the
`afterAll` that calls it even when `beforeAll` failed part-way. If even the deactivation fails, the tool above
finishes the job.

## What is and is not tested

- Planning rules, table identification, confirmation, CLI guards, harness error handling (scripted client):
  `src/test/test-menu-cleanup.test.ts`, `src/supabase-it/tracker.test.ts` (`pnpm test`).
- The same code against **real PostgreSQL 16** with this project's migrations, triggers, foreign keys and the
  real `finalize_paid_order`, with a fingerprint proving history is unchanged: `src/db/test-menu-cleanup.db.test.ts`,
  and the real `createWorld()` + `Tracker.cleanup()` after successful, failed and partially failed runs:
  `src/db/harness-cleanup.db.test.ts` (`pnpm test:db`).
- Not tested against a real Supabase stack: the PostgREST adapter itself (exercised only against a
  request-logging stand-in) and the harness over real PostgREST. Do the read-only preview first.
