-- Sandwich Express, Phase 1, migration 5/6: Row Level Security, grants and function privileges.
--
-- Security model
--   anon            Unauthenticated visitors (customers). May read ONLY the public menu and a few
--                   public settings. No access at all to orders, payments, staff or tables.
--                   Customers never talk to the database directly for orders: ordering, tracking
--                   and table lookup go through validated server endpoints that use service_role.
--   authenticated   Signed-in users. In this app these are staff only (sign-up is disabled).
--                   What they may do depends on their staff_profiles row:
--                     manager  everything staff can do + menu/price/table/settings/staff management
--                              and cancelling orders.
--                     counter  read orders, move orders through preparation, flip item availability.
--                   A signed-in user WITHOUT an active staff profile can read the public menu and
--                   nothing else.
--   service_role    The trusted backend (bypasses RLS). Its key is used only in server-only code.
--
-- Defence in depth: RLS decides which ROWS a role may touch, column-level grants decide which
-- COLUMNS, and triggers (migrations 2 and 3) enforce the finer rules (status machine, counter
-- availability-only edits, immutable snapshots).

-- ---------------------------------------------------------------------------------------
-- 0. Stop Supabase's default "grant everything to API roles" from applying to future objects
-- ---------------------------------------------------------------------------------------

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------------------------------
-- 1. Row Level Security on every table, and a clean slate of grants
-- ---------------------------------------------------------------------------------------

alter table public.staff_profiles             enable row level security;
alter table public.cafe_settings              enable row level security;
alter table public.cafe_tables                enable row level security;
alter table public.menu_categories            enable row level security;
alter table public.menu_items                 enable row level security;
alter table public.modifier_groups            enable row level security;
alter table public.modifier_options           enable row level security;
alter table public.menu_item_modifier_groups  enable row level security;
alter table public.payment_attempts           enable row level security;
alter table public.orders                     enable row level security;
alter table public.order_items                enable row level security;
alter table public.order_events               enable row level security;
alter table public.order_counters             enable row level security;
alter table public.gateway_events             enable row level security;
alter table public.rate_limits                enable row level security;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- The trusted backend needs full access (it bypasses RLS but still needs table privileges).
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------------------
-- 2. The private schema: reachable by signed-in staff and the backend only
-- ---------------------------------------------------------------------------------------

grant usage on schema private to authenticated, service_role;

revoke all on all functions in schema private from public, anon, authenticated;

-- Called from RLS policies and from triggers that run as the signed-in user.
grant execute on function private.current_staff_role()                      to authenticated, service_role;
grant execute on function private.is_staff()                                to authenticated, service_role;
grant execute on function private.is_manager()                              to authenticated, service_role;
grant execute on function private.is_trusted_backend()                      to authenticated, service_role;
grant execute on function private.order_status_transition_allowed(public.order_status, public.order_status)
  to authenticated, service_role;
grant execute on function private.payment_status_transition_allowed(public.payment_status, public.payment_status)
  to authenticated, service_role;
-- Called by the payment_attempts trigger when the backend inserts an attempt.
grant execute on function private.cart_snapshot_problem(jsonb, integer)     to service_role;

-- ---------------------------------------------------------------------------------------
-- 3. Public RPC functions: service_role only
-- ---------------------------------------------------------------------------------------

grant execute on function public.finalize_paid_order(uuid, text)            to service_role;
grant execute on function public.check_rate_limit(text, integer, integer)   to service_role;
grant execute on function public.purge_expired_rate_limits()                to service_role;

-- ---------------------------------------------------------------------------------------
-- 4. staff_profiles
-- ---------------------------------------------------------------------------------------
-- Staff see their own profile; managers see everyone. Only managers edit, and only these
-- columns. Accounts are created and removed by the backend (service_role), never from the
-- browser, so there is no INSERT or DELETE grant.

grant select on public.staff_profiles to authenticated;
grant update (display_name, role, is_active) on public.staff_profiles to authenticated;

create policy staff_profiles_select on public.staff_profiles
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_manager()));

create policy staff_profiles_update on public.staff_profiles
  for update to authenticated
  using ((select private.is_manager()))
  with check ((select private.is_manager()));

-- ---------------------------------------------------------------------------------------
-- 5. cafe_settings
-- ---------------------------------------------------------------------------------------
-- Customers may read only the columns needed to render the menu. NOTE: because grants are
-- column-level, `select *` is denied for anon; clients must name the columns.

grant select (id, cafe_name, currency, orders_enabled, max_item_quantity, max_items_per_order)
  on public.cafe_settings to anon;
grant select on public.cafe_settings to authenticated;
grant update (cafe_name, orders_enabled, max_item_quantity, max_items_per_order,
              payment_attempt_ttl_minutes, timezone, order_number_prefix)
  on public.cafe_settings to authenticated;

create policy cafe_settings_select_public on public.cafe_settings
  for select to anon
  using (true);

create policy cafe_settings_select_staff on public.cafe_settings
  for select to authenticated
  using ((select private.is_staff()));

create policy cafe_settings_update on public.cafe_settings
  for update to authenticated
  using ((select private.is_manager()))
  with check ((select private.is_manager()));

-- ---------------------------------------------------------------------------------------
-- 6. cafe_tables: staff read, managers manage. Never readable by anon.
-- ---------------------------------------------------------------------------------------
-- Customers resolve a QR code through a server endpoint (rate limited, service_role) that
-- returns only the table label, so tables cannot be enumerated or created from the browser.

grant select, insert, update, delete on public.cafe_tables to authenticated;

create policy cafe_tables_select on public.cafe_tables
  for select to authenticated
  using ((select private.is_staff()));

create policy cafe_tables_insert on public.cafe_tables
  for insert to authenticated
  with check ((select private.is_manager()));

create policy cafe_tables_update on public.cafe_tables
  for update to authenticated
  using ((select private.is_manager()))
  with check ((select private.is_manager()));

create policy cafe_tables_delete on public.cafe_tables
  for delete to authenticated
  using ((select private.is_manager()));

-- ---------------------------------------------------------------------------------------
-- 7. Menu: public read of active rows, staff read of everything, manager writes,
--    counter staff may update availability only (column rule enforced by trigger)
-- ---------------------------------------------------------------------------------------

grant select (id, slug, name, description, sort_order, is_active)
  on public.menu_categories to anon;
grant select (id, category_id, slug, name, description, ingredients, dietary_tags, price_paise,
              image_path, sort_order, is_active, is_available)
  on public.menu_items to anon;
grant select (id, slug, name, min_select, max_select, sort_order, is_active)
  on public.modifier_groups to anon;
grant select (id, group_id, name, price_delta_paise, is_default, sort_order, is_active, is_available)
  on public.modifier_options to anon;
grant select (item_id, group_id, sort_order)
  on public.menu_item_modifier_groups to anon;

grant select, insert, update, delete on public.menu_categories           to authenticated;
grant select, insert, update, delete on public.menu_items                to authenticated;
grant select, insert, update, delete on public.modifier_groups           to authenticated;
grant select, insert, update, delete on public.modifier_options          to authenticated;
grant select, insert, update, delete on public.menu_item_modifier_groups to authenticated;

-- 7a. Public read (anon, and signed-in users in general): active rows only.
create policy menu_categories_public_read on public.menu_categories
  for select to anon, authenticated
  using (is_active);

create policy menu_items_public_read on public.menu_items
  for select to anon, authenticated
  using (
    is_active
    and exists (
      select 1 from public.menu_categories c
      where c.id = menu_items.category_id and c.is_active
    )
  );

create policy modifier_groups_public_read on public.modifier_groups
  for select to anon, authenticated
  using (is_active);

create policy modifier_options_public_read on public.modifier_options
  for select to anon, authenticated
  using (
    is_active
    and exists (
      select 1 from public.modifier_groups g
      where g.id = modifier_options.group_id and g.is_active
    )
  );

create policy menu_item_modifier_groups_public_read on public.menu_item_modifier_groups
  for select to anon, authenticated
  using (
    exists (select 1 from public.menu_items i
            where i.id = menu_item_modifier_groups.item_id and i.is_active)
    and exists (select 1 from public.modifier_groups g
                where g.id = menu_item_modifier_groups.group_id and g.is_active)
  );

-- 7b. Staff can read everything, including archived and unavailable rows.
create policy menu_categories_staff_read on public.menu_categories
  for select to authenticated using ((select private.is_staff()));
create policy menu_items_staff_read on public.menu_items
  for select to authenticated using ((select private.is_staff()));
create policy modifier_groups_staff_read on public.modifier_groups
  for select to authenticated using ((select private.is_staff()));
create policy modifier_options_staff_read on public.modifier_options
  for select to authenticated using ((select private.is_staff()));
create policy menu_item_modifier_groups_staff_read on public.menu_item_modifier_groups
  for select to authenticated using ((select private.is_staff()));

-- 7c. Managers create and delete menu rows and edit any column.
create policy menu_categories_manager_insert on public.menu_categories
  for insert to authenticated with check ((select private.is_manager()));
create policy menu_categories_manager_update on public.menu_categories
  for update to authenticated
  using ((select private.is_manager())) with check ((select private.is_manager()));
create policy menu_categories_manager_delete on public.menu_categories
  for delete to authenticated using ((select private.is_manager()));

create policy menu_items_manager_insert on public.menu_items
  for insert to authenticated with check ((select private.is_manager()));
create policy menu_items_staff_update on public.menu_items
  for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));
create policy menu_items_manager_delete on public.menu_items
  for delete to authenticated using ((select private.is_manager()));

create policy modifier_groups_manager_insert on public.modifier_groups
  for insert to authenticated with check ((select private.is_manager()));
create policy modifier_groups_manager_update on public.modifier_groups
  for update to authenticated
  using ((select private.is_manager())) with check ((select private.is_manager()));
create policy modifier_groups_manager_delete on public.modifier_groups
  for delete to authenticated using ((select private.is_manager()));

create policy modifier_options_manager_insert on public.modifier_options
  for insert to authenticated with check ((select private.is_manager()));
create policy modifier_options_staff_update on public.modifier_options
  for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));
create policy modifier_options_manager_delete on public.modifier_options
  for delete to authenticated using ((select private.is_manager()));

create policy menu_item_modifier_groups_manager_insert on public.menu_item_modifier_groups
  for insert to authenticated with check ((select private.is_manager()));
create policy menu_item_modifier_groups_manager_update on public.menu_item_modifier_groups
  for update to authenticated
  using ((select private.is_manager())) with check ((select private.is_manager()));
create policy menu_item_modifier_groups_manager_delete on public.menu_item_modifier_groups
  for delete to authenticated using ((select private.is_manager()));

-- ---------------------------------------------------------------------------------------
-- 8. Orders, items, events and payment references: staff read, narrow staff update
-- ---------------------------------------------------------------------------------------
-- Staff cannot INSERT or DELETE any of these. They can UPDATE exactly two order columns,
-- `status` and `cancel_reason`; the status machine and the manager-only cancel rule are
-- enforced by trigger. payment_status can only be changed by the backend.
-- Realtime note: orders keeps a table-level SELECT grant for staff because Supabase Realtime
-- (postgres_changes) is evaluated against the table's SELECT privilege and RLS policies.

grant select on public.orders        to authenticated;
grant update (status, cancel_reason) on public.orders to authenticated;
grant select on public.order_items   to authenticated;
grant select on public.order_events  to authenticated;

-- Payment references for the history screen. The cart snapshot, the idempotency key and the
-- tracking-token hash are deliberately NOT readable by staff clients.
grant select (id, table_id, amount_paise, currency, status, gateway, gateway_order_id,
              gateway_payment_id, paid_at, failure_reason, expires_at, created_at)
  on public.payment_attempts to authenticated;

create policy orders_staff_select on public.orders
  for select to authenticated using ((select private.is_staff()));

create policy orders_staff_update on public.orders
  for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));

create policy order_items_staff_select on public.order_items
  for select to authenticated using ((select private.is_staff()));

create policy order_events_staff_select on public.order_events
  for select to authenticated using ((select private.is_staff()));

create policy payment_attempts_staff_select on public.payment_attempts
  for select to authenticated using ((select private.is_staff()));

-- ---------------------------------------------------------------------------------------
-- 9. Backend-only tables: RLS on, no policies, no grants to API roles = deny all.
-- ---------------------------------------------------------------------------------------
-- order_counters, gateway_events and rate_limits are reachable only through service_role
-- and the SECURITY DEFINER functions above.
