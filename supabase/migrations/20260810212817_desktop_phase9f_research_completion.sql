-- Phase 9F: complete the Product Research Handoff preview boundary.
--
-- This migration adds preview-only entity types for archived artifact
-- metadata and practitioner conflict packets, then creates one atomic
-- five-batch wrapper. It never stores artifact bytes, applies a product,
-- resolves a conflict, verifies a label, or approves clinical content.

alter table public.clinical_knowledge_import_items
  drop constraint if exists clinical_knowledge_import_items_entity_type_check;
alter table public.clinical_knowledge_import_items
  add constraint clinical_knowledge_import_items_entity_type_check
  check (entity_type = any (array[
    'pathway','product_label','catalog_product','knowledge_reference','knowledge_claim',
    'lab_suggestion','interpretation_rule','intervention_class','protocol_template','graph_edge',
    'product_label_research','product_label_evidence','product_label_commercial_link',
    'product_label_evidence_artifact','product_label_conflict_packet'
  ]));

create or replace function private.phase9f_preview_only_guard()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.status = 'committed'
     and old.status is distinct from new.status
     and exists (
       select 1
       from public.clinical_knowledge_import_items i
       where i.batch_id = new.id
         and i.entity_type in (
           'product_label_evidence_artifact',
           'product_label_conflict_packet'
         )
     ) then
    raise exception
      'Phase 9F artifact metadata and conflict packets are preview-only; they cannot be committed'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

revoke all on function private.phase9f_preview_only_guard() from public, anon, authenticated, service_role;

drop trigger if exists phase9f_preview_only_guard on public.clinical_knowledge_import_batches;
create trigger phase9f_preview_only_guard
before update of status on public.clinical_knowledge_import_batches
for each row execute function private.phase9f_preview_only_guard();

create or replace function public.preview_research_handoff_v2(
  _organization_id uuid,
  _attests_no_phi boolean,
  _manifest_sha256 text,
  _clinical_source_name text,
  _clinical_source_filename text,
  _clinical_source_byte_size bigint,
  _clinical_items jsonb,
  _evidence_source_name text,
  _evidence_source_filename text,
  _evidence_source_byte_size bigint,
  _evidence_items jsonb,
  _commercial_source_name text,
  _commercial_source_filename text,
  _commercial_source_byte_size bigint,
  _commercial_items jsonb,
  _artifact_source_name text,
  _artifact_source_filename text,
  _artifact_source_byte_size bigint,
  _artifact_items jsonb,
  _conflict_source_name text,
  _conflict_source_filename text,
  _conflict_source_byte_size bigint,
  _conflict_items jsonb,
  _schema_version text default 'phase9f-v2'
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _uid uuid;
  _clinical jsonb;
  _evidence jsonb;
  _commercial jsonb;
  _artifacts jsonb;
  _conflicts jsonb;
begin
  _uid := private.require_knowledge_editor(_organization_id);

  if _attests_no_phi is distinct from true then
    raise exception 'no-PHI attestation is required' using errcode = '55000';
  end if;
  if _manifest_sha256 is null or _manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'manifest_sha256 must be lowercase 64-char sha256 hex' using errcode = '22023';
  end if;
  if _schema_version is distinct from 'phase9f-v2' then
    raise exception 'Phase 9F schema version must be phase9f-v2' using errcode = '22023';
  end if;
  if jsonb_typeof(_clinical_items) <> 'array'
     or jsonb_typeof(_evidence_items) <> 'array'
     or jsonb_typeof(_commercial_items) <> 'array'
     or jsonb_typeof(_artifact_items) <> 'array'
     or jsonb_typeof(_conflict_items) <> 'array'
     or jsonb_array_length(_clinical_items) = 0
     or jsonb_array_length(_evidence_items) = 0
     or jsonb_array_length(_commercial_items) = 0
     or jsonb_array_length(_artifact_items) = 0
     or jsonb_array_length(_conflict_items) = 0 then
    raise exception 'all five non-empty item arrays are required' using errcode = '22023';
  end if;

  if exists (select 1 from jsonb_array_elements(_clinical_items) x
             where x ->> 'entityType' <> 'product_label_research')
     or exists (select 1 from jsonb_array_elements(_evidence_items) x
             where x ->> 'entityType' <> 'product_label_evidence')
     or exists (select 1 from jsonb_array_elements(_commercial_items) x
             where x ->> 'entityType' <> 'product_label_commercial_link')
     or exists (select 1 from jsonb_array_elements(_artifact_items) x
             where x ->> 'entityType' <> 'product_label_evidence_artifact')
     or exists (select 1 from jsonb_array_elements(_conflict_items) x
             where x ->> 'entityType' <> 'product_label_conflict_packet') then
    raise exception 'an item array contains the wrong entity type' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(_clinical_items) x
    where coalesce((x -> 'payload' ->> 'clinically_approved')::boolean, false) <> false
       or coalesce((x -> 'payload' ->> 'practitioner_verified')::boolean, false) <> false
       or coalesce((x -> 'payload' ->> 'imported')::boolean, false) <> false
  ) then
    raise exception 'Phase 9F clinical rows must remain unapproved, unverified, and unimported'
      using errcode = '55000';
  end if;

  if exists (
    select 1 from jsonb_array_elements(_conflict_items) x
    where coalesce((x -> 'payload' ->> 'practitioner_decision_required')::boolean, false) <> true
  ) then
    raise exception 'every Phase 9F conflict packet requires a practitioner decision'
      using errcode = '55000';
  end if;

  _clinical := public.preview_knowledge_import(
    _organization_id, 'research_handoff', _clinical_source_name, _schema_version,
    _clinical_items, true, _clinical_source_filename, _clinical_source_byte_size,
    null, array['phase9f_draft_research']::text[],
    'Draft product-label research. Only exact-identity candidates may later be proposed for individual verification.', false);

  _evidence := public.preview_knowledge_import(
    _organization_id, 'research_handoff', _evidence_source_name, _schema_version,
    _evidence_items, true, _evidence_source_filename, _evidence_source_byte_size,
    null, array['requires_practitioner_reverification']::text[],
    'Archived artifacts prove what a URL showed at a timestamp, not what is on a current physical label.', false);

  _commercial := public.preview_knowledge_import(
    _organization_id, 'research_handoff', _commercial_source_name, _schema_version,
    _commercial_items, true, _commercial_source_filename, _commercial_source_byte_size,
    null, array['commercial_only']::text[],
    'Commercial-only namespace: never used for clinical search, ranking, safety, retrieval, or recommendations.', true);

  _artifacts := public.preview_knowledge_import(
    _organization_id, 'research_handoff', _artifact_source_name, _schema_version,
    _artifact_items, true, _artifact_source_filename, _artifact_source_byte_size,
    null, array['metadata_only','artifact_bytes_not_uploaded','preview_only']::text[],
    'Artifact index metadata only. The archived bytes remain outside the application and no label fact is verified.', false);

  _conflicts := public.preview_knowledge_import(
    _organization_id, 'research_handoff', _conflict_source_name, _schema_version,
    _conflict_items, true, _conflict_source_filename, _conflict_source_byte_size,
    null, array['practitioner_decision_required','never_auto_resolve','preview_only']::text[],
    'Every conflict packet requires an individual practitioner decision. Proposed factual resolutions are not applied.', false);

  update public.clinical_knowledge_import_batches
  set manifest_sha256 = _manifest_sha256
  where id in (
    (_clinical ->> 'batchId')::uuid,
    (_evidence ->> 'batchId')::uuid,
    (_commercial ->> 'batchId')::uuid,
    (_artifacts ->> 'batchId')::uuid,
    (_conflicts ->> 'batchId')::uuid
  ) and (manifest_sha256 is null or manifest_sha256 = _manifest_sha256);

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id, safe_message, metadata)
  values (
    _organization_id, _uid, 'research_handoff.phase9f_previewed',
    'clinical_knowledge_import_batch', _clinical ->> 'batchId',
    'Phase 9F research package previewed atomically. Nothing was verified, committed, approved, activated, attached, or conflict-resolved.',
    jsonb_build_object(
      'manifestSha256', _manifest_sha256,
      'clinicalBatchId', _clinical ->> 'batchId',
      'evidenceBatchId', _evidence ->> 'batchId',
      'commercialBatchId', _commercial ->> 'batchId',
      'artifactBatchId', _artifacts ->> 'batchId',
      'conflictBatchId', _conflicts ->> 'batchId',
      'clinicalItemCount', _clinical ->> 'itemCount',
      'evidenceItemCount', _evidence ->> 'itemCount',
      'commercialItemCount', _commercial ->> 'itemCount',
      'artifactItemCount', _artifacts ->> 'itemCount',
      'conflictItemCount', _conflicts ->> 'itemCount'
    )
  );

  return jsonb_build_object(
    'ok', true,
    'manifestSha256', _manifest_sha256,
    'clinical', _clinical,
    'evidence', _evidence,
    'commercial', _commercial,
    'artifacts', _artifacts,
    'conflicts', _conflicts,
    'message', 'Phase 9F preview complete. Nothing has been verified, committed, approved, activated, attached, or conflict-resolved.'
  );
end;
$function$;

revoke all on function public.preview_research_handoff_v2(
  uuid, boolean, text,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text
) from public, anon, service_role;

grant execute on function public.preview_research_handoff_v2(
  uuid, boolean, text,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text
) to authenticated;

comment on function public.preview_research_handoff_v2(
  uuid, boolean, text,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text, text, bigint, jsonb,
  text
) is 'Authenticated knowledge-editor Phase 9F preview. Creates five atomic preview-only batches; never applies clinical or commercial content.';
