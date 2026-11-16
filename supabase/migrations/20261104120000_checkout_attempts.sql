-- =======================================================================================
-- Phase 5: persistent checkout snapshot and payment-attempt creation
-- =======================================================================================
-- No new tables. The Phase 1 `payment_attempts` table already carries everything a saved
-- checkout needs: a UNIQUE idempotency key, the immutable `cart_snapshot` (validated by
-- `private.cart_snapshot_problem` in a BEFORE INSERT trigger), a forced PENDING start, a
-- 32-byte tracking-token hash and an expiry. What was missing is one atomic operation the
-- trusted backend can call, so "create or return the existing attempt" cannot be split into a
-- racy read-then-write in application code.
--
-- Both functions are SERVICE ROLE ONLY. Customers never reach them directly: the Next.js
-- server does its own pricing, rate limiting and table resolution first and passes the result.
-- Neither function creates an order, marks anything PAID or calls finalize_paid_order; the one
-- and only path to a paid order is still finalize_paid_order after verified payment (Phase 6).

-- ---------------------------------------------------------------------------------------
-- create_checkout_attempt
-- ---------------------------------------------------------------------------------------
-- Outcomes (out_outcome):
--   'created'           a new PENDING attempt was inserted by THIS call
--   'existing'          the key already had an attempt with the SAME table, amount and snapshot
--                       (a retry, a double tap, a reload, or a concurrent duplicate that lost the race)
--   'conflict'          the key already has an attempt for a DIFFERENT cart. Nothing is changed and
--                       nothing about the other cart is returned.
--   'table_unavailable' the table does not exist or is not active
--
-- Concurrency: the unique index on idempotency_key is the arbiter. Two simultaneous calls with
-- the same key both run INSERT ... ON CONFLICT DO NOTHING; the second waits for the first to
-- commit (or roll back, in which case it inserts instead), then finds the committed row. Exactly
-- one row can ever exist for a key. Atomicity: the whole function is one statement-level
-- transaction, so a failure (for example an invalid snapshot rejected by the trigger) leaves no
-- partial row.

create function public.create_checkout_attempt(
  p_idempotency_key     text,
  p_table_id            uuid,
  p_amount_paise        integer,
  p_cart_snapshot       jsonb,
  p_tracking_token_hash bytea,
  p_ttl_minutes         integer default 30
)
returns table (
  out_outcome       text,
  out_status        public.payment_status,
  out_amount_paise  integer,
  out_created_at    timestamptz,
  out_expires_at    timestamptz,
  out_order_created boolean,
  out_cart_snapshot jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid;
  v_existing public.payment_attempts%rowtype;
  v_active   boolean;
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 128 then
    raise exception 'invalid idempotency key' using errcode = 'invalid_parameter_value';
  end if;
  if p_ttl_minutes is null or p_ttl_minutes not between 5 and 240 then
    raise exception 'invalid attempt lifetime' using errcode = 'invalid_parameter_value';
  end if;
  if p_table_id is null or p_cart_snapshot is null or p_amount_paise is null
     or p_tracking_token_hash is null then
    raise exception 'missing checkout data' using errcode = 'invalid_parameter_value';
  end if;
  -- The snapshot must describe the table the attempt is saved against.
  if p_cart_snapshot #>> '{table,id}' is distinct from p_table_id::text then
    raise exception 'snapshot table does not match the attempt table'
      using errcode = 'check_violation';
  end if;

  -- A replay is answered from the stored row, even if the table was switched off since.
  select * into v_existing
    from public.payment_attempts
   where idempotency_key = p_idempotency_key;

  if not found then
    -- Share-lock the table so it cannot be deactivated between this check and the insert.
    select t.is_active into v_active
      from public.cafe_tables t
     where t.id = p_table_id
       for share;
    if v_active is distinct from true then
      return query select 'table_unavailable'::text, null::public.payment_status, null::integer,
                          null::timestamptz, null::timestamptz, null::boolean, null::jsonb;
      return;
    end if;

    -- The BEFORE INSERT trigger runs cart_snapshot_problem(): a bad snapshot or a total that
    -- does not equal the amount raises check_violation and nothing is stored.
    insert into public.payment_attempts as pa
      (idempotency_key, table_id, amount_paise, tracking_token_hash, cart_snapshot, expires_at)
    values
      (p_idempotency_key, p_table_id, p_amount_paise, p_tracking_token_hash, p_cart_snapshot,
       now() + make_interval(mins => p_ttl_minutes))
    on conflict (idempotency_key) do nothing
    returning pa.id into v_id;

    if v_id is not null then
      select * into v_existing from public.payment_attempts where id = v_id;
      return query select 'created'::text, v_existing.status, v_existing.amount_paise,
                          v_existing.created_at, v_existing.expires_at, false,
                          v_existing.cart_snapshot;
      return;
    end if;

    -- Lost the race: a concurrent call committed this key first. Read the winner.
    select * into v_existing
      from public.payment_attempts
     where idempotency_key = p_idempotency_key;
  end if;

  if v_existing.table_id is distinct from p_table_id
     or v_existing.amount_paise is distinct from p_amount_paise
     or v_existing.cart_snapshot is distinct from p_cart_snapshot then
    return query select 'conflict'::text, null::public.payment_status, null::integer,
                        null::timestamptz, null::timestamptz, null::boolean, null::jsonb;
    return;
  end if;

  return query select 'existing'::text, v_existing.status, v_existing.amount_paise,
                      v_existing.created_at, v_existing.expires_at,
                      exists (select 1 from public.orders o where o.payment_attempt_id = v_existing.id),
                      v_existing.cart_snapshot;
end;
$$;

comment on function public.create_checkout_attempt(text, uuid, integer, jsonb, bytea, integer) is
  'Atomically creates the PENDING payment attempt for a checkout, or returns the existing one for the same idempotency key. Never creates an order or marks anything paid. Service role only.';

-- ---------------------------------------------------------------------------------------
-- get_checkout_attempt: read one saved checkout by its idempotency key (service role only)
-- ---------------------------------------------------------------------------------------
-- Used when a customer revisits or reloads the checkout screen. The key is a random UUID held
-- only by that customer's browser; the server additionally checks the table before showing it.
-- Returns no rows when the key is unknown.

create function public.get_checkout_attempt(p_idempotency_key text)
returns table (
  out_status        public.payment_status,
  out_amount_paise  integer,
  out_created_at    timestamptz,
  out_expires_at    timestamptz,
  out_order_created boolean,
  out_cart_snapshot jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.status, a.amount_paise, a.created_at, a.expires_at,
         exists (select 1 from public.orders o where o.payment_attempt_id = a.id),
         a.cart_snapshot
    from public.payment_attempts a
   where a.idempotency_key = p_idempotency_key
$$;

comment on function public.get_checkout_attempt(text) is
  'Reads one saved checkout by idempotency key. Service role only.';

-- ---------------------------------------------------------------------------------------
-- Grants: new public functions default to EXECUTE for PUBLIC, so revoke it explicitly.
-- ---------------------------------------------------------------------------------------

revoke all on function public.create_checkout_attempt(text, uuid, integer, jsonb, bytea, integer)
  from public, anon, authenticated;
revoke all on function public.get_checkout_attempt(text) from public, anon, authenticated;

grant execute on function public.create_checkout_attempt(text, uuid, integer, jsonb, bytea, integer)
  to service_role;
grant execute on function public.get_checkout_attempt(text) to service_role;
