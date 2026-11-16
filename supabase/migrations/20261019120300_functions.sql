-- Sandwich Express, Phase 1, migration 4/6: order numbering, payment finalisation and
-- rate limiting.
--
-- IMPORTANT: public.finalize_paid_order() is NOT a payment verifier. It trusts its caller.
-- The caller (the server, using the service-role key) must FIRST verify with Razorpay that
-- the payment belongs to the expected gateway order, has the expected amount and currency,
-- and is captured/successful, via signature verification or the Razorpay API. EXECUTE is
-- granted only to service_role in migration 5; anonymous and signed-in users cannot call it.

-- ---------------------------------------------------------------------------------------
-- Order numbers
-- ---------------------------------------------------------------------------------------

-- 1 -> SE-001, 42 -> SE-042, 1000 -> SE-1000. (lpad() would truncate 1000 to "100".)
create function private.format_order_number(p_prefix text, p_seq integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_prefix || '-' ||
    case when p_seq < 1000 then lpad(p_seq::text, 3, '0') else p_seq::text end
$$;

-- Atomically claims the next number for a business day. INSERT ... ON CONFLICT DO UPDATE
-- takes a row lock that is held until the surrounding transaction ends, so concurrent
-- finalisations queue up and each gets a distinct number. If the order insert later fails,
-- the whole transaction (including this increment) rolls back: no gaps and no duplicates.
create function private.next_order_seq(p_business_date date)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_seq integer;
begin
  insert into public.order_counters as oc (business_date, last_seq)
  values (p_business_date, 1)
  on conflict (business_date) do update set last_seq = oc.last_seq + 1
  returning oc.last_seq into v_seq;
  return v_seq;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Finalise a paid order
-- ---------------------------------------------------------------------------------------
-- Idempotent and race-safe:
--   * The attempt row is locked FOR UPDATE, so concurrent calls for the same attempt
--     (a webhook racing the browser's verify call, or a webhook retry) are serialised.
--   * orders.payment_attempt_id is UNIQUE and so is the gateway payment id on the attempt, so
--     even a bug here cannot produce two orders for one attempt or reuse one payment twice.
--   * A repeated call with the same payment id returns the existing order (created = false).
--     A call with a DIFFERENT payment id for an already-finalised attempt is rejected.
--
-- An attempt that is no longer PENDING (expired / cancelled) is refused with SQLSTATE 55000
-- so the backend can decide what to do with money that was captured late (refund flow).

create function public.finalize_paid_order(
  p_attempt_id         uuid,
  p_gateway_payment_id text
)
returns table (
  out_order_id      uuid,
  out_order_number  text,
  out_business_date date,
  out_created       boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt   public.payment_attempts%rowtype;
  v_order     public.orders%rowtype;
  v_settings  public.cafe_settings%rowtype;
  v_payment   text := btrim(p_gateway_payment_id);
  v_problem   text;
  v_date      date;
  v_seq       integer;
  v_number    text;
  v_order_id  uuid;
  v_line      smallint := 0;
  v_item      jsonb;
  v_opt_sum   bigint;
begin
  if p_attempt_id is null or v_payment is null or char_length(v_payment) = 0 then
    raise exception 'p_attempt_id and p_gateway_payment_id are required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Serialise everything that concerns this attempt.
  select * into v_attempt
  from public.payment_attempts pa
  where pa.id = p_attempt_id
  for update;

  if not found then
    raise exception 'Payment attempt % not found', p_attempt_id using errcode = 'no_data_found';
  end if;

  -- Idempotent replay.
  select * into v_order from public.orders o where o.payment_attempt_id = v_attempt.id;
  if found then
    if v_attempt.gateway_payment_id is distinct from v_payment then
      raise exception 'Attempt % was already finalised by a different payment', p_attempt_id
        using errcode = 'restrict_violation';
    end if;
    return query select v_order.id, v_order.order_number, v_order.business_date, false;
    return;
  end if;

  if v_attempt.status <> 'PENDING'::public.payment_status then
    raise exception 'Payment attempt % is %, not payable', p_attempt_id, v_attempt.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_problem := private.cart_snapshot_problem(v_attempt.cart_snapshot, v_attempt.amount_paise);
  if v_problem is null and (v_attempt.cart_snapshot #>> '{table,id}')::uuid <> v_attempt.table_id then
    v_problem := 'snapshot table does not match the attempt table';
  end if;
  if v_problem is not null then
    raise exception 'Invalid cart snapshot: %', v_problem using errcode = 'check_violation';
  end if;

  select * into v_settings from public.cafe_settings cs where cs.id = 1;
  v_date   := (now() at time zone v_settings.timezone)::date;
  v_seq    := private.next_order_seq(v_date);
  v_number := private.format_order_number(v_settings.order_number_prefix, v_seq);

  insert into public.orders (
    business_date, daily_seq, order_number, payment_attempt_id, tracking_token_hash,
    table_id, table_code, table_label, customer_name, special_instructions,
    status, payment_status, total_paise, currency
  )
  values (
    v_date, v_seq, v_number, v_attempt.id, v_attempt.tracking_token_hash,
    v_attempt.table_id,
    btrim(v_attempt.cart_snapshot #>> '{table,code}'),
    btrim(v_attempt.cart_snapshot #>> '{table,label}'),
    nullif(btrim(v_attempt.cart_snapshot ->> 'customer_name'), ''),
    nullif(btrim(v_attempt.cart_snapshot ->> 'special_instructions'), ''),
    'NEW', 'PAID', v_attempt.amount_paise, v_attempt.currency
  )
  returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(v_attempt.cart_snapshot -> 'items') loop
    v_line := v_line + 1;

    select coalesce(sum((opt ->> 'price_delta_paise')::bigint), 0)
      into v_opt_sum
    from jsonb_array_elements(v_item -> 'options') as opt;

    insert into public.order_items (
      order_id, line_no, menu_item_id, item_name, unit_price_paise,
      options, options_unit_paise, quantity, line_total_paise, note
    )
    values (
      v_order_id, v_line,
      (v_item ->> 'menu_item_id')::uuid,
      btrim(v_item ->> 'item_name'),
      (v_item ->> 'unit_price_paise')::integer,
      v_item -> 'options',
      v_opt_sum::integer,
      (v_item ->> 'quantity')::smallint,
      (((v_item ->> 'unit_price_paise')::bigint + v_opt_sum) * (v_item ->> 'quantity')::bigint)::integer,
      nullif(btrim(v_item ->> 'note'), '')
    );
  end loop;

  update public.payment_attempts
     set status = 'PAID',
         gateway_payment_id = v_payment,
         paid_at = now()
   where id = v_attempt.id;

  insert into public.order_events (order_id, event_type, to_value, actor_kind, metadata)
  values (v_order_id, 'ORDER_PLACED', 'NEW', 'system',
          jsonb_build_object('payment_attempt_id', v_attempt.id,
                             'gateway_payment_id', v_payment));

  return query select v_order_id, v_number, v_date, true;
end;
$$;

comment on function public.finalize_paid_order(uuid, text) is
  'Creates the paid order for a payment attempt. Idempotent. Service role only. The caller must have verified the payment with Razorpay first; this function does not.';

-- ---------------------------------------------------------------------------------------
-- Menu items that customers are in the middle of paying for must not vanish
-- ---------------------------------------------------------------------------------------
-- Ordered items are already protected by the order_items foreign key (RESTRICT). This closes
-- the window between "payment attempt created" and "order created": deleting an item that a
-- PENDING attempt references would make finalisation fail after the customer has paid.
-- Archive items (is_active = false) instead of deleting them.

-- SECURITY DEFINER: the deleting manager has no SELECT on payment_attempts.cart_snapshot, and
-- the check must see every attempt regardless of the caller's privileges.
create function private.guard_menu_item_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.payment_attempts pa
    where pa.status = 'PENDING'::public.payment_status
      and jsonb_path_exists(
        pa.cart_snapshot,
        '$.items[*] ? (@.menu_item_id == $id)',
        jsonb_build_object('id', old.id::text)
      )
  ) then
    raise exception 'Menu item % is in an unpaid checkout; archive it instead of deleting', old.id
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

create trigger menu_items_guard_delete
  before delete on public.menu_items
  for each row execute function private.guard_menu_item_delete();

-- ---------------------------------------------------------------------------------------
-- Rate limiting for public endpoints
-- ---------------------------------------------------------------------------------------
-- Fixed-window counter. Returns TRUE if the request is allowed, FALSE once `p_limit` hits
-- have been seen in the current window. The caller builds `p_bucket` from the route and a
-- salted hash of the client identity; no raw IP address is stored.

create function public.check_rate_limit(
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_hits  integer;
begin
  if p_bucket is null or p_limit < 1 or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid rate limit parameters' using errcode = 'invalid_parameter_value';
  end if;

  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limits as rl (bucket, window_start, window_seconds, hits)
  values (p_bucket, v_start, p_window_seconds, 1)
  on conflict (bucket, window_start) do update set hits = rl.hits + 1
  returning rl.hits into v_hits;

  return v_hits <= p_limit;
end;
$$;

-- Housekeeping: drop windows older than a day. Safe to run on a schedule.
create function public.purge_expired_rate_limits()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
