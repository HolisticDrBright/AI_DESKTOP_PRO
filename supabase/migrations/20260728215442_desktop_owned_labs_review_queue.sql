-- Desktop-owned labs and review queue boundary.
--
-- Both read functions are SECURITY INVOKER: the authenticated caller's table
-- grants and RLS policies remain authoritative. Mutations continue through the
-- existing atomic SECURITY DEFINER RPCs, which validate caller access, stamp
-- the actor, and append the audit event in the same transaction.

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
language sql
stable
security invoker
set search_path = ''
as $$
  select
    q.id,
    q.item_type,
    coalesce(nullif(btrim(q.title), ''), 'Untitled review item') as title,
    q.priority,
    q.status,
    q.patient_id,
    nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') as patient_name,
    case when q.assignee_user_id = auth.uid() then 'You' else null end as assignee_name,
    q.due_at,
    q.created_at
  from public.review_queue_items q
  left join public.patient_profiles p on p.id = q.patient_id
  where q.organization_id = _organization_id
    and q.status <> 'dismissed'
    and q.deleted_at is null
  order by q.created_at desc, q.id
  limit 200;
$$;

create or replace function public.list_patient_lab_observations(
  _organization_id uuid,
  _patient_id uuid
)
returns table (
  id uuid,
  biomarker_definition_id uuid,
  canonical_name text,
  biological_system text,
  value_numeric numeric,
  value_text text,
  unit text,
  status text,
  original_reference_interval text,
  confidence numeric,
  provenance text,
  review_status text,
  reviewed_at timestamptz,
  observed_at timestamptz,
  ingested_at timestamptz,
  lab_document_id uuid,
  source text,
  document_file_name text,
  document_lab_company text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    o.id,
    o.biomarker_definition_id,
    d.canonical_name,
    d.biological_system,
    o.value_numeric,
    o.value_text,
    o.unit,
    o.status,
    o.original_reference_interval,
    o.confidence,
    o.provenance,
    o.review_status,
    o.reviewed_at,
    o.observed_at,
    o.ingested_at,
    o.lab_document_id,
    o.source,
    doc.file_name,
    doc.lab_company
  from public.biomarker_observations o
  left join public.biomarker_definitions d on d.id = o.biomarker_definition_id
  left join public.lab_documents doc on doc.id = o.lab_document_id
  where o.organization_id = _organization_id
    and o.patient_id = _patient_id
    and o.deleted_at is null
  order by o.observed_at desc, o.id
  limit 1000;
$$;

revoke all on function public.list_review_queue(uuid) from public, anon;
revoke all on function public.list_patient_lab_observations(uuid, uuid) from public, anon;
grant execute on function public.list_review_queue(uuid) to authenticated;
grant execute on function public.list_patient_lab_observations(uuid, uuid) to authenticated;

-- Replace broad Supabase bootstrap grants with the smallest Data API surface
-- used by this slice. RLS remains the row-level authorization layer.
revoke all privileges on table
  public.biomarker_definitions,
  public.biomarker_observations,
  public.review_queue_items,
  public.lab_documents
from public, anon, authenticated;

grant select on table
  public.biomarker_definitions,
  public.biomarker_observations,
  public.review_queue_items
to authenticated;

-- The transitional PDF ingestion endpoint creates and updates its source
-- document as the signed-in practitioner. Observation and queue writes remain
-- RPC-only.
grant select, insert, update on table public.lab_documents to authenticated;

commit;
