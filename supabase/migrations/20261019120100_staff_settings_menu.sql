-- Sandwich Express, Phase 1, migration 2/6: staff, settings, tables, menu and modifiers.
-- (RLS and grants for these tables are in migration 5.)

-- ---------------------------------------------------------------------------------------
-- Staff profiles and roles
-- ---------------------------------------------------------------------------------------
-- One row per staff member. The Supabase Auth user is created by an administrator (public
-- sign-up is disabled); this row grants that user a role. Deleting the auth user removes
-- the profile. Customers never have a profile.

create table public.staff_profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  role         public.staff_role not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint staff_profiles_display_name_length
    check (char_length(btrim(display_name)) between 1 and 80)
);

create trigger staff_profiles_set_updated_at
  before update on public.staff_profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------------------
-- SECURITY DEFINER so that RLS policies on staff_profiles itself can use them without
-- infinite recursion. They answer questions about the CALLER only (auth.uid()).

create function private.current_staff_role()
returns public.staff_role
language sql
stable
security definer
set search_path = ''
as $$
  select sp.role
  from public.staff_profiles sp
  where sp.user_id = (select auth.uid())
    and sp.is_active
$$;

create function private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_staff_role() is not null
$$;

create function private.is_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_staff_role() = 'manager'::public.staff_role, false)
$$;

-- True for the trusted backend: the Supabase service role, or an administrator connecting
-- directly (migrations, SQL editor). SECURITY INVOKER on purpose: current_user must be the
-- caller, not the function owner.
create function private.is_trusted_backend()
returns boolean
language sql
stable
set search_path = ''
as $$
  select current_user in ('service_role', 'postgres', 'supabase_admin')
$$;

-- Never let the cafe be left without an active manager, even through concurrent edits.
-- SECURITY DEFINER so that row-level security can never hide other managers from the count.
create function private.guard_last_active_manager()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'manager'::public.staff_role and old.is_active then
    if tg_op = 'DELETE'
       or new.role <> 'manager'::public.staff_role
       or not new.is_active then
      -- Serialise concurrent demotions so two managers cannot remove each other.
      perform pg_advisory_xact_lock(hashtext('sandwich_express.last_manager_guard'));
      if not exists (
        select 1
        from public.staff_profiles sp
        where sp.role = 'manager'::public.staff_role
          and sp.is_active
          and sp.user_id <> old.user_id
      ) then
        raise exception 'At least one active manager must remain'
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger staff_profiles_guard_last_manager
  before update or delete on public.staff_profiles
  for each row execute function private.guard_last_active_manager();

-- ---------------------------------------------------------------------------------------
-- Cafe settings (exactly one row)
-- ---------------------------------------------------------------------------------------

create table public.cafe_settings (
  id                          smallint primary key default 1,
  cafe_name                   text not null default 'Sandwich Express',
  currency                    char(3) not null default 'INR',
  -- Master switch: false pauses all new customer orders.
  orders_enabled              boolean not null default true,
  max_item_quantity           smallint not null default 10,
  max_items_per_order         smallint not null default 30,
  -- How long a customer has to complete payment before the attempt expires.
  payment_attempt_ttl_minutes smallint not null default 30,
  -- Order numbers restart every day in this time zone.
  timezone                    text not null default 'Asia/Kolkata',
  order_number_prefix         text not null default 'SE',
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint cafe_settings_singleton check (id = 1),
  constraint cafe_settings_cafe_name_length check (char_length(btrim(cafe_name)) between 1 and 80),
  constraint cafe_settings_currency check (currency = 'INR'),
  constraint cafe_settings_max_item_quantity check (max_item_quantity between 1 and 50),
  constraint cafe_settings_max_items_per_order check (max_items_per_order between 1 and 50),
  constraint cafe_settings_attempt_ttl check (payment_attempt_ttl_minutes between 5 and 240),
  constraint cafe_settings_order_number_prefix check (order_number_prefix ~ '^[A-Z]{1,5}$'),
  -- Rejects unknown time zone names (timezone() raises for an invalid zone).
  constraint cafe_settings_timezone_valid check (timezone(timezone, now()) is not null)
);

create trigger cafe_settings_set_updated_at
  before update on public.cafe_settings
  for each row execute function private.set_updated_at();

-- Configuration, not demo data: every environment needs this row.
insert into public.cafe_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------
-- Cafe tables and QR identifiers
-- ---------------------------------------------------------------------------------------
-- `code` is the identifier embedded in the QR link (<origin>/menu?table=T05). It is NOT a
-- credential: knowing a code only lets someone start an order for that table, and an order
-- still has to be paid for. Rows are created only by a manager, never by a customer request.
-- Tables that have orders can never be deleted (orders.table_id is RESTRICT): deactivate them.

create table public.cafe_tables (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  label      text not null,
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cafe_tables_code_unique unique (code),
  constraint cafe_tables_code_format check (code ~ '^[A-Z][A-Z0-9_-]{1,15}$'),
  constraint cafe_tables_label_length check (char_length(btrim(label)) between 1 and 40)
);

create trigger cafe_tables_set_updated_at
  before update on public.cafe_tables
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------------------
-- Menu categories and items
-- ---------------------------------------------------------------------------------------
-- `is_active`    = shown on the menu at all (false = archived / hidden).
-- `is_available` = can be ordered right now (false = shown as "sold out").
-- `slug` gives seed data and URLs a stable key that survives renames.

create table public.menu_categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null,
  name        text not null,
  description text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint menu_categories_slug_unique unique (slug),
  constraint menu_categories_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint menu_categories_name_length check (char_length(btrim(name)) between 1 and 80),
  constraint menu_categories_description_length check (char_length(description) <= 500)
);
create unique index menu_categories_name_lower_unique on public.menu_categories (lower(name));

create trigger menu_categories_set_updated_at
  before update on public.menu_categories
  for each row execute function private.set_updated_at();

create table public.menu_items (
  id            uuid primary key default gen_random_uuid(),
  category_id   uuid not null references public.menu_categories (id) on delete restrict,
  slug          text not null,
  name          text not null,
  description   text,
  ingredients   text,
  dietary_tags  text[] not null default '{}',
  -- Integer paise. The menu price is authoritative; the server prices every order from here.
  price_paise   integer not null,
  -- Path of an image in Supabase Storage (set from the menu admin in a later phase).
  image_path    text,
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  is_available  boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint menu_items_slug_unique unique (slug),
  constraint menu_items_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint menu_items_name_length check (char_length(btrim(name)) between 1 and 80),
  constraint menu_items_description_length check (char_length(description) <= 500),
  constraint menu_items_ingredients_length check (char_length(ingredients) <= 500),
  constraint menu_items_price_paise_range check (price_paise between 0 and 10000000),
  constraint menu_items_dietary_tags_allowed check (
    dietary_tags <@ array[
      'veg', 'vegan', 'egg', 'non-veg', 'spicy',
      'contains-dairy', 'contains-gluten', 'contains-nuts'
    ]::text[]
  ),
  constraint menu_items_image_path_length check (char_length(image_path) <= 300)
);
create unique index menu_items_category_name_lower_unique
  on public.menu_items (category_id, lower(name));
create index menu_items_category_sort_idx on public.menu_items (category_id, sort_order);

create trigger menu_items_set_updated_at
  before update on public.menu_items
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------------------
-- Modifier groups (e.g. Bread, Sauces, Extras) and options, shared between items
-- ---------------------------------------------------------------------------------------
-- A group can be attached to many items, so changing the price of "Extra cheese" happens
-- in one place. min_select >= 1 makes a group required; max_select = 1 makes it single-choice.

create table public.modifier_groups (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null,
  name       text not null,
  min_select smallint not null default 0,
  max_select smallint not null default 1,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint modifier_groups_slug_unique unique (slug),
  constraint modifier_groups_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint modifier_groups_name_length check (char_length(btrim(name)) between 1 and 80),
  constraint modifier_groups_select_bounds check (
    min_select >= 0 and max_select >= 1 and max_select >= min_select and max_select <= 20
  )
);
create unique index modifier_groups_name_lower_unique on public.modifier_groups (lower(name));

create trigger modifier_groups_set_updated_at
  before update on public.modifier_groups
  for each row execute function private.set_updated_at();

create table public.modifier_options (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references public.modifier_groups (id) on delete cascade,
  name             text not null,
  -- Extra cost per unit, in integer paise. Never negative.
  price_delta_paise integer not null default 0,
  is_default       boolean not null default false,
  sort_order       integer not null default 0,
  is_active        boolean not null default true,
  is_available     boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint modifier_options_name_length check (char_length(btrim(name)) between 1 and 80),
  constraint modifier_options_price_delta_range check (price_delta_paise between 0 and 1000000)
);
create unique index modifier_options_group_name_lower_unique
  on public.modifier_options (group_id, lower(name));
create index modifier_options_group_sort_idx on public.modifier_options (group_id, sort_order);

create trigger modifier_options_set_updated_at
  before update on public.modifier_options
  for each row execute function private.set_updated_at();

create table public.menu_item_modifier_groups (
  item_id    uuid not null references public.menu_items (id) on delete cascade,
  group_id   uuid not null references public.modifier_groups (id) on delete restrict,
  sort_order integer not null default 0,
  primary key (item_id, group_id)
);
create index menu_item_modifier_groups_group_idx on public.menu_item_modifier_groups (group_id);

-- ---------------------------------------------------------------------------------------
-- Counter staff may only flip availability ("sold out"); everything else on the menu,
-- prices above all, is manager-only. RLS decides WHO may update a row; this trigger decides
-- WHICH COLUMNS a non-manager may change.
-- ---------------------------------------------------------------------------------------

create function private.guard_counter_menu_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.is_trusted_backend() or private.is_manager() then
    return new;
  end if;

  if (to_jsonb(new) - 'is_available' - 'updated_at')
     is distinct from (to_jsonb(old) - 'is_available' - 'updated_at') then
    raise exception 'Only managers can change %. Counter staff may only change availability.',
      tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger menu_items_guard_counter_update
  before update on public.menu_items
  for each row execute function private.guard_counter_menu_update();

create trigger modifier_options_guard_counter_update
  before update on public.modifier_options
  for each row execute function private.guard_counter_menu_update();
