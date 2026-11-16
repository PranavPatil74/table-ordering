# Staff management (Phase 4)

`/staff/manager/staff` lets a **manager** see everyone who can sign in to the staff area and
deactivate or reactivate accounts. Counter staff and signed-out visitors cannot reach it (404 / sign-in redirect).

## What it does

- **Directory:** name, e-mail, role (Manager / Counter), status (Active / Deactivated), date added.
- **Search** by name or e-mail; **filter** by role and by status; live "N of M people" count;
  empty, no-match (with "Clear filters"), loading and load-error (with retry) states.
- **Deactivate / Reactivate** behind a confirmation dialog, with success and error feedback.
- A discoverable **Staff** link in the manager navigation, the overview and the staff home page.

## What it deliberately does not do

| Not built                    | Why                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create / invite staff        | Creating a sign-in needs the Auth admin API (service role). A web form that can mint accounts is a privilege-escalation surface; Phase 4 does not add one. |
| Change roles                 | Not required, and role changes are the riskiest edit. The database grant allows it for managers; no screen offers it.                                      |
| Delete staff                 | No `DELETE` grant exists for user sessions, by design (Phase 1).                                                                                           |
| Public registration          | Still disabled. Nothing here changes sign-up.                                                                                                              |
| Audit trail of staff changes | `order_events` is order-only. A staff audit log needs a new table; recorded as a follow-up below.                                                          |

### Adding a new team member (secure procedure, unchanged)

1. In Supabase Studio (local) or the Supabase dashboard (hosted), **Authentication → Users → Add user**
   with their e-mail and a strong password, or send an invite.
2. Create their profile in the SQL editor (the service role/administrator is the only role that can):

   ```sql
   insert into public.staff_profiles (user_id, display_name, role)
   select id, 'Their Name', 'counter' from auth.users where email = 'them@example.com';
   ```

3. They appear in the directory immediately. See `docs/staff-auth.md` for the first-manager procedure.

A future phase can add an invite flow behind a server-only, manager-authorised, rate-limited endpoint
with an audit log; it should be designed and reviewed on its own, not bolted on here.

## How it is secured

| Layer             | Rule                                                                                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page              | `requireStaffPage("manager")`: re-verified against Auth and `staff_profiles` on every request; counters get 404.                                                                                                                                                                                                  |
| Server Action     | `managerAction` → `requireStaffAction("manager")`: Server Actions are public endpoints, so each call re-verifies. The **actor comes from the verified session**, never from an argument.                                                                                                                          |
| Database          | The manager's **own session** performs the write: RLS (`staff_profiles_update` managers only), the column grant (`display_name, role, is_active` only) and the `guard_last_active_manager` trigger all apply. The app sends **only** `is_active`.                                                                 |
| Target validation | UUID-validated; the row is read first (missing → "doesn't exist any more").                                                                                                                                                                                                                                       |
| Self-lockout      | A manager cannot deactivate themselves (UI disabled with an explanation **and** refused in the action before any write). **App rule only**: the database does not forbid it while another manager exists, so a hand-written API call could. It cannot leave the cafe without a manager, because of the next rule. |
| Last manager      | The database trigger refuses to deactivate/demote the last active manager, serialised by an advisory lock so two managers cannot remove each other concurrently (verified on PostgreSQL). The UI also disables the button and the action maps the error to a clear message.                                       |
| Concurrency       | The update is conditional (`where user_id = … and is_active = <state we read>`); if someone else changed the row first, nothing is written and the manager is told to refresh (the list reloads).                                                                                                                 |
| No self-promotion | No screen changes roles; a counter's attempt to update their own role matches zero rows under RLS (verified on PostgreSQL).                                                                                                                                                                                       |
| E-mail addresses  | They live in Supabase Auth. `src/lib/privileged/staff-emails.ts` reads **only e-mails** with the service role, only after the caller's manager role is re-checked, only for profiles the manager may already list. Failure for one person shows "Email unavailable".                                              |

### Deactivated staff lose access immediately

Every staff request re-reads the caller's own profile (`is_active`), so a deactivated person is turned
away from pages, Server Actions and the API on their very next request, even with a valid session
cookie. Their Auth sessions are not revoked (that would need the Auth admin API); they are simply
useless. Reactivation restores access without a new sign-in. Past orders and history are untouched
(profiles are never deleted).

## Known limitations / follow-ups

- No audit trail for staff changes (needs a migration; not done to keep Phase 4 migration-free).
- No staff creation, invite or role-change UI (see above).
- The directory is loaded in one query and filtered in the browser: right for a cafe's team, not for thousands.
- The e-mail lookup makes one Auth admin call per person per page load.

## Testing

| Layer                | What it proves                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`          | Filter/sort/safeguard logic, repository behaviour (self, missing, conflict, race, last manager, no error leakage), action authorisation (signed-out, counter, forged arguments), static guards                                                |
| `pnpm test:db`       | On real PostgreSQL: manager can list/update, counter cannot, no insert/delete/identity edits, last-manager guard, concurrent mutual deactivation (exactly one wins), deactivated manager loses powers                                         |
| `pnpm test:supabase` | The same through real PostgREST/Auth, plus access loss after deactivation. **Not run by the author of Phase 4.**                                                                                                                              |
| `pnpm e2e`           | Browser: counter 404, signed-out redirect, directory contents, filters, self protection, confirm/cancel, deactivated user's live session loses access (pages and API), reactivation, stale-state conflict, "Email unavailable", accessibility |
