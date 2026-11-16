# Sandwich Express

In-store, QR-based table ordering and order management for a single sandwich cafe.

Customers scan the QR code on their table, browse the menu, customise their food, pay online and
follow their order. Staff see verified, paid orders arrive on a counter dashboard in real time and
move them through preparation. **Dine-in only. This is not a delivery platform.**

## Status

| Phase | Scope                                                                          | State                                                                                  |
| ----- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 0     | Foundation: tooling, design tokens, env validation, tests, CI, Supabase config | **Done**                                                                               |
| 1     | Database schema, constraints, RLS, seed data                                   | **Done**                                                                               |
| 2     | Staff authentication (sign-in, protected `/staff`, roles from the database)    | **Done**, see [verification](docs/staff-auth.md#testing)                               |
| 3     | Manager area: menu and modifier management, tables, QR codes                   | **Done**, see [guide](docs/menu-and-tables.md)                                         |
| 4     | Customer QR ordering (menu, cart, checkout preparation) and staff management   | **Done**, see [ordering](docs/customer-ordering.md), [staff](docs/staff-management.md) |
| 5     | Persistent checkout snapshot and payment-attempt creation (no payment yet)     | **Done**, see [checkout attempts](docs/checkout-attempts.md)                           |
| 6     | Razorpay order, payment verification, webhooks and order finalisation          | Not started                                                                            |
| 7     | Live order board and customer tracking                                         | Not started                                                                            |
| 8     | History, search, statistics, cancellation and refunds                          | Not started                                                                            |
| 9     | Hardening, full end-to-end tests, deployment docs                              | Not started                                                                            |

Today the app serves a static explainer home page, a `/api/health` liveness endpoint, staff
sign-in (`/staff/login`) leading to a protected `/staff` landing page, and, for managers, the
menu, modifier, table, QR-code and staff tools under `/staff/manager`
([`docs/menu-and-tables.md`](docs/menu-and-tables.md), [`docs/staff-management.md`](docs/staff-management.md)).
Customers can scan a table's QR code to browse the live menu, customise items, fill a cart and reach a
server-verified checkout that is saved as a pending payment attempt
([`docs/customer-ordering.md`](docs/customer-ordering.md), [`docs/checkout-attempts.md`](docs/checkout-attempts.md));
**there is no payment, order creation or order board yet**, and checkout says so (it never shows
"order confirmed" for a saved checkout). Staff authentication is described in
[`docs/staff-auth.md`](docs/staff-auth.md). The database layer (schema, security
policies, the payment-finalisation function, seed data) exists and is documented in
[`docs/database.md`](docs/database.md), including exactly what has and has not been tested.

## Requirements

- Node.js 22.12 or newer (`.nvmrc` pins 22)
- pnpm 10 (`corepack enable` will pick the version from `package.json`)
- Docker (optional, only for running Supabase locally; see [Database setup](#database-setup))

## Quick start

```bash
pnpm install                   # installs exactly what pnpm-lock.yaml pins
cp .env.example .env.local     # then edit .env.local (see below)
pnpm db:start                  # local Supabase (needs Docker); prints the local URL and keys
pnpm db:reset                  # applies supabase/migrations and the seed data
pnpm dev                       # http://localhost:3000
```

**Environment variables.** Edit `.env.local` (it is git-ignored; never commit it or paste its values
anywhere). For local development set `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from the output of
`pnpm db:status`, and leave `NEXT_PUBLIC_APP_URL=http://localhost:3000` (and `APP_BASE_URL` blank: table QR codes then
use it). Razorpay variables stay empty until payments arrive. Staff pages need a running
Supabase and a manager account: see [`docs/menu-and-tables.md`](docs/menu-and-tables.md#getting-in).
Only the static home page and `/api/health` work without Supabase. In production
set `APP_BASE_URL` (and `NEXT_PUBLIC_APP_URL`) to your public `https://` origin, or QR export is refused.

## Scripts

| Command                  | What it does                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`               | Start the dev server                                                                                                                                                                          |
| `pnpm build`             | Production build (needs no secrets)                                                                                                                                                           |
| `pnpm start`             | Serve the production build (validates environment at startup)                                                                                                                                 |
| `pnpm lint`              | ESLint                                                                                                                                                                                        |
| `pnpm typecheck`         | Generate route types, then strict `tsc --noEmit`                                                                                                                                              |
| `pnpm format`            | Format with Prettier (`format:check` verifies without writing)                                                                                                                                |
| `pnpm test`              | Unit and component tests (Vitest); also `test:watch`, `test:coverage`                                                                                                                         |
| `pnpm e2e`               | **Whole** browser-test workflow: isolated build, configuration check, then Playwright (test double of Supabase)                                                                               |
| `pnpm e2e:build`         | Only the isolated E2E build (into `.next-e2e`)                                                                                                                                                |
| `pnpm e2e:install`       | Download the Playwright Chromium browser                                                                                                                                                      |
| `pnpm test:db`           | Database tests on a real PostgreSQL (see `docs/database.md`)                                                                                                                                  |
| `pnpm test:supabase`     | API tests against a running local Supabase stack (Auth, PostgREST, Realtime)                                                                                                                  |
| `pnpm cleanup:test-data` | Preview (and, with confirmation, archive/deactivate) the menu items, categories and tables `test:supabase` left in your local DB. Alias: `cleanup:test-menu`. See `docs/test-data-cleanup.md` |
| `pnpm verify`            | lint + typecheck + format check + tests + build                                                                                                                                               |
| `pnpm db:*`              | Supabase CLI shortcuts: `start`, `stop`, `status`, `reset`, `push`                                                                                                                            |

`pnpm e2e` is one command that does everything in the right order (you do **not** run `pnpm build`
first): it builds the production app into `.next-e2e` using only the clearly-fake fixture environment
in `e2e/env.mjs`, checks that the build is wired to the test double, then runs Playwright. Extra
arguments go to Playwright (`pnpm e2e --project=desktop e2e/manager.spec.ts`), and
`pnpm e2e --skip-build` reuses the last E2E build.

**Why E2E has its own build.** Next.js copies every `NEXT_PUBLIC_*` value into the compiled code during
`pnpm build`, and `pnpm start` cannot change them afterwards. A `.env.local` (or PowerShell session)
that points at your real local Supabase (`127.0.0.1:54321`) would therefore make the build read that
database while the tests seed the test double on `127.0.0.1:54399`: menus look empty and staff sign-in
never succeeds. The E2E build and servers ignore your shell and every `.env*` file (the values are
blanked), never replace your normal `.next`, and never touch a real database. Run the tests against your
real local Supabase with `pnpm test:db` / `pnpm test:supabase` instead (see `docs/database.md`).
If the configuration check fails, it says which backend the app used and what to do; it prints only
host and port, never keys.

If your machine already has a Chromium that does not match Playwright's expected version, point at
it instead of downloading: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome pnpm e2e`.

## Environment variables

Copy `.env.example` to `.env.local`. The app validates configuration when the server starts and
prints a readable list of problems (variable names only, never values). In production it also
rejects any value still set to an `.env.example` placeholder.

| Variable                               | Exposure   | Purpose                                                                                                   |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                  | Public     | This site's own origin (cookie `Secure` flag). Frozen into the build. Required and `https` in production. |
| `APP_BASE_URL`                         | Server     | Origin table QR codes point to. Read at **runtime**. Blank = use `NEXT_PUBLIC_APP_URL`.                   |
| `NEXT_PUBLIC_SUPABASE_URL`             | Public     | Supabase API URL (`http://127.0.0.1:54321` locally).                                                      |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public     | Supabase publishable (anon) key. Safe for browsers; access is controlled by RLS.                          |
| `SUPABASE_SERVICE_ROLE_KEY`            | **Secret** | Bypasses RLS. Server code only (payment finalisation, admin tasks).                                       |
| `RAZORPAY_KEY_ID`                      | **Secret** | `rzp_test_...` while testing. Set all three Razorpay values, or none.                                     |
| `RAZORPAY_KEY_SECRET`                  | **Secret** | Shown once when the key is generated.                                                                     |
| `RAZORPAY_WEBHOOK_SECRET`              | **Secret** | A secret you choose when creating the webhook in the Razorpay Dashboard.                                  |

Rules: only `NEXT_PUBLIC_*` values may reach the browser; secrets are read only through
`src/lib/env/server.ts`, which imports `server-only` so a client import fails the build. Never
paste secret values into chat, issues or screenshots. Leaving the Razorpay values blank is valid:
the app then reports that payments are not configured instead of pretending to take money.

## Database setup

Migrations live in `supabase/migrations/` and the sample seed in `supabase/seed.sql`. The full
guide (schema, security model, inspecting the database, running the DB tests) is
[`docs/database.md`](docs/database.md).

**Option A: local Supabase (recommended when Docker is available).** Needs Docker running.

```bash
pnpm db:start     # first run downloads images; prints local URLs and keys
pnpm db:status    # shows the API URL, publishable key and service role / secret key
pnpm db:reset     # replays migrations, then supabase/seed.sql
```

Put the printed values in `.env.local`. The local stack is configured in `supabase/config.toml`.

**Option B: no Docker. Use a hosted Supabase development project.** Create a free project in the
Supabase dashboard, then:

```bash
pnpm exec supabase login
pnpm exec supabase link --project-ref <your-dev-project-ref>
pnpm db:push      # applies supabase/migrations to the hosted project
```

Put the project URL and keys from the dashboard (Project Settings, API) in `.env.local`. Use a
separate project from production. Migrations are plain SQL under `supabase/migrations/`, so they
apply identically to local and hosted databases.

Auth is configured **staff-only**: public sign-up is disabled, the minimum password length is 12.
When you create the hosted project, also turn off "Allow new users to sign up" under
Authentication settings so it matches `supabase/config.toml`.

## Project layout

```
src/app/                  Next.js App Router (pages, route handlers, global styles/tokens)
src/components/ui/        Design-system primitives (Button, Badge, Card)
src/components/brand/     Logo mark
src/lib/env/              Environment contract: schema.ts (pure), public.ts, server.ts (server-only)
src/lib/money.ts          Integer-paise helpers
src/lib/auth/             Staff access rules (pure), login validation, server-side guards
src/lib/supabase/         Cookie-based Supabase server client and proxy session refresh
src/proxy.ts              Session refresh and early redirect for /staff (Next.js 16 "proxy")
src/app/staff/            Sign-in page, protected staff area, sign-in and sign-out Server Actions
src/app/api/staff/        Staff API routes (each guarded on the server), incl. the QR download
src/app/staff/(protected)/manager/  Manager pages and Server Actions (menu, modifiers, tables)
src/components/admin/     Admin form, confirm dialog, feedback and navigation components
src/lib/menu/             Menu validation (zod), repository, error mapping, ordering helpers
src/lib/tables/           Table code rules, QR URL/SVG/PNG generation and export policy
src/lib/orders/           Order and payment status machines, order-number format (mirror the DB)
src/lib/security/         Tracking-token generation and hashing (server-only)
src/db/                   Database tests (*.db.test.ts need PostgreSQL) and static migration checks
src/supabase-it/          Supabase API tests (need `supabase start`): Auth, PostgREST, Realtime
src/test/db/              DB test harness: temporary PostgreSQL, Supabase shim, fixtures
src/instrumentation.ts    Validates configuration when the server starts
e2e/                      Playwright tests, fixture environment and fake-supabase.mjs (TEST DOUBLE)
supabase/                 config.toml, migrations/, seed.sql
docs/database.md          Schema, security model, how to apply and test the database
docs/staff-auth.md        Staff sign-in, sessions, roles, creating the first manager
docs/menu-and-tables.md   Manager area: menu, modifiers, tables, QR codes, image-storage decision
docs/customer-ordering.md Customer QR flow: menu, cart, checkout preparation, what the server decides
docs/staff-management.md  Manager staff directory, activate/deactivate, safeguards, adding staff securely
docs/launch-checklist.md  Decisions the cafe owner must confirm before launch
```

## Architecture decisions

- **Money is integer paise everywhere.** Never floats; the gateway amount must match exactly.
- **Cache Components and partial prefetching are off.** The scaffold enabled them, but this app is
  request-dynamic almost everywhere (session cookies, live orders), and enabling them would force
  Suspense boundaries around every cookie read for no real benefit.
- **Configuration is validated lazily and at server start, not at build time**, so CI builds without
  secrets while a misconfigured deployment still fails immediately and loudly.
- **TypeScript is pinned to 6.0.x** because `typescript-eslint` does not yet support TypeScript
  6.1 or 7. **ESLint is on 9.x** because `eslint-config-next`'s bundled plugins (react, import,
  jsx-a11y) do not yet declare ESLint 10 support; npm marks 9.x as unsupported, so revisit when
  they do.
- **Fonts are self-hosted** (`@fontsource-variable`: Fraunces and Instrument Sans): no third-party
  font requests, and builds work offline.
- **UI components are hand-written in shadcn/ui conventions** (Radix primitives, Tailwind, `cva`).
  The sandbox this was built in could not reach `ui.shadcn.com`, so `components.json` and the three
  components were authored by hand rather than fetched by the CLI. On a normal machine, check the
  setup with `pnpm dlx shadcn@latest add input` and diff the results; adjust `components.json` if
  the CLI asks for different fields.
- **Light theme only** for v1, by design (cream and forest green brand).
- **Design tokens are enforced.** `src/styles/tokens.test.ts` parses `globals.css` and fails if any
  text pair drops below WCAG AA 4.5:1 or a form boundary below 3:1.
- **A Content-Security-Policy is deferred to Phase 9.** Razorpay Checkout and Supabase websockets
  need tested allow-lists; a wrong CSP would silently break payments. Other baseline security
  headers are already set in `next.config.ts`.

## Verifying Phase 0 locally

```bash
pnpm install
pnpm verify                      # lint, typecheck, format check, unit tests, build
pnpm e2e:install && pnpm e2e     # browser tests (builds its own isolated copy first)
```

Then run `pnpm dev` and open http://localhost:3000 (home page) and
http://localhost:3000/api/health (`{"status":"ok"}`).

## Windows (PowerShell): setup, run and test

Install Node.js 22 (LTS), then once: `corepack enable` (run PowerShell as administrator if it
complains about permissions) and Docker Desktop if you want the Supabase tests.

```powershell
cd path\to\sandwich-express
pnpm install
Copy-Item .env.example .env.local           # then fill in the local Supabase values below
pnpm db:start                                # first run downloads images
pnpm db:reset                                # applies migrations and the sample menu
pnpm db:status                               # prints the API URL and the publishable / secret keys
```

Put `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the "Publishable" or "anon"
key) and `SUPABASE_SERVICE_ROLE_KEY` (the "Secret" or "service_role" key) from `pnpm db:status`
into `.env.local`. They are local development keys; never paste them into chat or commit them.
Phase 2 only uses the first two.

**Try it yourself.** Create the first manager (see
[`docs/staff-auth.md`](docs/staff-auth.md#creating-the-first-manager-administrator-procedure)),
then:

```powershell
pnpm dev                                     # http://localhost:3000/staff/login
```

Sign in, confirm `/staff` shows your name and role, press **Sign out**, and confirm `/staff` sends
you back to the sign-in page. This is the one check that runs the cookie layer against a real
Supabase stack.

**Run every check.** One at a time, in this order:

```powershell
pnpm lint; pnpm typecheck; pnpm format:check
pnpm test                                    # unit, component and static tests
pnpm build
pnpm e2e:install                             # once: downloads Chromium
pnpm e2e                                     # browser tests: builds into .next-e2e itself, ignores .env.local
pnpm test:db                                 # needs PostgreSQL 16+ binaries or TEST_DATABASE_URL
```

**Real Supabase tests** (stack running and reset, as above). If the stack was started before you
pulled Phase 2, restart it once (`pnpm db:stop; pnpm db:start`) so the raised local sign-in limit
applies:

```powershell
$s = @{}
pnpm exec supabase status -o env | ForEach-Object {
  if ($_ -match '^([A-Z_]+)="?(.*?)"?$') { $s[$Matches[1]] = $Matches[2] }
}
$env:SUPABASE_URL = $s['API_URL']
$env:SUPABASE_ANON_KEY = if ($s['ANON_KEY']) { $s['ANON_KEY'] } else { $s['PUBLISHABLE_KEY'] }
$env:SUPABASE_SERVICE_ROLE_KEY = if ($s['SERVICE_ROLE_KEY']) { $s['SERVICE_ROLE_KEY'] } else { $s['SECRET_KEY'] }
$env:SUPABASE_DB_URL = $s['DB_URL']
pnpm test:supabase
```

If `pnpm e2e` cannot start because port 3100, 3101 or 54399 is busy, close whatever uses it; the tests use
their own fake auth server on 54399, never your real stack on 54321.

## Not done yet (by design)

Everything in phases 6 to 9 above, plus item image upload (see `docs/menu-and-tables.md`). The database tests run on plain PostgreSQL 16 with a small
test-only Supabase shim. The Supabase API tests (`pnpm test:supabase`) passed for the project owner
on a real local stack before Phase 2 (65 tests); the Phase 2 `staff-guard` tests and the Phase 3 `manager-admin` tests have not yet
been run on a real stack by me, and the browser sign-in flow has only been tested against a test double
of Supabase's auth endpoints. Nothing has been tested against Razorpay yet (details in
`docs/database.md` and `docs/staff-auth.md`). See `docs/launch-checklist.md` for the non-software decisions
the cafe owner needs to make before launch.
