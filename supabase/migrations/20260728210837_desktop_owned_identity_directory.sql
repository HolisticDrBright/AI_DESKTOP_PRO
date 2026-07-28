-- Desktop-owned identity/directory read boundary.
--
-- list_my_organizations() avoids trusting an organization id from a cookie or
-- decoding JWT claims in application code. It runs as the authenticated caller
-- (SECURITY INVOKER), so table grants and RLS remain authoritative.

begin;

create or replace function public.list_my_organizations()
returns table (
  organization_id uuid,
  name text,
  slug text,
  role text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select o.id, o.name, o.slug, m.role
  from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = auth.uid()
    and m.status = 'active'
    and o.status = 'active'
    and o.deleted_at is null
  order by o.name, o.id;
$$;

revoke all on function public.list_my_organizations() from public, anon;
grant execute on function public.list_my_organizations() to authenticated;

-- Explicit Data API exposure. This is separate from RLS and remains necessary
-- as Supabase moves away from automatic grants for public-schema objects.
grant select on table public.organizations to authenticated;
grant select on table public.organization_memberships to authenticated;
grant select on table public.patient_profiles to authenticated;

commit;
