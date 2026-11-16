-- READ-ONLY diagnostic: leftover `pnpm test:supabase` TABLES and what references them.
-- Safe to paste into Supabase Studio's SQL editor (local stack). It only SELECTs: no INSERT,
-- UPDATE, DELETE or DDL, and it never selects payment-attempt snapshots or order contents
-- (they can hold a customer's name or note): only counts.
--
-- A table is listed when its code starts with `IT` or its label starts with `IT `. It is a
-- CONFIRMED fixture (`matches_fixture_pattern`) only when the code is `IT<6 hex digits, upper case>`,
-- the label is exactly `IT table <same tag, lower case>` (what createWorld() in
-- src/supabase-it/harness.ts creates), AND the same run's category or modifier group exists
-- (`has_same_run_category` / `has_same_run_group`). Everything else is a look-alike and is left
-- alone by `pnpm cleanup:test-data`. `unpaid_checkouts > 0` tables are skipped by the tool.
select
  t.code,
  t.label,
  t.is_active,
  (t.code ~ '^IT[0-9A-F]{6}$'
     and t.label = 'IT table ' || lower(substring(t.code from 3)))
                                              as matches_fixture_pattern,
  exists (select 1 from public.menu_categories c
           where c.slug = 'it-' || lower(substring(t.code from 3)) || '-cat'
             and c.name = 'IT ' || lower(substring(t.code from 3)) || ' Category')
                                              as has_same_run_category,
  exists (select 1 from public.modifier_groups g
           where g.slug = 'it-' || lower(substring(t.code from 3)) || '-extras'
             and g.name = 'IT ' || lower(substring(t.code from 3)) || ' Extras')
                                              as has_same_run_group,
  (select count(*) from public.orders o where o.table_id = t.id)
                                              as order_history,
  (select count(*) from public.payment_attempts pa
    where pa.table_id = t.id and pa.status = 'PENDING'::public.payment_status)
                                              as unpaid_checkouts,
  (select count(*) from public.payment_attempts pa
    where pa.table_id = t.id and pa.status <> 'PENDING'::public.payment_status)
                                              as other_payment_attempts,
  t.id                                        as table_id,
  t.created_at
from public.cafe_tables t
where t.code like 'IT%' or t.label like 'IT %'
order by t.created_at, t.code;
