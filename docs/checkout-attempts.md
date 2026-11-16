# Checkout snapshot and payment-attempt creation (Phase 5)

Phase 5 persists the authoritative checkout. When a customer taps **Save checkout**, the server
re-prices the cart from the live menu, builds the immutable `cart_snapshot` v1, and stores it with a
`PENDING` row in the existing `payment_attempts` table. **No payment is taken, no gateway order is
created and no order exists.** The screen says so.

## What the customer sees

| Stage                | Meaning                                                          | Reachable in Phase 5?                    |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| **Checkout saved**   | Details stored. Not a payment, not an order.                     | Yes                                      |
| Payment not started  | "Online payment isn't switched on yet." Nobody was charged.      | Yes (always shown next to "saved")       |
| **Payment verified** | The gateway confirmed the money (verified server-side only).     | No (UI exists; nothing can set PAID yet) |
| **Order created**    | An `orders` row exists (only `finalize_paid_order` creates one). | No                                       |
| Closed               | The saved checkout expired or failed. Nothing was charged.       | After 30 minutes                         |

The UI never shows "Order confirmed", "Payment successful", an order number or a pay button. The
reference (`CK-1A2B3C4D`) is the first 8 hex digits of the submission id, for quoting to staff.

## Flow and trust boundaries

```
browser                     Next.js server (Server Action)                 PostgreSQL
-------                     ------------------------------                 ----------
ids, quantities,  ───────▶  validate (zod; submission id = UUID v4)
name, note                  rate limit "checkout-save" (30/min per client)
                            resolve table by CODE (service role, active?)
                            load LIVE menu (anon role), re-price in paise
                            build snapshot v1 (names + prices from the DB)
                            ───────────────────────────────────────────▶   create_checkout_attempt(...)
                                                                            one transaction, see below
                            ◀───────────────────────────────────────────   created | existing | conflict | table_unavailable
reference, lines,  ◀──────  map to a customer-safe result (no internal ids)
total, stage
```

The browser never supplies a price, total, table id, status or payment state; unknown fields are
dropped by validation. Everything the database stores comes from the server's own pricing.

## Idempotency design

- The **idempotency key is the submission id** (`payment_attempts.idempotency_key`, already `UNIQUE`,
  16 to 128 chars). It must be a random UUID v4, which `crypto.randomUUID()` produces.
- `public.create_checkout_attempt` runs `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`. Under
  READ COMMITTED, two simultaneous calls with the same key serialise on the unique index: the second
  waits for the first to commit (or roll back, in which case it inserts instead), then reads the
  committed row. Exactly one row can ever exist for a key.
- Outcome for a repeated key: **same table, amount and snapshot → `existing`** (the stored attempt is
  returned, nothing is written); **anything different → `conflict`** (nothing is changed and nothing
  about the stored cart is revealed). Comparison is `jsonb` equality on the whole snapshot, so a
  changed quantity, option, name or note counts as a different cart.
- The browser keeps `{ submissionId, cart signature }` in `sessionStorage`. The same cart and notes
  reuse the id (reload, double tap, retry after a lost response); a changed cart gets a new id. If a
  retry hits a changed menu, the server answers `conflict` and the screen offers "Save the latest
  order", which uses a new id. The earlier attempt is abandoned, not paid, and expires.
- Frontend disabling and the in-flight guard only reduce noise. Correctness comes from the unique
  index and the function.

## Transaction boundaries

One call to `create_checkout_attempt` is one database transaction (a PostgREST RPC call). Inside it:
parameter checks, the replay lookup, a `FOR SHARE` lock on the table row (so it cannot be deactivated
between the check and the insert), then the insert. The existing `BEFORE INSERT` trigger runs
`private.cart_snapshot_problem` (structure, whole-paise integers, line sums, total equals amount) and
forces `PENDING`; any failure raises and **rolls the whole call back, leaving no row**. The Node
server makes no other writes, so there is no cross-system transaction to get wrong.

## Tracking token

`tracking_token_hash` is `NOT NULL`, unique and immutable, so a token must be fixed when the attempt is
saved, although the customer only needs it after payment (Phase 7). The token is derived as
`HMAC-SHA256(SUPABASE_SERVICE_ROLE_KEY, "tracking-token:v1:" + submission id)`, truncated to 128 bits
and base64url encoded; only its SHA-256 hash is stored and sent to the database. It is never stored
or returned in Phase 5, a retry derives the same hash, and a database leak does not reveal it.
_Limitation:_ rotating the service-role key changes derived tokens for attempts saved earlier; if that
matters before Phase 7, introduce a dedicated secret then.

## Security

- `create_checkout_attempt` and `get_checkout_attempt` are `SECURITY DEFINER`, pin `search_path`, and are
  executable by `service_role` only (explicit `REVOKE` from `PUBLIC`, `anon`, `authenticated`).
- The service-role key is used only in `src/lib/privileged/checkout-attempts.ts` (plus the existing
  allow-list); a static test pins the allow-list and that module's two function names, and that it
  never references orders, the finaliser or Razorpay.
- Customers cannot read attempts: `payment_attempts` has no `anon` grant. Revisiting uses
  `get_checkout_attempt` through the server and requires BOTH the random submission id held by that
  browser AND the matching table; another table's id looks exactly like an unknown id. Names and notes
  are never returned.
- Rate limits: `checkout-save` 30/min and `checkout-lookup` 30/min per client fingerprint, failing
  closed, on top of the table-lookup limit.
- No internal row id, token or hash is returned to the browser.

## No paid order without verified payment

Nothing in Phase 5 sets `PAID`, writes `gateway_payment_id`/`paid_at`, calls `finalize_paid_order` or
inserts into `orders`. The existing guards still apply and are tested: an attempt cannot be inserted as
`PAID`, cannot become `PAID` without a payment id and timestamp, a settled attempt is frozen, the
snapshot/amount/table/key/token hash are immutable, and an `orders` row cannot exist for a non-`PAID`
attempt. `finalize_paid_order` remains service-role only and belongs to Phase 6, after the server has
verified the payment with Razorpay.

## Testing

| Layer                | Coverage                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`          | `checkout.test.ts` (pricing, forged fields, inactive/archived/sold-out items, modifier rules, stale prices, malformed ids, outcomes, no leakage), `checkout-attempts.test.ts`, static guards             |
| `pnpm test:db`       | `checkout-attempts.db.test.ts` on real PostgreSQL 16: creation, sequential and 20-way concurrent duplicates, conflicts, rollback, immutability, state rules, grants, no order                            |
| `pnpm test:supabase` | `checkout-attempts.supabase.test.ts` through the real local API (needs the local stack; **not run in the authoring sandbox**)                                                                            |
| `pnpm e2e`           | Save, double tap, saving state, reload/revisit, lost response then retry, changed order, inactive table, sold-out item, conflict, forged requests, accessibility (against the Supabase test double only) |

## Deferred (Phase 6 and later)

Razorpay order creation, checkout, payment verification, webhooks and gateway-event deduplication,
`finalize_paid_order`, order tracking, expiring stale `PENDING` attempts (they currently remain
`PENDING` past `expires_at`; the UI shows them as expired, and the menu-item delete guard still treats
them as unpaid checkouts until a Phase 6 job marks them `FAILED`), a staff view of saved checkouts,
and a per-table cap on pending attempts (anonymous creation is limited only by the rate limiter).
