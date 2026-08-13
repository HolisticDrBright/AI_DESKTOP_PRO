-- Phase 9E-B: the wrapper now explicitly stamps `manifest_sha256` on each
-- of the three created batches after `preview_knowledge_import` returns.
-- The prior version passed the sha as `source_revision`, which the inner
-- function stored in the wrong column. The additional UPDATE is idempotent
-- (matches on either NULL or the same sha) so the wrapper stays safe when
-- called for an existing batch.

create or replace function public.preview_research_handoff(
  _organization_id uuid, _attests_no_phi boolean, _manifest_sha256 text,
  _clinical_source_name text, _clinical_source_filename text, _clinical_source_byte_size bigint, _clinical_items jsonb,
  _evidence_source_name text, _evidence_source_filename text, _evidence_source_byte_size bigint, _evidence_items jsonb,
  _commercial_source_name text, _commercial_source_filename text, _commercial_source_byte_size bigint, _commercial_items jsonb,
  _schema_version text default 'phase9eb-v1'
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare _uid uuid; _clinical jsonb; _evidence jsonb; _commercial jsonb;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if _attests_no_phi is distinct from true then raise exception 'no-PHI attestation is required' using errcode='55000'; end if;
  if _manifest_sha256 is null or length(_manifest_sha256)<>64 then raise exception 'manifest_sha256 must be a 64-char sha256 hex' using errcode='22023'; end if;
  if jsonb_typeof(_clinical_items)<>'array' or jsonb_typeof(_evidence_items)<>'array' or jsonb_typeof(_commercial_items)<>'array' then
    raise exception 'all three item arrays are required' using errcode='22023'; end if;
  _clinical := public.preview_knowledge_import(_organization_id,'research_handoff',_clinical_source_name,_schema_version,_clinical_items,true,_clinical_source_filename,_clinical_source_byte_size,null,'{}'::text[],null,false);
  _evidence := public.preview_knowledge_import(_organization_id,'research_handoff',_evidence_source_name,_schema_version,_evidence_items,true,_evidence_source_filename,_evidence_source_byte_size,null,array['url_only_evidence','unarchived_source']::text[],'Evidence records are URL-only, unarchived, and not sufficient by themselves for final label verification.',false);
  _commercial := public.preview_knowledge_import(_organization_id,'research_handoff',_commercial_source_name,_schema_version,_commercial_items,true,_commercial_source_filename,_commercial_source_byte_size,null,array['commercial_only']::text[],'Commercial-only namespace: never entered into clinical search, ranking, safety, protocol, retrieval, or recommendations.',true);
  update public.clinical_knowledge_import_batches set manifest_sha256 = _manifest_sha256
   where id in ((_clinical->>'batchId')::uuid,(_evidence->>'batchId')::uuid,(_commercial->>'batchId')::uuid)
     and (manifest_sha256 is null or manifest_sha256 = _manifest_sha256);
  insert into public.audit_events(organization_id,actor_user_id,action,resource_type,resource_id,safe_message,metadata)
  values(_organization_id,_uid,'research_handoff.previewed','clinical_knowledge_import_batch',coalesce(_clinical->>'batchId','unknown'),
    'Research Handoff previewed atomically. Nothing was verified or committed.',
    jsonb_build_object('manifestSha256',_manifest_sha256,'clinicalBatchId',_clinical->>'batchId','evidenceBatchId',_evidence->>'batchId','commercialBatchId',_commercial->>'batchId','clinicalItemCount',_clinical->>'itemCount','evidenceItemCount',_evidence->>'itemCount','commercialItemCount',_commercial->>'itemCount','clinicalIdempotent',_clinical->>'idempotent','evidenceIdempotent',_evidence->>'idempotent','commercialIdempotent',_commercial->>'idempotent'));
  return jsonb_build_object('ok',true,'manifestSha256',_manifest_sha256,'clinical',_clinical,'evidence',_evidence,'commercial',_commercial,'message','Research Handoff preview complete. Nothing has been verified, approved, activated, or attached.');
end;$function$;
