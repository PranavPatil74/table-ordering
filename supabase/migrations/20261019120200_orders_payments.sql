-- Sandwich Express, Phase 1, migration 3/6: payment attempts, orders, order items, audit
-- events and supporting counter / idempotency / rate-limit tables.
--
-- Lifecycle (see docs/database.md):
--   1. Checkout (server, Phase 5) prices the cart from the menu and inserts a payment_attempt
--      holding an immutable cart snapshot, a Razorpay order id and the HASH of a tracking token.
--   2. After the gateway reports a captured payment and the server has verified it (Phase 6),
--      the server calls public.finalize_paid_order(). Only then does an `orders` row exist.
--   3. An `orders` row therefore can only ever be paid. Unpaid orders do not exist.

-- ---------------------------------------------------------------------------------------
-- Cart snapshot validation
-- ---------------------------------------------------------------------------------------
-- Returns NULL when the snapshot is well-formed and its arithmetic is exact, otherwise a short
-- description of the first problem. Used when a payment attempt is created and again when it
-- is finalised, so a malformed or tampered snapshot can never become an order.
--
-- Snapshot shape (version 1):
--   { "version": 1,
--     "table": {"id": uuid, "code": text, "label": text},
--     "customer_name": text|null, "special_instructions": text|null,
--     "items": [ { "menu_item_id": uuid, "item_name": text, "unit_price_paise": int,
--                  "quantity": int, "note": text|null,
--                  "options": [ {"group_id": uuid, "group_name": text, "option_id": uuid,
--                                "option_name": text, "price_delta_paise": int} ] } ],
--     "total_paise": int }

create function private.cart_snapshot_problem(p_snapshot jsonb, p_amount_paise integer)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  c_uuid constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_item    jsonb;
  v_opt     jsonb;
  v_total   bigint := 0;
  v_opt_sum bigint;
begin
  if jsonb_typeof(p_snapshot) is distinct from 'object' then
    return 'snapshot must be a JSON object';
  end if;
  if p_snapshot -> 'version' is distinct from '1'::jsonb then
    return 'unsupported snapshot version';
  end if;

  if jsonb_typeof(p_snapshot -> 'table') is distinct from 'object'
     or coalesce(p_snapshot #>> '{table,id}', '') !~ c_uuid
     or jsonb_typeof(p_snapshot #> '{table,code}') is distinct from 'string'
     or jsonb_typeof(p_snapshot #> '{table,label}') is distinct from 'string'
     or char_length(btrim(p_snapshot #>> '{table,code}')) not between 1 and 16
     or char_length(btrim(p_snapshot #>> '{table,label}')) not between 1 and 40 then
    return 'invalid table';
  end if;

  if coalesce(jsonb_typeof(p_snapshot -> 'customer_name'), 'null') not in ('null', 'string')
     or char_length(p_snapshot ->> 'customer_name') > 60 then
    return 'invalid customer_name';
  end if;
  if coalesce(jsonb_typeof(p_snapshot -> 'special_instructions'), 'null') not in ('null', 'string')
     or char_length(p_snapshot ->> 'special_instructions') > 500 then
    return 'invalid special_instructions';
  end if;

  if jsonb_typeof(p_snapshot -> 'items') is distinct from 'array'
     or jsonb_array_length(p_snapshot -> 'items') not between 1 and 50 then
    return 'items must be an array of 1 to 50 lines';
  end if;

  for v_item in select value from jsonb_array_elements(p_snapshot -> 'items') loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      return 'item must be an object';
    end if;
    if coalesce(v_item ->> 'menu_item_id', '') !~ c_uuid then
      return 'invalid menu_item_id';
    end if;
    if jsonb_typeof(v_item -> 'item_name') is distinct from 'string'
       or char_length(btrim(v_item ->> 'item_name')) not between 1 and 80 then
      return 'invalid item_name';
    end if;
    if jsonb_typeof(v_item -> 'unit_price_paise') is distinct from 'number'
       or coalesce(v_item ->> 'unit_price_paise', '') !~ '^[0-9]{1,8}$' then
      return 'unit_price_paise must be a whole number of paise';
    end if;
    if jsonb_typeof(v_item -> 'quantity') is distinct from 'number'
       or coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,2}$'
       or (v_item ->> 'quantity')::integer not between 1 and 99 then
      return 'quantity must be a whole number from 1 to 99';
    end if;
    if coalesce(jsonb_typeof(v_item -> 'note'), 'null') not in ('null', 'string')
       or char_length(v_item ->> 'note') > 200 then
      return 'invalid note';
    end if;
    if jsonb_typeof(v_item -> 'options') is distinct from 'array'
       or jsonb_array_length(v_item -> 'options') > 40 then
      return 'options must be an array';
    end if;

    v_opt_sum := 0;
    for v_opt in select value from jsonb_array_elements(v_item -> 'options') loop
      if jsonb_typeof(v_opt) is distinct from 'object'
         or coalesce(v_opt ->> 'group_id', '') !~ c_uuid
         or coalesce(v_opt ->> 'option_id', '') !~ c_uuid
         or jsonb_typeof(v_opt -> 'group_name') is distinct from 'string'
         or jsonb_typeof(v_opt -> 'option_name') is distinct from 'string'
         or char_length(btrim(v_opt ->> 'group_name')) not between 1 and 80
         or char_length(btrim(v_opt ->> 'option_name')) not between 1 and 80 then
        return 'invalid option';
      end if;
      if jsonb_typeof(v_opt -> 'price_delta_paise') is distinct from 'number'
         or coalesce(v_opt ->> 'price_delta_paise', '') !~ '^[0-9]{1,7}$' then
        return 'price_delta_paise must be a whole number of paise';
      end if;
      v_opt_sum := v_opt_sum + (v_opt ->> 'price_delta_paise')::bigint;
    end loop;

    v_total := v_total
      + ((v_item ->> 'unit_price_paise')::bigint + v_opt_sum) * (v_item ->> 'quantity')::bigint;
  end loop;

  if jsonb_typeof(p_snapshot -> 'total_paise') is distinct from 'number'
     or coalesce(p_snapshot ->> 'total_paise', '') !~ '^[0-9]{1,9}$' then
    return 'total_paise must be a whole number of paise';
  end if;
  if (p_snapshot ->> 'total_paise')::bigint <> v_total then
    return 'total_paise does not equal the sum of the lines';
  end if;
  if v_total <> p_amount_paise then
    return 'snapshot total does not equal the payment amount';
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Payment attempts
-- ---------------------------------------------------------------------------------------
-- One row per checkout. The cart snapshot is fixed at creation, so what the customer is
-- charged for can never drift from what the cafe prepares. Only the trusted backend writes
-- here; staff may read the gateway references (never the snapshot or token hash).

create table public.payment_attempts (
  id                  uuid primary key default gen_random_uuid(),
  -- Supplied by the client per checkout submission; a double-tap returns the same attempt.
  idempotency_key     text not null,
  table_id            uuid not null references public.cafe_tables (id) on delete restrict,
  amount_paise        integer not null,
  currency            char(3) not null default 'INR',
  status              public.payment_status not null default 'PENDING',
  gateway             text not null default 'razorpay',
  -- Razorpay order id (order_xxx), set once after the gateway order is created.
  gateway_order_id    text,
  -- Razorpay payment id (pay_xxx), set once when the payment is verified and finalised.
  gateway_payment_id  text,
  -- SHA-256 of the customer's tracking token. The raw token is shown to the customer once
  -- and never stored.
  tracking_token_hash bytea not null,
  cart_snapshot       jsonb not null,
  expires_at          timestamptz not null,
  paid_at             timestamptz,
  failure_reason      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint payment_attempts_idempotency_key_unique unique (idempotency_key),
  constraint payment_attempts_idempotency_key_length
    check (char_length(idempotency_key) between 16 and 128),
  -- 100 paise = Rs 1, the smallest amount the gateway accepts.
  constraint payment_attempts_amount_paise_range check (amount_paise between 100 and 100000000),
  constraint payment_attempts_currency check (currency = 'INR'),
  constraint payment_attempts_status check (status in ('PENDING', 'PAID', 'FAILED')),
  constraint payment_attempts_gateway check (gateway = 'razorpay'),
  constraint payment_attempts_token_hash_length check (octet_length(tracking_token_hash) = 32),
  constraint payment_attempts_snapshot_is_object check (jsonb_typeof(cart_snapshot) = 'object'),
  constraint payment_attempts_expiry_after_creation check (expires_at > created_at),
  constraint payment_attempts_gateway_order_id_length check (char_length(gateway_order_id) <= 64),
  constraint payment_attempts_gateway_payment_id_length
    check (char_length(gateway_payment_id) <= 64),
  constraint payment_attempts_failure_reason_length check (char_length(failure_reason) <= 300),
  -- A payment is recorded exactly when, and only when, the attempt is PAID.
  constraint payment_attempts_paid_consistency check (
    (status = 'PAID') = (gateway_payment_id is not null)
    and (status = 'PAID') = (paid_at is not null)
  ),
  constraint payment_attempts_failed_reason check (
    status = 'FAILED' or failure_reason is null
  )
);

-- Prevent duplicate payment associations: one gateway order, and one gateway payment, can
-- belong to at most one attempt.
create unique index payment_attempts_gateway_order_unique
  on public.payment_attempts (gateway, gateway_order_id) where gateway_order_id is not null;
create unique index payment_attempts_gateway_payment_unique
  on public.payment_attempts (gateway, gateway_payment_id) where gateway_payment_id is not null;
create unique index payment_attempts_token_hash_unique
  on public.payment_attempts (tracking_token_hash);
create index payment_attempts_table_idx on public.payment_attempts (table_id);
create index payment_attempts_pending_expiry_idx
  on public.payment_attempts (expires_at) where status = 'PENDING';

create function private.payment_attempts_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_problem text;
begin
  v_problem := private.cart_snapshot_problem(new.cart_snapshot, new.amount_paise);
  if v_problem is not null then
    raise exception 'Invalid cart snapshot: %', v_problem using errcode = 'check_violation';
  end if;
  if new.status <> 'PENDING'::public.payment_status then
    raise exception 'A payment attempt must start as PENDING' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger payment_attempts_before_insert
  before insert on public.payment_attempts
  for each row execute function private.payment_attempts_before_insert();

-- Attempts are immutable except for the gateway order id (set once), the payment fields and
-- the final status. A settled attempt (PAID or FAILED) never changes again.
create function private.payment_attempts_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c_mutable constant text[] := array[
    'status', 'gateway_order_id', 'gateway_payment_id', 'paid_at', 'failure_reason', 'updated_at'
  ];
begin
  if (to_jsonb(new) - c_mutable) is distinct from (to_jsonb(old) - c_mutable) then
    raise exception 'Payment attempt snapshots and identifiers are immutable'
      using errcode = 'restrict_violation';
  end if;

  if old.status <> 'PENDING'::public.payment_status then
    if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
      raise exception 'A settled payment attempt (%) cannot be modified', old.status
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if old.gateway_order_id is not null and new.gateway_order_id is distinct from old.gateway_order_id then
    raise exception 'gateway_order_id is write-once' using errcode = 'restrict_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger payment_attempts_before_update
  before update on public.payment_attempts
  for each row execute function private.payment_attempts_before_update();

-- ---------------------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------------------
-- Created only by public.finalize_paid_order(), after payment verification. Display numbers
-- are per business day (Asia/Kolkata): SE-001, SE-002, ... and restart each day, so
-- uniqueness is (business_date, order_number). Customers never see sequential identifiers
-- that grant access: they reach an order through the unguessable tracking token.

create table public.orders (
  id                  uuid primary key default gen_random_uuid(),
  business_date       date not null,
  daily_seq           integer not null,
  order_number        text not null,
  payment_attempt_id  uuid not null references public.payment_attempts (id) on delete restrict,
  -- Hash of the tracking token (copied from the attempt). Raw token is never stored.
  tracking_token_hash bytea not null,
  -- The table row can never be deleted while orders reference it; the code and label are
  -- also copied so history survives renaming a table.
  table_id            uuid not null references public.cafe_tables (id) on delete restrict,
  table_code          text not null,
  table_label         text not null,
  customer_name       text,
  special_instructions text,
  status              public.order_status not null default 'NEW',
  payment_status      public.payment_status not null default 'PAID',
  total_paise         integer not null,
  currency            char(3) not null default 'INR',
  cancel_reason       text,
  placed_at           timestamptz not null default now(),
  accepted_at         timestamptz,
  preparing_at        timestamptz,
  ready_at            timestamptz,
  served_at           timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint orders_number_per_day_unique unique (business_date, order_number),
  constraint orders_seq_per_day_unique unique (business_date, daily_seq),
  constraint orders_payment_attempt_unique unique (payment_attempt_id),
  constraint orders_tracking_token_hash_unique unique (tracking_token_hash),
  constraint orders_daily_seq_positive check (daily_seq > 0),
  constraint orders_number_format check (order_number ~ '^[A-Z]{1,5}-[0-9]{3,}$'),
  constraint orders_token_hash_length check (octet_length(tracking_token_hash) = 32),
  constraint orders_table_code_length check (char_length(btrim(table_code)) between 1 and 16),
  constraint orders_table_label_length check (char_length(btrim(table_label)) between 1 and 40),
  constraint orders_customer_name_length check (char_length(customer_name) <= 60),
  constraint orders_instructions_length check (char_length(special_instructions) <= 500),
  constraint orders_total_paise_range check (total_paise between 100 and 100000000),
  constraint orders_currency check (currency = 'INR'),
  -- An order can only exist once paid: PENDING and FAILED never appear here.
  constraint orders_payment_status_paid_family
    check (payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')),
  constraint orders_cancel_reason_length check (char_length(cancel_reason) between 1 and 300),
  constraint orders_cancel_reason_only_when_cancelled
    check (cancel_reason is null or status = 'CANCELLED'),
  constraint orders_cancelled_at_consistent check ((status = 'CANCELLED') = (cancelled_at is not null)),
  constraint orders_accepted_at_consistent
    check (status not in ('ACCEPTED', 'PREPARING', 'READY', 'SERVED') or accepted_at is not null),
  constraint orders_preparing_at_consistent
    check (status not in ('PREPARING', 'READY', 'SERVED') or preparing_at is not null),
  constraint orders_ready_at_consistent
    check (status not in ('READY', 'SERVED') or ready_at is not null),
  constraint orders_served_at_consistent check ((status = 'SERVED') = (served_at is not null))
);

-- Live board: active orders, oldest first.
create index orders_active_idx on public.orders (placed_at)
  where status in ('NEW', 'ACCEPTED', 'PREPARING', 'READY');
create index orders_history_idx on public.orders (placed_at desc);
create index orders_table_idx on public.orders (table_id, placed_at desc);
create index orders_status_idx on public.orders (status, placed_at desc);

-- ---------------------------------------------------------------------------------------
-- Order items: immutable historical snapshots
-- ---------------------------------------------------------------------------------------
-- Name, selected options and prices are COPIED here at order time. Later menu edits never
-- touch these rows, and a trigger forbids editing them at all.

create table public.order_items (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders (id) on delete restrict,
  line_no            smallint not null,
  -- Reference for reporting only. RESTRICT: an item that has been ordered is archived
  -- (is_active = false), never deleted.
  menu_item_id       uuid not null references public.menu_items (id) on delete restrict,
  item_name          text not null,
  unit_price_paise   integer not null,
  -- Snapshot of chosen options: [{group_id, group_name, option_id, option_name, price_delta_paise}]
  options            jsonb not null default '[]'::jsonb,
  -- Sum of option price deltas for ONE unit (derived from `options`, verified by trigger).
  options_unit_paise integer not null default 0,
  quantity           smallint not null,
  line_total_paise   integer not null,
  note               text,
  created_at         timestamptz not null default now(),
  constraint order_items_line_unique unique (order_id, line_no),
  constraint order_items_line_no_positive check (line_no > 0),
  constraint order_items_name_length check (char_length(btrim(item_name)) between 1 and 80),
  constraint order_items_unit_price_range check (unit_price_paise between 0 and 10000000),
  constraint order_items_options_is_array check (jsonb_typeof(options) = 'array'),
  constraint order_items_options_unit_range check (options_unit_paise between 0 and 100000000),
  constraint order_items_quantity_range check (quantity between 1 and 99),
  constraint order_items_line_total_exact
    check (line_total_paise = (unit_price_paise + options_unit_paise)::bigint * quantity),
  constraint order_items_note_length check (char_length(note) <= 200)
);
create index order_items_menu_item_idx on public.order_items (menu_item_id);

create function private.order_items_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_opt     jsonb;
  v_sum     bigint := 0;
begin
  for v_opt in select value from jsonb_array_elements(new.options) loop
    if jsonb_typeof(v_opt) is distinct from 'object'
       or jsonb_typeof(v_opt -> 'option_name') is distinct from 'string'
       or jsonb_typeof(v_opt -> 'group_name') is distinct from 'string'
       or jsonb_typeof(v_opt -> 'price_delta_paise') is distinct from 'number'
       or coalesce(v_opt ->> 'price_delta_paise', '') !~ '^[0-9]{1,7}$' then
      raise exception 'Invalid option snapshot on order item' using errcode = 'check_violation';
    end if;
    v_sum := v_sum + (v_opt ->> 'price_delta_paise')::bigint;
  end loop;

  if v_sum <> new.options_unit_paise then
    raise exception 'options_unit_paise (%) does not equal the sum of the option snapshots (%)',
      new.options_unit_paise, v_sum using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger order_items_before_insert
  before insert on public.order_items
  for each row execute function private.order_items_before_insert();

create trigger order_items_immutable
  before update or delete on public.order_items
  for each row execute function private.reject_mutation();

-- The order total must equal the sum of its lines, and an order must have lines. Checked at
-- COMMIT (deferred) because the order row is inserted before its items.
create function private.check_order_total()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_sum   bigint;
  v_count bigint;
begin
  select coalesce(sum(oi.line_total_paise), 0), count(*)
    into v_sum, v_count
  from public.order_items oi
  where oi.order_id = new.id;

  if v_count = 0 then
    raise exception 'Order % has no items', new.id using errcode = 'check_violation';
  end if;
  if v_sum <> new.total_paise then
    raise exception 'Order % total (%) does not equal the sum of its lines (%)',
      new.id, new.total_paise, v_sum using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger orders_total_matches_items
  after insert on public.orders
  deferrable initially deferred
  for each row execute function private.check_order_total();

-- ---------------------------------------------------------------------------------------
-- Order status machine
-- ---------------------------------------------------------------------------------------

create function private.order_status_transition_allowed(
  p_from public.order_status,
  p_to   public.order_status
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'NEW'       then p_to in ('ACCEPTED', 'CANCELLED')
    when 'ACCEPTED'  then p_to in ('PREPARING', 'CANCELLED')
    when 'PREPARING' then p_to in ('READY', 'CANCELLED')
    when 'READY'     then p_to in ('SERVED', 'CANCELLED')
    else false
  end
$$;

-- REFUNDED is reachable only through REFUND_PENDING, i.e. only after a refund was requested.
-- REFUND_PENDING -> PAID covers a refund the gateway rejected.
create function private.payment_status_transition_allowed(
  p_from public.payment_status,
  p_to   public.payment_status
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'PAID'           then p_to = 'REFUND_PENDING'
    when 'REFUND_PENDING' then p_to in ('REFUNDED', 'PAID')
    else false
  end
$$;

create function private.orders_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c_mutable constant text[] := array[
    'status', 'payment_status', 'cancel_reason', 'updated_at',
    'accepted_at', 'preparing_at', 'ready_at', 'served_at', 'cancelled_at'
  ];
begin
  -- Everything that identifies or prices the order is frozen.
  if (to_jsonb(new) - c_mutable) is distinct from (to_jsonb(old) - c_mutable) then
    raise exception 'Order identity, table, totals and tracking data are immutable'
      using errcode = 'restrict_violation';
  end if;

  -- Timestamps are system-managed: a caller cannot back-date, clear or pre-set them. They
  -- start from the stored values and only the one for the new status is stamped below.
  new.accepted_at  := old.accepted_at;
  new.preparing_at := old.preparing_at;
  new.ready_at     := old.ready_at;
  new.served_at    := old.served_at;
  new.cancelled_at := old.cancelled_at;

  if new.payment_status is distinct from old.payment_status then
    if not private.is_trusted_backend() then
      raise exception 'Only the trusted backend may change payment_status'
        using errcode = 'insufficient_privilege';
    end if;
    if not private.payment_status_transition_allowed(old.payment_status, new.payment_status) then
      raise exception 'Invalid payment status change % -> %', old.payment_status, new.payment_status
        using errcode = 'check_violation';
    end if;
  end if;

  if new.status is distinct from old.status then
    if not private.order_status_transition_allowed(old.status, new.status) then
      raise exception 'Invalid order status change % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;

    if new.status = 'CANCELLED'::public.order_status then
      if not (private.is_manager() or private.is_trusted_backend()) then
        raise exception 'Only a manager can cancel an order' using errcode = 'insufficient_privilege';
      end if;
      if new.cancel_reason is null or char_length(btrim(new.cancel_reason)) = 0 then
        raise exception 'A reason is required to cancel an order' using errcode = 'check_violation';
      end if;
    elsif new.payment_status <> 'PAID'::public.payment_status then
      -- Never advance preparation on an order whose payment is not (or no longer) settled.
      raise exception 'Cannot move an order forward while payment_status is %', new.payment_status
        using errcode = 'check_violation';
    end if;

    case new.status
      when 'ACCEPTED'  then new.accepted_at  := now();
      when 'PREPARING' then new.preparing_at := now();
      when 'READY'     then new.ready_at     := now();
      when 'SERVED'    then new.served_at    := now();
      when 'CANCELLED' then new.cancelled_at := now();
      else null;
    end case;
  elsif new.cancel_reason is distinct from old.cancel_reason then
    raise exception 'cancel_reason can only be set while cancelling' using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger orders_before_update
  before update on public.orders
  for each row execute function private.orders_before_update();

-- Orders are never deleted: cancel (and refund) them instead.
create trigger orders_no_delete
  before delete on public.orders
  for each row execute function private.reject_mutation();

-- ---------------------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------------------

create table public.order_events (
  id            bigint generated always as identity primary key,
  order_id      uuid not null references public.orders (id) on delete restrict,
  event_type    text not null,
  from_value    text,
  to_value      text,
  -- Staff auth user id when a signed-in staff member caused the change; NULL for the system.
  actor_user_id uuid,
  actor_kind    text not null,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint order_events_type check (
    event_type in ('ORDER_PLACED', 'STATUS_CHANGED', 'PAYMENT_STATUS_CHANGED')
  ),
  constraint order_events_actor_kind check (actor_kind in ('staff', 'system')),
  constraint order_events_metadata_is_object check (jsonb_typeof(metadata) = 'object')
);
create index order_events_order_idx on public.order_events (order_id, created_at);

create trigger order_events_append_only
  before update or delete on public.order_events
  for each row execute function private.reject_mutation();

-- SECURITY DEFINER so staff, who have no INSERT right on order_events, still produce an
-- audit row whenever they change an order. The history cannot be skipped or forged.
create function private.audit_order_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_kind  text := case when (select auth.uid()) is null then 'system' else 'staff' end;
begin
  if new.status is distinct from old.status then
    insert into public.order_events (order_id, event_type, from_value, to_value,
                                     actor_user_id, actor_kind, metadata)
    values (new.id, 'STATUS_CHANGED', old.status::text, new.status::text, v_actor, v_kind,
            case when new.cancel_reason is not null
                 then jsonb_build_object('cancel_reason', new.cancel_reason)
                 else '{}'::jsonb end);
  end if;

  if new.payment_status is distinct from old.payment_status then
    insert into public.order_events (order_id, event_type, from_value, to_value,
                                     actor_user_id, actor_kind)
    values (new.id, 'PAYMENT_STATUS_CHANGED', old.payment_status::text,
            new.payment_status::text, v_actor, v_kind);
  end if;
  return null;
end;
$$;

create trigger orders_audit
  after update on public.orders
  for each row execute function private.audit_order_changes();

-- ---------------------------------------------------------------------------------------
-- Supporting tables: order-number counter, webhook inbox, rate limiting
-- ---------------------------------------------------------------------------------------

-- One row per business day. Incremented inside the order-creating transaction under the row
-- lock taken by INSERT ... ON CONFLICT DO UPDATE, so numbers are unique, gapless on rollback
-- (the increment rolls back with the order) and safe under concurrency.
create table public.order_counters (
  business_date date primary key,
  last_seq      integer not null default 0,
  constraint order_counters_last_seq_nonnegative check (last_seq >= 0)
);

-- Inbox of payment-gateway webhook events, keyed by the gateway's own event id. Inserting
-- with ON CONFLICT DO NOTHING tells the webhook handler an event is a duplicate delivery.
create table public.gateway_events (
  id                uuid primary key default gen_random_uuid(),
  gateway           text not null default 'razorpay',
  event_id          text not null,
  event_type        text not null,
  payload           jsonb not null,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  processing_result text,
  constraint gateway_events_gateway check (gateway = 'razorpay'),
  constraint gateway_events_event_unique unique (gateway, event_id),
  constraint gateway_events_event_id_length check (char_length(event_id) between 1 and 128),
  constraint gateway_events_event_type_length check (char_length(event_type) between 1 and 100),
  constraint gateway_events_result_length check (char_length(processing_result) <= 300)
);
create index gateway_events_received_idx on public.gateway_events (received_at);

-- Fixed-window rate-limit counters for public endpoints (see public.check_rate_limit).
-- `bucket` is a server-side hash of route + client identity; raw IP addresses are not stored.
create table public.rate_limits (
  bucket         text not null,
  window_start   timestamptz not null,
  window_seconds integer not null,
  hits           integer not null default 0,
  primary key (bucket, window_start),
  constraint rate_limits_bucket_length check (char_length(bucket) between 1 and 200),
  constraint rate_limits_window_positive check (window_seconds between 1 and 86400),
  constraint rate_limits_hits_nonnegative check (hits >= 0)
);
create index rate_limits_window_start_idx on public.rate_limits (window_start);
