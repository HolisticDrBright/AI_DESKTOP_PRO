-- Preserve the distinction between an empty queue and revoked organization access.
-- RLS alone correctly returns zero rows for both cases; the explicit active
-- membership guard lets the application render the honest forbidden state.

begin;

create or replace function public.list_review_queue(_organization_id uuid)
returns table (
  id uuid,
  item_type text,
  title text,
  priority text,
  status text,
  patient_id uuid,
  patient_name text,
  assignee_name text,
  due_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if not exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = _organization_id
      and m.user_id = _uid
      and m.status = 'active'
  ) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  return query
  select
    q.id,
    q.item_type,
    coalesce(nullif(btrim(q.title), ''), 'Untitled review item') as title,
    q.priority,
    q.status,
    q.patient_id,
    nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') as patient_name,
    case when q.assignee_user_id = _uid then 'You' else null end as assignee_name,
    q.due_at,
    q.created_at
  from public.review_queue_items q
  left join public.patient_profiles p on p.id = q.patient_id
  where q.organization_id = _organization_id
    and q.status <> 'dismissed'
    and q.deleted_at is null
  order by q.created_at desc, q.id
  limit 200;
end;
$$;

revoke all on function public.list_review_queue(uuid) from public, anon;
grant execute on function public.list_review_queue(uuid) to authenticated;

commit;
