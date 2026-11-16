-- Sandwich Express, Phase 1, migration 6/6: Realtime publication.
--
-- Staff dashboards subscribe to changes on `orders` (Phase 7). Supabase Realtime applies the
-- subscriber's RLS policies, so only signed-in staff receive events. Real-time events are only
-- a nudge: the dashboard always re-fetches from the database on load and on reconnect.
--
-- The `supabase_realtime` publication exists on Supabase (local and hosted) but not on a plain
-- PostgreSQL server, so this migration is a deliberate no-op there. That keeps the migrations
-- runnable on vanilla PostgreSQL for testing.

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'orders'
     ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end
$$;
