# Menu and table management (Phase 3)

The manager area lets the cafe manager maintain the menu and the tables, and produce a QR code for
each table. It sits under `/staff/manager` and is only for people whose **database** profile says
`role = 'manager'` and `is_active = true`.

## Getting in

1. **Create the first manager** (a one-time administrator task, unchanged from Phase 2). Follow
   [`staff-auth.md`](staff-auth.md#creating-the-first-manager-administrator-procedure): create an
   Auth user in Supabase Studio, then insert a `staff_profiles` row with `role = 'manager'`.
2. Start the app (`pnpm dev`) and open <http://localhost:3000/staff/login>. Sign in with that
   email and password.
3. On the staff home page a manager sees a **Manager tools** card. The new pages are:

   | Page                        | Address                          |
   | --------------------------- | -------------------------------- |
   | Overview                    | `/staff/manager`                 |
   | Menu management             | `/staff/manager/menu`            |
   | Categories                  | `/staff/manager/menu/categories` |
   | Modifier groups and options | `/staff/manager/menu/modifiers`  |
   | Cafe tables and QR codes    | `/staff/manager/tables`          |
   | Printable QR sheet          | `/staff/manager/tables/print`    |

A **counter** account gets a plain 404 for all of these (the section does not reveal that it
exists), and a signed-out visitor is sent to the sign-in page. Counter staff keep the one menu power
Phase 1 gave them: marking items and options sold out and available again (that screen arrives
with the order board).

## What a manager can do

**Categories.** Add, rename, describe, reorder, archive (hides the category and its items from
customers) and restore. A category can only be deleted when it is empty.

**Items.** Name, category, description, ingredients, dietary tags (a fixed list), price, "show on
the menu" and "available today". Reorder within a category, mark sold out, archive/restore and
delete. An item that has ever been ordered (or sits in an unpaid checkout) cannot be deleted: the
database refuses and the screen says to archive it instead. Archiving keeps order history intact.

**Prices are typed in rupees and stored as integer paise.** `249.50` becomes `24950`. Up to two
decimals, no commas or exponents. Limits: items up to ₹1,00,000; option extras up to ₹10,000 (the
same limits the database enforces). There is no tax line; menu prices are the amounts charged.

**Modifier groups and options.** A group (for example "Size") has a minimum and maximum number of
choices (0 means optional; max 20). Options carry an extra price in rupees (0 for free), an
optional "pre-selected" flag, and availability. The screens enforce the same rules the customer
checkout will rely on:

- a new group cannot be required until it has options (add options first, then raise the minimum);
- an active group needs at least as many active options as its minimum;
- when only one choice is allowed, at most one option may be pre-selected, and the number of
  pre-selected options can never exceed the maximum;
- archiving or deleting the last options of a required group is refused with an explanation.

Groups are **attached to items** from the item's edit page ("Choices for this item").

**Tables.** Add a table (code + name), rename it, deactivate it and reactivate it. The suggested
next code is shown (`T06` after `T05`). The **code is fixed once created** because it is printed
in the QR code; rename the name instead. Tables are never deleted: a table that has orders cannot
be removed, so you deactivate it and its history stays.

## How the security works

- Every manager page calls `requireStaffPage("manager")`, every Server Action calls
  `requireStaffAction("manager")` (through `managerAction`), and the QR download route calls
  `requireStaffApi("manager")`. Server Actions are public endpoints, so none of them trusts the page
  that rendered the button.
- Writes run **as the signed-in manager** through the same cookie-based Supabase client, so the
  Phase 1 row-level security, grants and triggers apply a second time. The service-role key is never
  used. Phase 3 needed **no new migration**.
- All input is validated on the server with zod (ids, flags, money, lengths, enum values). Browser
  checks are only a convenience.
- Database errors are translated into plain messages ("A table with this code already exists.").
  Raw database text, constraint names and stack traces are never shown or logged.

## Table QR codes

A QR code carries only: `<public origin>/menu?table=<CODE>` (for example
`https://orders.example.com/menu?table=T06`). It never contains an id, a token, a key, or any
staff information. Since Phase 4 the link opens the customer menu for that table
([`customer-ordering.md`](customer-ordering.md)).

**The origin comes from `APP_BASE_URL`**, a server-only variable read at **runtime** (so a restart is
enough to change it, and one production build can serve any address). If it is blank the app falls
back to `NEXT_PUBLIC_APP_URL`; if neither is set, development uses `http://localhost:3000` and
production refuses to start. In production the value must be `https://...`.

Why not just `NEXT_PUBLIC_APP_URL`? Next.js copies every `NEXT_PUBLIC_` value into the build when you
run `pnpm build`, so changing it later has no effect until you rebuild, and a build made with
`localhost` in the environment keeps `localhost` forever. **Migration:** existing setups keep working
(the fallback), but set `APP_BASE_URL` to the same public origin so QR codes follow the running
server's configuration. `NEXT_PUBLIC_APP_URL` remains required in production and still only controls
the sign-in cookie's `Secure` flag.

| Situation                                     | Preview | Download / print                                                 |
| --------------------------------------------- | ------- | ---------------------------------------------------------------- |
| Public https address                          | yes     | yes                                                              |
| localhost / private network, `pnpm dev`       | yes     | yes, but files, printouts and filenames are marked **TEST ONLY** |
| localhost / private network, production build | yes     | **refused** (the page explains, the API returns 403)             |

So a QR code that points at `localhost` can never silently be printed and fixed to a table.

### Generate and test a QR code locally

1. Make sure `.env.local` exists (copy `.env.example`; see the README) and Supabase is running
   (`pnpm db:start`, then `pnpm db:reset` so the seed tables exist).
2. `pnpm dev`, sign in as a manager, open **Cafe tables and QR codes**.
3. Add a table or open an existing one, then click **QR code**. You see the preview, the exact link
   and, in development, the TEST ONLY marking.
4. To scan it with a phone on the same Wi-Fi, set `APP_BASE_URL` to your computer's LAN
   address (for example `http://192.168.1.20:3000`), restart `pnpm dev`, and start it with
   `pnpm dev -H 0.0.0.0` so the phone can reach it. The scanned link opens the menu for that table
   (or "We couldn't find that table" if the code does not exist or the table is deactivated).
5. For real cafe printing: deploy, set `APP_BASE_URL=https://your-domain` (and `NEXT_PUBLIC_APP_URL` likewise), restart the server, then use
   **Download SVG / PNG** or the **Printable sheet** (A4, one card per active table). Print and scan
   each code with a real phone before laminating (see the launch checklist).

### Invalid and deactivated tables

A deactivated table's QR page shows a warning and offers no download, and the QR API returns 409.
The table list is not readable by anonymous visitors (Phase 1 row-level security), so Phase 4
resolves `?table=CODE` **on the server** (`src/lib/customer/table-resolver.ts`, using
`normalizeTableCode` and `isOrderableTable` from `src/lib/tables/table-code.ts`) and treats a missing,
malformed or deactivated table as not orderable. See `docs/customer-ordering.md`.

## Item images (deliberately not built)

`menu_items.image_path` exists in the database but the manager screens do not upload images.
Doing this safely needs a Supabase Storage bucket with its own policies (public read, manager-only
write), server-side checks of file type and size, content sniffing rather than trusting the file
extension, re-encoding to strip metadata, and safe generated filenames. That is a separate security
surface, so it was left out of Phase 3 rather than shipped half-protected. It can be added later
without schema changes: create a `menu-images` bucket, add Storage policies that mirror the manager
policies, and write the object path into `image_path`.

## Testing

| Command              | What it covers for Phase 3                                                                                                                                                                              | Needs             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `pnpm test`          | Validation (money, limits, modifier rules), error mapping, planning, QR URL/identifier/decoding, SVG/PNG export, the guards, every Server Action's refusal paths, route handler, static security checks | nothing           |
| `pnpm test:db`       | `manager-errors.db.test.ts`: manager writes, counter denial, limits and real error codes mapped to friendly messages, on **real PostgreSQL**                                                            | PostgreSQL (auto) |
| `pnpm e2e`           | `manager.spec.ts`: access control, menu CRUD, modifier rules, table CRUD, QR page, export policy, print layout, accessibility, in a real browser                                                        | Chromium          |
| `pnpm test:supabase` | `manager-admin.supabase.test.ts`: the same repository code against **real** PostgREST/Auth/RLS as manager, counter, no-profile user and anonymous                                                       | `supabase start`  |

The browser tests use the **test double** of Supabase in `e2e/fake-supabase.mjs`, which now also
imitates the admin tables, roles and constraints in memory. They prove the app's behaviour, not real
RLS: that is what `test:db` and `test:supabase` are for. `pnpm e2e` always rebuilds into a clean
`.next-e2e` in an isolated environment, so a stale or differently configured `.next` cannot hide failures.
