-- Phase 9E-B — Research Handoff preview pipeline.
--
-- 1. Extends `clinical_knowledge_import_batches.source_kind` CHECK to include
--    'research_handoff' so the batches produced by the handoff pipeline
--    carry a governed, typed identity rather than being labelled as a
--    product spreadsheet.
-- 2. Adds `preview_research_handoff` — a SECURITY DEFINER wrapper that
--    calls the existing `preview_knowledge_import` three times inside a
--    single PL/pgSQL transaction. Any single failure rolls back all three;
--    idempotent retries return the batch IDs the caller already has. The
--    three batches are:
--      * clinical  = product-label-enrichment.jsonl  (source_kind='research_handoff')
--      * evidence  = evidence-sources.jsonl          (source_kind='research_handoff')
--      * commercial= commercial-links.jsonl          (source_kind='research_handoff',
--                                                    commercial_only=true)
-- 3. Nothing here activates a product, verifies a label, approves a
--    reference, clears a restriction, or attaches a commercial link.

-- --- extend allowed source_kind values ---
alter table public.clinical_knowledge_import_batches
  drop constraint if exists clinical_knowledge_import_batches_source_kind_check;
alter table public.clinical_knowledge_import_batches
  add constraint clinical_knowledge_import_batches_source_kind_check
  check (
    source_kind is null
    or source_kind = any (array[
      'product_spreadsheet',
      'affiliate_sheet',
      'protocol_document',
      'obsidian_export',
      'reference_list',
      'other',
      'research_handoff'
    ])
  );

-- --- atomic wrapper RPC ---
create or replace function public.preview_research_handoff(
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
  _schema_version text default 'phase9eb-v1'
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid;
  _clinical jsonb;
  _evidence jsonb;
  _commercial jsonb;
begin
  _uid := private.require_knowledge_editor(_organization_id);

  if _attests_no_phi is distinct from true then
    raise exception 'no-PHI attestation is required' using errcode = '55000';
  end if;
  if _manifest_sha256 is null or length(_manifest_sha256) <> 64 then
    raise exception 'manifest_sha256 must be a 64-char sha256 hex' using errcode = '22023';
  end if;
  if jsonb_typeof(_clinical_items) <> 'array'
     or jsonb_typeof(_evidence_items) <> 'array'
     or jsonb_typeof(_commercial_items) <> 'array' then
    raise exception 'all three item arrays are required' using errcode = '22023';
  end if;

  -- Preview the three batches. Any exception rolls back all three via
  -- normal PL/pgSQL transactional semantics.
  _clinical := public.preview_knowledge_import(
    _organization_id, 'research_handoff', _clinical_source_name, _schema_version,
    _clinical_items, true,
    _clinical_source_filename, _clinical_source_byte_size, _manifest_sha256,
    '{}'::text[], null, false);

  _evidence := public.preview_knowledge_import(
    _organization_id, 'research_handoff', _evidence_source_name, _schema_version,
    _evidence_items, true,
    _evidence_source_filename, _evidence_source_byte_size, _manifest_sha256,
    array['url_only_evidence','unarchived_source']::text[],
    'Evidence records are URL-only, unarchived, and not sufficient by themselves for final label verification.',
    false);

  _commercial := public.preview_knowledge_import(
    _organization_id, 'research_handoff', _commercial_source_name, _schema_version,
    _commercial_items, true,
    _commercial_source_filename, _commercial_source_byte_size, _manifest_sha256,
    array['commercial_only']::text[],
    'Commercial-only namespace: never entered into clinical search, ranking, safety, protocol, retrieval, or recommendations.',
    true);

  -- Provenance audit for the package as a whole.
  insert into public.audit_events (
    organization_id, actor_user_id, action, resource_type, resource_id,
    safe_message, metadata
  ) values (
    _organization_id, _uid, 'research_handoff.previewed',
    'clinical_knowledge_import_batch',
    coalesce(_clinical->>'batchId', 'unknown'),
    'Research Handoff previewed atomically. Nothing was verified or committed.',
    jsonb_build_object(
      'manifestSha256', _manifest_sha256,
      'clinicalBatchId', _clinical->>'batchId',
      'evidenceBatchId', _evidence->>'batchId',
      'commercialBatchId', _commercial->>'batchId',
      'clinicalItemCount', _clinical->>'itemCount',
      'evidenceItemCount', _evidence->>'itemCount',
      'commercialItemCount', _commercial->>'itemCount',
      'clinicalIdempotent', _clinical->>'idempotent',
      'evidenceIdempotent', _evidence->>'idempotent',
      'commercialIdempotent', _commercial->>'idempotent'));

  return jsonb_build_object(
    'ok', true,
    'manifestSha256', _manifest_sha256,
    'clinical', _clinical,
    'evidence', _evidence,
    'commercial', _commercial,
    'message', 'Research Handoff preview complete. Nothing has been verified, approved, activated, or attached.'
  );
end;
$function$;

revoke all on function public.preview_research_handoff(
  uuid, boolean, text, text, text, bigint, jsonb, text, text, bigint, jsonb, text, text, bigint, jsonb, text
) from public, anon;
grant execute on function public.preview_research_handoff(
  uuid, boolean, text, text, text, bigint, jsonb, text, text, bigint, jsonb, text, text, bigint, jsonb, text
) to authenticated, service_role;

comment on function public.preview_research_handoff(
  uuid, boolean, text, text, text, bigint, jsonb, text, text, bigint, jsonb, text, text, bigint, jsonb, text
) is
  'Phase 9E-B: atomically preview the three Product Research Handoff files as separate research_handoff-kind batches under the practitioner JWT. Requires the no-PHI attestation. Any failure rolls back all three. Idempotent retries return existing batch IDs. Commercial batch carries commercial_only=true.';
