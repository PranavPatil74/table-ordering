-- TEST-ONLY shim that makes a plain PostgreSQL server look enough like Supabase for our
-- migrations to run: the three API roles, the `auth` schema with auth.users / auth.uid() /
-- auth.role(), and Supabase's "grant everything on new objects in public to the API roles"
-- default privileges (which our migrations must explicitly undo).
--
-- This file is NEVER applied to a real Supabase project. The test harness skips it when an
-- `auth` schema already exists (i.e. when TEST_DATABASE_URL points at `supabase start`).
--
-- It is NOT Supabase: Auth, PostgREST, Realtime and Storage are not emulated. See README.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema auth;

create table auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

-- Same definitions Supabase uses: read the claims PostgREST sets per request.
create function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase's defaults: new objects in `public` are granted to every API role.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
