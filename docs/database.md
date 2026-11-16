# Database guide

PostgreSQL schema, security model, seed data and tests for Sandwich Express. Migrations are plain
SQL in `supabase/migrations/` and apply the same way to local Supabase, a hosted Supabase project
and plain PostgreSQL.

## What was verified, and what was not

| Claim                                                                                    | Status                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All migrations apply cleanly in order on PostgreSQL 16                                   | Verified (every DB test run builds a database from them)                                                                                                                         |
| Constraints, triggers, `finalize_paid_order`, order numbers, concurrency                 | Verified by DB tests on PostgreSQL 16                                                                                                                                            |
| Grants and RLS behave as designed for `anon`, signed-in users, counter, manager, service | Verified by DB tests on PostgreSQL 16                                                                                                                                            |
| Seed applies, is repeatable and does not overwrite manager edits                         | Verified by DB tests on PostgreSQL 16                                                                                                                                            |
| Migrations apply on the **real Supabase stack** (`supabase start` / `supabase db reset`) | **Indirect evidence, user-reported.** The suite's readiness probe saw the migrated schema; the `supabase-replay` CI job has never run                                            |
| `orders` is added to the `supabase_realtime` publication                                 | **Partly verified, user-reported.** Realtime delivery of `orders` changes worked; the catalog test (needs `SUPABASE_DB_URL`) was skipped                                         |
| Behaviour through **PostgREST** (column privileges + RLS over the HTTP API)              | **Run by the project owner, not the author:** 63 passed, 1 failed, 1 skipped. The failure was a test defect, since fixed; the fixed test has **not** been re-run on a real stack |
| Supabase **Auth**: real users, JWTs, `auth.uid()` reaching RLS and triggers              | **Run by the project owner:** all 10 `auth-identity` tests passed                                                                                                                |
| Realtime delivery of `orders` changes to a staff browser (and not to anon)               | **Run by the project owner:** both delivery tests passed                                                                                                                         |
| Phase 2 staff check against real Auth and PostgREST (`staff-guard` tests)                | **Written, not yet run on a real stack.** Needs `pnpm test:supabase`; the 65 earlier tests passed for the project owner                                                          |
| Phase 2 sign-in flow in a browser (cookies, proxy, redirects, Server Actions)            | **Run against a test double of Supabase only** (`pnpm e2e`); never against a real stack                                                                                          |
| The GitHub Actions jobs (`database` on PG 16 and 17, `supabase-replay`)                  | **Never run on GitHub.** PG 17 has not been run anywhere                                                                                                                         |

The DB tests run on a throwaway PostgreSQL 16 with `src/test/db/supabase-shim.sql`. That file
(test-only, never a migration) creates the roles Supabase provides (`anon`, `authenticated`,
`service_role`), a minimal `auth.users`, and `auth.uid()` / `auth.role()` reading the
`request.jwt.claims` setting, which is how Supabase's own functions work. It does not replace Auth,
PostgREST, Realtime or Storage. Treat these tests as strong evidence about the SQL and policies,
and the `supabase-replay` job (or the manual steps below) as the check on the Supabase stack.

## Supabase API integration tests (`pnpm test:supabase`)

Separate from the plain-PostgreSQL tests, `src/supabase-it/*.supabase.test.ts` talk to a **real local
Supabase stack over HTTP** with `@supabase/supabase-js`: real Auth users and JWTs, PostgREST, and
Realtime. They cover:

| File                | What it proves                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-identity`     | Admin-created users sign in; the JWT `sub` maps to `staff_profiles`; role/active changes apply on the next request; forged tokens get 401; public sign-up is off; profile FK and cascade                          |
| `public-access`     | Anon reads the public menu and named settings columns only; every private table, write and privileged function is refused                                                                                         |
| `staff-permissions` | Counter and manager matrix through PostgREST; audit events carry the real `auth.uid()`; cancel is manager-only; payment status and totals are untouchable                                                         |
| `functions`         | `finalize_paid_order`, `check_rate_limit`, `purge_expired_rate_limits` are refused to anon, non-staff, counter and manager, and work (idempotently) for the service role                                          |
| `staff-guard`       | Phase 2: the app's own staff check (`loadStaffAccess`) against real Auth and PostgREST: roles from the profile, inactive and no-profile denial, metadata ignored, forged and signed-out tokens, live role changes |
| `realtime`          | `supabase_realtime` contains exactly `public.orders`; a staff browser receives an order update; anon and non-staff users do not                                                                                   |

**Status.** The author could not start the stack (image registries were blocked), so the real-stack
results come from the project owner's own run on Windows against `supabase start`, not from an
environment the author controlled:

- First run: 63 passed, 1 failed, 1 skipped (five files).
- The failure, `counter: the menu > cannot create menu rows, tables or settings`, was a **test
  defect**: its check searched the fixture slugs with `LIKE 'it-<tag>-c%'`, which also matches the
  test's own `it-<tag>-coffee` fixture. The counter's inserts were refused and no counter row
  existed. The test now gives the attempted rows a unique `denied` marker, reads each table back by
  exact key, and checks the fixture category's item count and the settings ids are unchanged. It
  has **not been re-run on a real stack since the fix**.
- The skipped test is the `supabase_realtime` catalog check. It needs `SUPABASE_DB_URL` and is
  skipped without it (the run prints a warning, and the test title says so). CI makes the variable
  mandatory.

Running it locally (needs Docker with working image pulls). `supabase status -o env` prints the
connection details; set them as environment variables for the test run only.

PowerShell (Windows):

```powershell
pnpm db:start
pnpm db:reset
$s = @{}
pnpm exec supabase status -o env | ForEach-Object {
  if ($_ -match '^([A-Z_]+)="?(.*?)"?$') { $s[$Matches[1]] = $Matches[2] }
}
$env:SUPABASE_URL = $s['API_URL']
$env:SUPABASE_ANON_KEY = if ($s['ANON_KEY']) { $s['ANON_KEY'] } else { $s['PUBLISHABLE_KEY'] }
$env:SUPABASE_SERVICE_ROLE_KEY = if ($s['SERVICE_ROLE_KEY']) { $s['SERVICE_ROLE_KEY'] } else { $s['SECRET_KEY'] }
$env:SUPABASE_DB_URL = $s['DB_URL']      # needed for the supabase_realtime catalog test
pnpm test:supabase
```

bash (macOS, Linux, Git Bash):

```bash
pnpm db:start && pnpm db:reset
eval "$(pnpm exec supabase status -o env | sed 's/^/export /')"     # sets API_URL, ANON_KEY, ...
SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="${ANON_KEY:-$PUBLISHABLE_KEY}" \
  SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-$SECRET_KEY}" SUPABASE_DB_URL="$DB_URL" \
  pnpm test:supabase
```

Without `SUPABASE_DB_URL`, one test is reported as skipped; everything else still runs.

(`supabase status` prints the **local development** keys; do not paste them into chat or commit them.)

Safety properties:

- **Local only.** The suite refuses any `SUPABASE_URL` that is not a loopback address, and any
  non-loopback `SUPABASE_DB_URL`. It can never be pointed at a hosted or production project.
- **Missing configuration is a failure**, not a skip. Only `ALLOW_SUPABASE_TESTS_SKIP=1` skips, and
  it says loudly that nothing was verified.
- **Disposable, tagged data.** Every user, menu row and table carries a per-run random tag.
  Cleanup deletes only the ids that run created, never by pattern. Some rows cannot be deleted by
  design (orders are immutable; ordered menu items and tables are protected; the last active
  manager cannot be removed), so they stay behind until `pnpm db:reset`. Leftover menu items,
  categories, tables and modifier groups are archived/deactivated (`is_active = false`) so they stay out of the
  manager dashboard and the customer menu, and `pnpm cleanup:test-data` previews and clears them
  without a reset (see `docs/test-data-cleanup.md`).
- **Rate limit.** One run makes about 22 Auth sign-ins per IP. The local GoTrue limit is now 100
  per 5 minutes (`[auth.rate_limit]` in `supabase/config.toml`, raised from the default 30). Restart
  the stack (`pnpm db:stop && pnpm db:start`) for the change to apply; until then, run the suite at
  most once every five minutes.
- **No secrets in logs.** Failure messages carry SQLSTATE, HTTP status and a short message only.
  In CI the keys are masked (`::add-mask::`) before they are exported, and a static test
  (`src/test/ci-workflow.test.ts`) guards the workflow against printing them.

## Applying the migrations

**Local Supabase (needs Docker):**

```bash
pnpm db:start     # starts the stack
pnpm db:reset     # drops the local DB, applies every migration, then supabase/seed.sql
pnpm db:status    # API URL, keys and the Postgres URL (port 54322)
```

**Hosted Supabase development project (no Docker):**

```bash
pnpm exec supabase login
pnpm exec supabase link --project-ref <your-dev-project-ref>
pnpm db:push      # applies supabase/migrations
```

Then apply the sample menu **only to a development project**:
`psql "<dev database URL>" -f supabase/seed.sql`, or paste it into the SQL editor. Use a project
that is separate from production. Never paste database passwords or keys into chat or commit them.

**Plain PostgreSQL** (tested on 16): the migrations reference the Supabase roles, `auth.users`,
`auth.uid()` and `auth.role()`, so create them first, for example by applying
`src/test/db/supabase-shim.sql`, then apply the migration files in filename order with
`psql -v ON_ERROR_STOP=1 -f <file>`.

### Creating the first manager

Nobody can create staff profiles through the API (that is deliberate). An administrator creates
the user in Supabase Auth and then inserts the profile as the `postgres` role. The step-by-step
procedure, including a Windows PowerShell command for the local stack, is in
[`docs/staff-auth.md`](staff-auth.md#creating-the-first-manager-administrator-procedure). In short:

```sql
insert into public.staff_profiles (user_id, display_name, role)
values ('<auth user uuid>', 'Your name', 'manager');
```

Managers can then change the role and active state of other profiles. Counter staff accounts are
created the same way with `role = 'counter'`. The staff sign-in screen (Phase 2) is described in
[`docs/staff-auth.md`](staff-auth.md).

## Running the database tests

```bash
pnpm test:db
```

- With PostgreSQL server binaries installed locally (`initdb`, `pg_ctl`; found via `PG_BIN_DIR`,
  `pg_config` or `/usr/lib/postgresql/*/bin`; only 16 has been tried), the harness starts a temporary
  cluster, runs the tests and removes it. No other setup.
- To use an existing server, including a **separate development Supabase project's database**, set
  `TEST_DATABASE_URL` to a **superuser** connection string:
  `TEST_DATABASE_URL=postgresql://postgres:<password>@<host>:5432/postgres pnpm test:db`.
  The harness creates and drops its own `sbx_*` databases on that server (it only connects to the
  database named in the URL to do so). **Do not point it at production**, or at anything you
  cannot afford to have extra databases created in. It needs permission to create databases, so a
  hosted Supabase project may refuse; local Supabase's Postgres (port 54322) or a plain server are
  the safer targets. Only the plain-server case was run (PostgreSQL 16.15, started separately and
  reached through `TEST_DATABASE_URL`: same results as the temporary cluster). Local Supabase and
  hosted projects were not tried.
- No server found: the run fails with a clear error. `ALLOW_DB_TESTS_SKIP=1 pnpm test:db` skips
  explicitly (it never skips silently).

`pnpm test` runs only the tests that need no database, including `src/db/migrations-static.test.ts`,
which lints the SQL text (RLS enabled on every table, a pinned `search_path` on every function,
no money columns other than integer paise, no secrets).

## Inspecting the database

```bash
psql "$DATABASE_URL" -c '\dt public.*'
psql "$DATABASE_URL" -c '\d+ public.orders'      # columns, constraints, triggers
psql "$DATABASE_URL" -c '\df+ public.*'          # functions
psql "$DATABASE_URL" -c '\dp public.*'           # table and column grants
psql "$DATABASE_URL" -c 'select * from pg_policies where schemaname = $$public$$ order by tablename, policyname'
```

Locally, `DATABASE_URL` is `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. The Supabase
Studio table editor and SQL editor also work (`pnpm db:status` prints the Studio URL).

## Schema overview

| Area       | Tables                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Staff      | `staff_profiles` (role `manager` or `counter`, `is_active`)                                         |
| Settings   | `cafe_settings` (one row: name, `orders_enabled`, limits, time zone, order prefix)                  |
| Tables     | `cafe_tables` (`code` is the QR identifier, unique, format `T05`)                                   |
| Menu       | `menu_categories`, `menu_items`, `modifier_groups`, `modifier_options`, `menu_item_modifier_groups` |
| Payment    | `payment_attempts` (pending checkouts, immutable cart snapshot), `gateway_events`                   |
| Orders     | `orders`, `order_items` (immutable snapshots), `order_events` (append-only audit)                   |
| Supporting | `order_counters` (daily order numbers), `rate_limits`                                               |

Rules worth knowing:

- **Money is integer paise** (`integer` columns named `*_paise`, with range checks). No float,
  numeric or money columns exist; two tests enforce that.
- **Menu edits never change history.** `order_items` copies the item name, option names, quantity
  and prices at the time of the order and is immutable. Menu items and tables that appear in orders
  cannot be deleted (archive with `is_active = false`).
- **An order exists only once it is paid.** Checkout creates a `payment_attempts` row; the trusted
  backend calls `public.finalize_paid_order(attempt_id, gateway_payment_id)` **after verifying the
  payment with Razorpay**. The function does not verify payments itself. It locks the attempt row,
  is idempotent (replays return the existing order), and unique constraints stop a second order or
  a reused gateway payment id.
- **Order numbers** look like `SE-007`, restart daily in the cafe's time zone (Asia/Kolkata by
  default), are gapless on rollback, unique per business date, and are safe under concurrency.
- **Tracking tokens**: the server generates a random token, returns it to the customer once, and
  stores only its SHA-256 hash.
- **Statuses** are separate: order `NEW, ACCEPTED, PREPARING, READY, SERVED, CANCELLED`; payment
  `PENDING, PAID, FAILED` on attempts and `PAID, REFUND_PENDING, REFUNDED` on orders. Transitions
  are enforced by triggers. Only the trusted backend can change payment status, and `REFUNDED` is
  only for after the provider has confirmed the refund.
- **The cafe cannot be left without an active manager**; concurrent demotions are serialised.

## Security model

| Actor                        | Can                                                                                                       | Cannot                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `anon` (customer browser)    | Read active menu rows and a few cafe settings (named columns only)                                        | Read or write orders, payments, staff, tables, counters; call any function                    |
| Signed in, no staff profile  | Same as anon                                                                                              | Anything staff-only                                                                           |
| Counter                      | Read orders, items, audit events, tables, payment references; advance order status; toggle `is_available` | Cancel; change prices, names, tables, settings, profiles; read cart snapshots or token hashes |
| Manager                      | Everything counter can; cancel with a reason; edit menu, tables, settings, staff role/active              | Change payment status or order totals; delete orders; read cart snapshots or token hashes     |
| `service_role` (server only) | Everything, including `finalize_paid_order`, payment status changes, backend-only tables                  | Must never reach a browser                                                                    |

How it is enforced:

- Row Level Security is on for all 15 public tables; default API privileges are revoked, then
  re-granted explicitly, often per column.
- Customers do not call the database for orders. Checkout, tracking and payment go through
  validated server endpoints (later phases) that use the service role.
- `SECURITY DEFINER` functions all pin `search_path = ''`, use schema-qualified names, and have
  `EXECUTE` revoked from `PUBLIC`, `anon` and `authenticated` unless listed in the migration.
  Public-schema RPCs are `finalize_paid_order`, `check_rate_limit`, `purge_expired_rate_limits` and (Phase 5) `create_checkout_attempt` and `get_checkout_attempt`,
  all `service_role` only. Helpers live in the `private` schema, which the API does not expose.
- Role helpers: `private.current_staff_role()`, `is_staff()`, `is_manager()`,
  `is_trusted_backend()`.

### Rules for client code reading the database

- **Name the columns you select.** Anon has column-level `SELECT` only. For example
  `select * from cafe_settings` is denied to anon; select `cafe_name, orders_enabled, ...`.
  The same applies to `payment_attempts` for staff, where `cart_snapshot`, `idempotency_key` and
  `tracking_token_hash` are not readable.
- Customer-facing queries must still be sent from the server where they involve orders.
- The service-role key must stay on the server (`SUPABASE_SERVICE_ROLE_KEY`, read only through
  `src/lib/env/server.ts`).

## Known limits and open points

- Column-level privileges together with Realtime and PostgREST filters have not been exercised;
  Phase 7 must test subscription behaviour for staff clients before relying on it.
- The `supabase_realtime` publication migration is guarded so it is harmless on plain PostgreSQL,
  which also means it was not exercised here.
- Sample prices in `seed.sql` are placeholders. The owner sets real prices, and confirms tax
  treatment, in line with `docs/launch-checklist.md`.

## Phase 3 note

Phase 3 added **no migrations**. The manager area writes through the signed-in manager's own session,
so the Phase 1 policies, grants and triggers are what enforce permissions. The Phase 3 database test is
`src/db/manager-errors.db.test.ts` (plain PostgreSQL) and the real-stack test is
`src/supabase-it/manager-admin.supabase.test.ts`. Anonymous visitors cannot read `cafe_tables`; the
customer menu (Phase 4) resolves a table code on the server with the service role, rate limited
(see [`customer-ordering.md`](customer-ordering.md)).

Phase 4 also added **no migrations**. Its database tests are `src/db/customer-ordering.db.test.ts`
(plain PostgreSQL: what `anon` can read, the cart snapshot against `cart_snapshot_problem`, and the
staff-management rules including the concurrent last-manager guard) and
`src/supabase-it/customer-staff.supabase.test.ts` (real stack; not run by the author of Phase 4). See
[`staff-management.md`](staff-management.md).
