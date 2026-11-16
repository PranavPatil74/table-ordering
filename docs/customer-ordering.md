# Customer QR ordering (Phase 4)

A guest scans the QR code on a table, browses the live menu, customises items, fills a cart and
reaches a checkout screen. **Payment is not built yet (Phases 5 and 6)**, so checkout stops at a
server-verified total and says plainly that online payment is not switched on. No order is created,
no payment attempt is written, and nobody is charged.

## The flow

```
QR code ──▶ /menu?table=T05 ──▶ item sheet ──▶ /cart?table=T05 ──▶ /checkout?table=T05
            validate table      choices +        edit / remove      server re-prices,
            load live menu      live total       stale-item notices "payment not available"
```

| Route                  | What it does                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `/menu?table=CODE`     | Branded mobile-first menu: category navigation, active items, prices, sold-out states, cart bar |
| `/cart?table=CODE`     | Lines with quantity steppers, edit, remove, stale-item warnings, total                          |
| `/checkout?table=CODE` | Optional name and note, "Review order" (server verdict), payment-not-configured state           |

No account or login is needed and none is offered. Customer pages never create a staff session.

## What the server decides (and what it never trusts)

| Concern             | Rule                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which table         | The browser sends only a **code**. `src/lib/customer/table-resolver.ts` looks it up on the server; the table id used afterwards comes from that lookup.                                                             |
| Unknown / malformed | One outcome, "We couldn't find that table": no hint whether a table exists.                                                                                                                                         |
| Deactivated table   | "This table isn't taking orders." Never reaches the menu.                                                                                                                                                           |
| Prices and totals   | Always recomputed from the live database menu in integer paise. A cart line holds **ids and a quantity only**: no price, name or total exists in browser storage to tamper with.                                    |
| Modifier rules      | `min_select` / `max_select` / sold-out / archived options are enforced by one shared module (`src/lib/customer/rules.ts`) used by the browser (to guide) and the server (to decide).                                |
| Quantity limits     | `max_item_quantity` and `max_items_per_order` from `cafe_settings`.                                                                                                                                                 |
| Orders paused       | `orders_enabled = false` blocks checkout and disables Add buttons; the menu stays readable.                                                                                                                         |
| Abuse               | Table lookups (60/min) and checkout reviews (30/min) are rate limited per client with the existing `check_rate_limit` function; the client address is keyed-hashed, never stored raw. The limiter **fails closed**. |

### Which database role does what

- **Menu reads** use a cookie-less client with the publishable key, as the `anon` role. Row-level
  security shows active rows only; sold-out rows arrive flagged so the page can say "Sold out".
  (`src/lib/supabase/public.ts`, `src/lib/customer/menu-loader.ts`)
- **Table lookup and rate limiting** need the service role, because `cafe_tables` is deliberately not
  readable by `anon` and `check_rate_limit` is `service_role` only. The service-role key lives in a
  short, reviewed list of server-only modules (`src/lib/privileged/*`,
  `src/lib/customer/table-resolver.ts`); a static test fails the build if any other file references it.
- The key never reaches a browser bundle (`server-only` imports plus static tests).

## The cart

- Stored in `localStorage` under `se-cart-v1:<TABLE>`; one cart per table; survives navigation and refresh.
- Identity of a line = item + sorted option ids, so the same sandwich with different choices is a
  **separate line**, and identical choices merge.
- Anything unreadable, hand-edited or from an older shape becomes an empty cart, never an error.
- If storage is blocked (private mode) the cart falls back to memory for the visit.
- Because lines hold no prices, a price change, a sold-out item, an archived item or a vanished
  option is picked up on the next render: affected lines are flagged ("Sold out", "No longer on the
  menu", "Options changed"), the total counts only orderable lines, and checkout is blocked until the
  customer removes or edits them ("Remove unavailable items" does it in one tap).

## Checkout: preview and save

`previewOrderAction` (side-effect free) and `saveCheckoutAction` (Phase 5, persistent) share one
server pipeline, `prepareCheckout` in `src/lib/customer/preview.ts`: rate limit, resolve the table,
load the live menu, re-price with the shared code, build the `cart_snapshot` v1. Both accept only
`{ tableCode, submissionId, customerName?, specialInstructions?, lines[{menuItemId, optionIds, quantity}] }`;
unknown fields (a price, a total, a table id, a payment status) are discarded by validation.

The checkout screen uses **save**: it stores the verified checkout as one `PENDING` payment attempt
and shows "Checkout saved" with the verified total, the item summary and a reference. Saving is not
paying and not ordering. See [`docs/checkout-attempts.md`](checkout-attempts.md) for the idempotency
design, transaction boundaries and what is deferred. `previewOrderAction` remains available and tested
but the screen no longer calls it.

Duplicate-submission protection is layered: the button is disabled while a request runs, an in-flight
guard drops a double tap, the browser reuses one `submissionId` per cart across reloads and retries
(`sessionStorage`), and the database's unique idempotency key makes a repeat harmless whatever the
browser does.

## Deliberately not built

| Not built         | Why / when                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Payment, orders   | Phase 6. Phase 5 saves a pending payment attempt only; checkout never invents a payment outcome.                                                                         |
| Order tracking    | Phase 7: there is no order to track yet.                                                                                                                                 |
| Menu photos       | Upload/Storage is not built (see `docs/menu-and-tables.md`). Items show a branded placeholder tile with an accessible label; a real `<img>` slots into `item-image.tsx`. |
| Customer accounts | Not in scope: "no forced account".                                                                                                                                       |
| Per-line notes    | The schema allows them; the UI only has one order-level note.                                                                                                            |

## Configuration

No new environment variables. It uses the existing `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. Phase 4 added no migration;
Phase 5 adds `20261104120000_checkout_attempts.sql` (two service-role functions, no new tables).

## Testing

| Layer                | What it proves                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test` (unit)   | Catalog building, modifier rules, cart operations/persistence, pricing, snapshot, table resolver, server preview (mocked services), static guards                |
| `pnpm test:db`       | On real PostgreSQL 16 (+ shim, not PostgREST): what `anon` can and cannot read, that the snapshot passes `cart_snapshot_problem` and a tampered one fails        |
| `pnpm test:supabase` | The same against a real local Supabase stack. **Not run by the author of Phase 4** (no Docker/Supabase CLI there).                                               |
| `pnpm e2e`           | Browser, production build, **test double** of Supabase: QR validation, customisation, cart, stale items, checkout, rate limit, accessibility, mobile and desktop |

### Try it by hand

1. `pnpm db:start`, `pnpm db:reset`, `pnpm dev` (see the README), sign in as a manager and add a table
   (`/staff/manager/tables`, e.g. `T01`) and some menu items.
2. Open `http://localhost:3000/menu?table=T01` on your phone (use your computer's LAN address and set
   `APP_BASE_URL` for printed QR codes) or on the desktop in a narrow window.
3. Customise an item, add it, change quantities, reload the page: the cart stays.
4. In the manager area mark the item **sold out**; reload `/cart`: the line is flagged and checkout is blocked.
5. Deactivate the table; reload `/menu?table=T01`: "This table isn't taking orders".
6. `/menu?table=NOPE` shows "We couldn't find that table".
7. Review the order: you see the verified total and "Online payment isn't switched on yet".
