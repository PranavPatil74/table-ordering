-- Sandwich Express, Phase 1, migration 1/6: foundation.
--
-- Creates the private schema, enum types and generic helper functions.
--
-- Conventions used throughout these migrations
--   * Money is ALWAYS integer paise (1 INR = 100 paise). Never numeric/float/money.
--   * Every table has Row Level Security enabled (migration 5) and explicit grants.
--   * Helper functions live in the `private` schema, which the Supabase Data API does not
--     expose (see `schemas` in supabase/config.toml). Only functions that the trusted backend
--     must call as RPC live in `public`.
--   * Every SECURITY DEFINER function sets `search_path = ''` and schema-qualifies all names.
--   * Migrations are written to be portable to hosted Supabase: they never create the
--     `anon`, `authenticated` or `service_role` roles and never touch the `auth` schema
--     beyond referencing auth.users / auth.uid() / auth.role().

create schema if not exists private;

-- Nobody gets anything in `private` until migration 5 grants it explicitly.
revoke all on schema private from public;

-- ---------------------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------------------

create type public.staff_role as enum ('manager', 'counter');

-- Preparation state of an order. Deliberately separate from payment state.
create type public.order_status as enum (
  'NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'
);

-- Payment state. PENDING/FAILED only ever occur on payment_attempts; an `orders` row can only
-- be PAID, REFUND_PENDING or REFUNDED (enforced by a CHECK constraint on orders).
-- REFUND_PENDING means a refund has been requested but the gateway has not yet confirmed it;
-- REFUNDED may only be set after the payment provider confirms the refund.
create type public.payment_status as enum (
  'PENDING', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED'
);

-- ---------------------------------------------------------------------------------------
-- Generic trigger functions
-- ---------------------------------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Used on append-only tables (audit events) and immutable snapshots (order items).
create function private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% on % is not allowed: this table is append-only', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

comment on schema private is
  'Internal helpers, triggers and counters. Not exposed through the Supabase Data API.';
