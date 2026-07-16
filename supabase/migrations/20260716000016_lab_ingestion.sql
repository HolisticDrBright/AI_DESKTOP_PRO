-- 0016_lab_ingestion
-- Lab PDF ingestion: private storage bucket with path-scoped RLS, biomarker
-- definition name uniqueness (deterministic extraction lookups), and the two
-- SECURITY DEFINER RPCs the backend extraction pipeline calls.
--
-- The multi-row clinical write stays RPC-only so it is atomic: observations +
-- document status transition + low-confidence review-queue item + audit event
-- commit or fail together. Nothing here is callable by anon.

-- 1) Private storage bucket for uploaded lab PDFs ----------------------------
-- 15 MB cap, PDF only. Object paths are {organization_id}/{patient_id}/{document_id}.pdf
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lab-documents', 'lab-documents', false, 15728640, array['application/pdf'])
on conflict (id) do nothing;

-- 2) Path authorization helpers ----------------------------------------------
-- CASE (not AND chains) so the uuid casts can never run on unvalidated text —
-- Postgres does not guarantee short-circuit order inside a plain AND list.
create or replace function private.lab_storage_path_readable(_name text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce(array_length(storage.foldername(_name), 1), 0) < 2 then false
    when not (
      (storage.foldername(_name))[1] ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
      and (storage.foldername(_name))[2] ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
    ) then false
    else
      private.is_org_member(((storage.foldername(_name))[1])::uuid)
      and private.can_access_patient(((storage.foldername(_name))[2])::uuid)
  end
$$;

create or replace function private.lab_storage_path_writable(_name text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce(array_length(storage.foldername(_name), 1), 0) < 2 then false
    when not (
      (storage.foldername(_name))[1] ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
      and (storage.foldername(_name))[2] ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
    ) then false
    else
      private.is_org_member(((storage.foldername(_name))[1])::uuid)
      and private.can_write_patient_data(((storage.foldername(_name))[2])::uuid)
  end
$$;

revoke all on function private.lab_storage_path_readable(text) from public, anon;
revoke all on function private.lab_storage_path_writable(text) from public, anon;
grant execute on function private.lab_storage_path_readable(text) to authenticated;
grant execute on function private.lab_storage_path_writable(text) to authenticated;

-- 3) storage.objects policies (bucket-scoped) --------------------------------
drop policy if exists lab_documents_storage_read on storage.objects;
create policy lab_documents_storage_read on storage.objects
  for select to authenticated
  using (bucket_id = 'lab-documents' and private.lab_storage_path_readable(name));

drop policy if exists lab_documents_storage_insert on storage.objects;
create policy lab_documents_storage_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'lab-documents' and private.lab_storage_path_writable(name));

drop policy if exists lab_documents_storage_delete on storage.objects;
create policy lab_documents_storage_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'lab-documents' and private.lab_storage_path_writable(name));

-- 4) Deterministic definition matching ----------------------------------------
-- Extraction looks definitions up by name; make that lookup unambiguous.
create unique index if not exists biomarker_definitions_canonical_name_uidx
  on public.biomarker_definitions (lower(canonical_name));

-- 5) ingest_lab_extraction -----------------------------------------------------
-- Called by the backend after parsing an uploaded PDF. Atomically inserts the
-- extracted observations (original name/value/unit/reference interval kept
-- VERBATIM), marks the document extracted, opens one review-queue item when any
-- marker is low-confidence, and appends a PHI-safe audit event (counts only —
-- no values, no marker names, no file names).
create or replace function public.ingest_lab_extraction(
  _document_id uuid,
  _markers jsonb,
  _lab_company text default null,
  _panel_name text default null,
  _lab_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _doc public.lab_documents%rowtype;
  _m jsonb;
  _def_id uuid;
  _name text;
  _vnum numeric;
  _vtext text;
  _unit text;
  _ref text;
  _flag text;
  _page int;
  _conf numeric;
  _status text;
  _observed timestamptz;
  _inserted int := 0;
  _matched int := 0;
  _low int := 0;
  _queue_id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into _doc
  from public.lab_documents
  where id = _document_id and deleted_at is null;
  if not found then
    raise exception 'lab document not found' using errcode = 'P0002';
  end if;

  if not private.can_write_patient_data(_doc.patient_id) then
    raise exception 'not authorized to write this patient''s data' using errcode = '42501';
  end if;

  -- Re-ingesting an extracted/reviewed document would duplicate observations.
  if _doc.processing_status not in ('uploaded', 'processing', 'failed') then
    raise exception 'document is already extracted' using errcode = '22023';
  end if;

  if _markers is null or jsonb_typeof(_markers) <> 'array' or jsonb_array_length(_markers) = 0 then
    raise exception 'no markers supplied' using errcode = '22023';
  end if;
  if jsonb_array_length(_markers) > 200 then
    raise exception 'too many markers in one ingest (max 200)' using errcode = '22023';
  end if;

  _observed := coalesce(_lab_date::timestamptz, now());

  for _m in select * from jsonb_array_elements(_markers) loop
    _name := nullif(btrim(coalesce(_m->>'name', '')), '');
    if _name is null then continue; end if;

    _vnum := case when jsonb_typeof(_m->'valueNumeric') = 'number'
                  then (_m->>'valueNumeric')::numeric else null end;
    _vtext := nullif(btrim(coalesce(_m->>'valueText', '')), '');
    if _vnum is null and _vtext is null then continue; end if;

    _unit := nullif(btrim(coalesce(_m->>'unit', '')), '');
    _ref  := nullif(btrim(coalesce(_m->>'referenceInterval', '')), '');
    _flag := upper(nullif(btrim(coalesce(_m->>'flag', '')), ''));
    _page := case when jsonb_typeof(_m->'page') = 'number' then (_m->>'page')::int else null end;
    _conf := least(greatest(coalesce(
              case when jsonb_typeof(_m->'confidence') = 'number'
                   then (_m->>'confidence')::numeric else null end, 0.5), 0), 1);
    -- Status ONLY from a source-printed flag — never derived from ranges.
    _status := case _flag
      when 'H'  then 'high'
      when 'L'  then 'low'
      when 'HH' then 'critical_high'
      when 'LL' then 'critical_low'
      else null
    end;

    select id into _def_id
    from public.biomarker_definitions
    where lower(canonical_name) = lower(_name)
    limit 1;
    if _def_id is not null then
      _matched := _matched + 1;
    end if;

    insert into public.biomarker_observations (
      organization_id, patient_id, biomarker_definition_id, lab_document_id,
      value_numeric, value_text, unit, status,
      original_name, original_value, original_unit, original_reference_interval,
      source_page, observed_at, confidence, provenance, review_status, source,
      created_by, updated_by
    ) values (
      _doc.organization_id, _doc.patient_id, _def_id, _doc.id,
      _vnum, _vtext, _unit, _status,
      _name,
      coalesce(nullif(btrim(coalesce(_m->>'originalValue', '')), ''), _m->>'valueNumeric', _vtext),
      _unit, _ref,
      _page, _observed, _conf, 'pdf_extraction', 'unreviewed', 'lab',
      _uid, _uid
    );

    _inserted := _inserted + 1;
    if _conf < 0.70 then
      _low := _low + 1;
    end if;
  end loop;

  if _inserted = 0 then
    raise exception 'no valid markers supplied' using errcode = '22023';
  end if;

  update public.lab_documents set
    processing_status = 'extracted',
    lab_company = coalesce(_lab_company, lab_company),
    panel_name  = coalesce(_panel_name, panel_name),
    lab_date    = coalesce(_lab_date, lab_date),
    updated_by  = _uid,
    updated_at  = now()
  where id = _doc.id;

  if _low > 0 then
    insert into public.review_queue_items (
      organization_id, patient_id, item_type, ref_id, title, priority, status,
      created_by, updated_by
    ) values (
      _doc.organization_id, _doc.patient_id, 'lab_extraction', _doc.id,
      'Verify ' || _low || ' low-confidence marker' || case when _low = 1 then '' else 's' end
        || ' from uploaded panel',
      'medium', 'open', _uid, _uid
    )
    returning id into _queue_id;
  end if;

  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _doc.organization_id, _doc.patient_id, _uid, 'lab_document.ingest',
    'lab_document', _doc.id::text,
    'Lab document extracted (' || _inserted || ' markers)',
    jsonb_build_object(
      'marker_count', _inserted,
      'matched_definitions', _matched,
      'low_confidence_count', _low,
      'review_queue_item_id', _queue_id
    )
  );

  return jsonb_build_object(
    'document_id', _doc.id,
    'status', 'extracted',
    'inserted', _inserted,
    'matched', _matched,
    'low_confidence', _low,
    'queue_item_id', _queue_id
  );
end;
$$;

-- 6) mark_lab_document_failed --------------------------------------------------
-- Failure path: the original PDF stays in storage for manual review; the
-- document is marked failed and the failure is audited (reason is a fixed
-- vocabulary — never free text from the parser, which could echo PHI).
create or replace function public.mark_lab_document_failed(
  _document_id uuid,
  _reason text default 'extraction_error'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _doc public.lab_documents%rowtype;
  _r text;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into _doc
  from public.lab_documents
  where id = _document_id and deleted_at is null;
  if not found then
    raise exception 'lab document not found' using errcode = 'P0002';
  end if;

  if not private.can_write_patient_data(_doc.patient_id) then
    raise exception 'not authorized to write this patient''s data' using errcode = '42501';
  end if;

  if _doc.processing_status not in ('uploaded', 'processing') then
    raise exception 'document is not pending extraction' using errcode = '22023';
  end if;

  _r := case
    when _reason in ('unreadable_pdf', 'no_text_extracted', 'no_markers_found', 'extraction_error')
    then _reason
    else 'extraction_error'
  end;

  update public.lab_documents set
    processing_status = 'failed',
    updated_by = _uid,
    updated_at = now()
  where id = _doc.id;

  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _doc.organization_id, _doc.patient_id, _uid, 'lab_document.failed',
    'lab_document', _doc.id::text,
    'Lab document processing failed',
    jsonb_build_object('reason', _r)
  );

  return jsonb_build_object('document_id', _doc.id, 'status', 'failed', 'reason', _r);
end;
$$;

-- 7) Execution grants ----------------------------------------------------------
revoke all on function public.ingest_lab_extraction(uuid, jsonb, text, text, date) from public, anon;
revoke all on function public.mark_lab_document_failed(uuid, text) from public, anon;
grant execute on function public.ingest_lab_extraction(uuid, jsonb, text, text, date) to authenticated;
grant execute on function public.mark_lab_document_failed(uuid, text) to authenticated;
