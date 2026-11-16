-- READ-ONLY diagnostic: leftover `pnpm test:supabase` menu fixtures and what references them.
-- Safe to paste into Supabase Studio's SQL editor (local stack). It only SELECTs: no INSERT,
-- UPDATE, DELETE or DDL, and it never selects payment-attempt snapshots (they can hold a
-- customer's name or note) or any customer data: only counts.
--
-- A category is listed when its slug is `it-<6 hex>-cat` and its name is exactly
-- `IT <same 6 hex> Category` (what src/supabase-it/harness.ts creates). `is_fixture_item` and
-- `has_test_table` show the corroboration `pnpm cleanup:test-menu` requires before it touches
-- anything; a category with any `is_fixture_item = false` row is left alone by the tool.
select
  fc.name                                   as category,
  fc.is_active                              as category_active,
  i.name                                    as item,
  i.price_paise,
  i.is_active                               as item_active,
  i.id                                      as item_id,
  (select count(*) from public.order_items oi
    where oi.menu_item_id = i.id)           as order_history_lines,
  (select count(*) from public.payment_attempts pa
    where pa.status = 'PENDING'::public.payment_status
      and pa.cart_snapshot @> jsonb_build_object('items',
            jsonb_build_array(jsonb_build_object('menu_item_id', i.id))))
                                            as unpaid_checkouts,
  (select count(*) from public.payment_attempts pa
    where pa.status <> 'PENDING'::public.payment_status
      and pa.cart_snapshot @> jsonb_build_object('items',
            jsonb_build_array(jsonb_build_object('menu_item_id', i.id))))
                                            as other_attempts,
  ((i.slug, i.name, i.price_paise) in (
      ('it-' || fc.tag || '-sandwich', 'Grilled Sandwich', 14900),
      ('it-' || fc.tag || '-coffee',   'Cold Coffee',      11900),
      ('it-' || fc.tag || '-archived', 'Archived item',      100),
      ('it-' || fc.tag || '-soldout',  'Sold out item',      100)))
                                            as is_fixture_item,
  exists (select 1 from public.cafe_tables t
           where t.code = 'IT' || upper(fc.tag)
             and t.label = 'IT table ' || fc.tag)
                                            as has_test_table,
  fc.created_at                             as category_created_at
from (
  select c.*, substring(c.slug from '^it-([0-9a-f]{6})-cat$') as tag
    from public.menu_categories c
   where c.slug ~ '^it-[0-9a-f]{6}-cat$'
     and c.name = 'IT ' || substring(c.slug from '^it-([0-9a-f]{6})-cat$') || ' Category'
) fc
join public.menu_items i on i.category_id = fc.id
order by fc.created_at, fc.name, i.slug;
