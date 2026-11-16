# Staff authentication (Phase 2)

Staff sign in at `/staff/login` with an email and password. Everything about who may enter, and as
what, is decided on the server from the database. Public sign-up does not exist.

## How it works

**Sign-in.** The form posts to a Server Action (`src/app/staff/login/actions.ts`). It validates the
fields, calls Supabase Auth's password grant, then checks that the account is **active staff**
(a row in `public.staff_profiles`). Anyone else is signed straight back out, so a valid Supabase
account that is not staff never keeps a session. The error messages never say whether an email
address exists.

**Session.** The Supabase session lives only in cookies the server sets: `HttpOnly`,
`SameSite=Lax`, `Secure` whenever `NEXT_PUBLIC_APP_URL` is https. There is no browser-side
Supabase client in Phase 2, so page scripts can never read the tokens.

**Refresh.** `src/proxy.ts` (Next.js 16's name for middleware) refreshes an expiring session before
the page renders and writes the new tokens to the response. Server Components cannot set cookies,
and refresh tokens rotate, so exactly one place refreshes. The proxy also sends visitors with no
session away from staff pages. It is a convenience, **not** the security boundary.

**Authorisation.** `src/lib/auth/session.ts` is the boundary. On every request to a staff page,
Server Action or API route it:

1. asks the Auth server who the caller is (`getUser`), which rejects forged, expired, signed-out
   and deleted-user tokens (the cookie alone is never trusted);
2. reads the caller's **own** `staff_profiles` row through their own session, so Phase 1's
   row-level security applies;
3. allows only an **active** profile whose `role` is `counter` or `manager`.

The role comes from that row and nowhere else: not from `user_metadata` (users can edit it), not
from a form field or header. A role change or deactivation in the database applies on the very next
request, with no re-login.

| Caller                               | `/staff` page                             | `/api/staff/me` |
| ------------------------------------ | ----------------------------------------- | --------------- |
| No session / forged or revoked token | redirect to sign-in                       | 401             |
| Signed in, no staff profile          | redirect to sign-in (with an explanation) | 403             |
| Signed in, inactive profile          | redirect to sign-in (with an explanation) | 403             |
| Active counter                       | allowed, role `counter`                   | 200             |
| Active manager                       | allowed, role `manager`                   | 200             |
| Auth or database unreachable         | error page (fails closed)                 | 503             |

`requireStaffPage(minimum)` and `requireStaffApi(minimum)` take a minimum role (`"manager"` makes a
page 404 for counters and an API return 403). No Phase 2 page needs it yet; later phases will.

**Sign-out.** Ends this browser's session only (`scope: "local"`), then clears the cookies even if
Auth cannot be reached.

**What Phase 2 never does.** It uses only the publishable key. It never reads the service-role key,
never creates or edits staff, and never writes to the database. A static test
(`src/test/staff-auth-static.test.ts`) fails if the sign-in code starts to.

## Creating the first manager (administrator procedure)

Nobody can create staff through the app or the API; this is deliberate. An administrator with
database access does it once.

1. Create the Auth user. Local stack: open Supabase Studio (URL printed by `pnpm db:status`),
   Authentication, Users, **Add user**, tick **Auto Confirm User**, and choose a password of at
   least 12 characters. Hosted project: the same screen in the dashboard.
2. Copy the new user's UUID.
3. Give them a profile. Local stack, Windows PowerShell:

   ```powershell
   # Replace the UUID and name. The container name is supabase_db_<project_id>.
   docker exec -i supabase_db_sandwich-express psql -U postgres -d postgres -c "insert into public.staff_profiles (user_id, display_name, role) values ('00000000-0000-0000-0000-000000000000', 'Your name', 'manager');"
   ```

   Any machine with `psql` can run the same statement against the database URL from
   `pnpm db:status`; hosted projects can paste it into the SQL editor. It runs as the `postgres`
   role, which is the only way a profile can be created.

4. Sign in at `/staff/login`.

Counter accounts are created the same way with `role = 'counter'`. A manager can later change
another profile's `role` and `is_active` (Phase 1 policies); creating and deleting profiles stays
an administrator task. Use only local development accounts for testing, and never paste passwords
or keys into chat, commits or screenshots.

## Testing

| Command              | What it covers                                                                                                                                                                                         | Needs                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `pnpm test`          | Pure role and redirect logic, guards, Server Actions, proxy, the form, static security checks                                                                                                          | nothing                                                                              |
| `pnpm e2e`           | The real production build in a browser: redirects, sign-in, errors, sign-out, role pages, HttpOnly cookies, refresh, mid-session deactivation                                                          | Chromium. Uses a **test double** of Supabase (`e2e/fake-supabase.mjs`), not Supabase |
| `pnpm test:supabase` | `staff-guard.supabase.test.ts`: the exact profile query and decision against **real** Auth and PostgREST (roles, inactive, no profile, metadata ignored, revoked and forged tokens, live role changes) | `supabase start`                                                                     |

The browser tests prove how the **app** behaves for each response Supabase can give. Only
`pnpm test:supabase` shows real Supabase gives those responses. The cookie layer and Next.js
redirects have not been run against a real Supabase stack by automation; a manual check is in the
README ("Try it yourself").
