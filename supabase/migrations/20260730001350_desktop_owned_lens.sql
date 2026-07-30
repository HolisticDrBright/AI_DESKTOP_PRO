-- Desktop-owned lens read boundary.
-- Applied migration version: 20260730001350.
--
-- The lens engine's evaluation computation (deterministic rules + optional AI
-- leg) remains on the transitional provider worker: it computes under the
-- caller's RLS view and persists atomically through public.run_lens_evaluation
-- (migration 0024). Question-lifecycle mutations already live in this database
-- as caller-authorized SECURITY DEFINER RPCs, and the Desktop app now calls
-- them directly under the practitioner JWT. This migration adds the narrow,
-- bounded read DTOs the Desktop app needs so every lens READ and every
-- question-lifecycle WRITE leaves the transitional tRPC transport.
--
-- Errcodes: 28000 unauthenticated · 42501 forbidden · P0002 not found ·
-- 22023 invalid · 55000 precondition · 40003 invalid state transition.

begin;

-- ------------------------------------------------------- reference reads
-- Paradigms, versioned domains, and the governed knowledge registry are
-- org-independent, non-PHI reference data readable by any signed-in user
-- (mirrors the RLS posture of 0024 without depending on table grants).
-- NULL registry attributes mean UNKNOWN and must render as "unknown".

create or replace function public.list_desktop_lens_paradigms()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', p.code,
        'name', p.name,
        'description', p.description,
        'isComposite', p.is_composite,
        'composedOf', to_jsonb(p.composed_of)
      )
      order by p.is_composite, p.code
    ),
    '[]'::jsonb
  )
  into _rows
  from public.clinical_paradigms p;

  return _rows;
end;
$$;

create or replace function public.list_desktop_lens_domains()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', d.code,
        'version', d.version,
        'name', d.name,
        'description', d.description
      )
      order by d.code, d.version
    ),
    '[]'::jsonb
  )
  into _rows
  from public.clinical_domains d
  where d.active;

  return _rows;
end;
$$;

create or replace function public.list_desktop_lens_knowledge_sources()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'code', s.code,
        'revision', s.revision,
        'citation', s.citation,
        'publisher', s.publisher,
        'releaseDate', s.release_date,
        'revisionDate', s.revision_date,
        'intendedPurpose', s.intended_purpose,
        'intendedPopulation', s.intended_population,
        'requiredInputs', s.required_inputs,
        'dataQualityExpectations', s.data_quality_expectations,
        'logicSummary', s.logic_summary,
        'knownLimitations', s.known_limitations,
        'outOfScopeUses', s.out_of_scope_uses,
        'validationStatus', s.validation_status,
        'fundingConflicts', s.funding_conflicts
      )
      order by s.code, s.revision
    ),
    '[]'::jsonb
  )
  into _rows
  from public.clinical_knowledge_sources s;

  return _rows;
end;
$$;

-- --------------------------------------------------- patient-scoped reads

-- Latest non-superseded evaluation for an encounter + paradigm, with the
-- ENCOUNTER-scoped question worklist (dedupe + lifecycle span paradigm runs,
-- so deduped urgent questions stay visible under every lens) and the returned
-- evaluation's reviewable safety blocks. Returns SQL NULL when no evaluation
-- exists yet.
create or replace function public.get_desktop_lens_evaluation(
  _encounter_id uuid,
  _paradigm text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _e public.encounters%rowtype;
  _ev public.lens_evaluations%rowtype;
  _questions jsonb;
  _blocks jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into _e
    from public.encounters
    where id = _encounter_id and deleted_at is null;
  if not found then
    raise exception 'encounter not found' using errcode = 'P0002';
  end if;
  if not private.can_access_patient(_e.patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clinical_paradigms p where p.code = _paradigm) then
    raise exception 'unknown paradigm' using errcode = '22023';
  end if;

  select * into _ev
    from public.lens_evaluations
    where encounter_id = _encounter_id
      and paradigm_code = _paradigm
      and superseded_by is null
    order by created_at desc, id desc
    limit 1;
  if not found then
    return null;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'domainCode', q.domain_code,
        'questionText', q.question_text,
        'rationale', q.rationale,
        'distinguishes', q.distinguishes,
        'safetyRelation', q.safety_relation,
        'priority', q.priority,
        'answerType', q.answer_type,
        'patientSources', q.patient_sources,
        'knowledgeSourceIds', to_jsonb(q.knowledge_source_ids),
        'missingDataAssumptions', q.missing_data_assumptions,
        'generationMethod', q.generation_method,
        'generationVersion', q.generation_version,
        'status', q.status,
        'statusReason', q.status_reason,
        'createdAt', q.created_at
      )
      order by q.created_at, q.id
    ),
    '[]'::jsonb
  )
  into _questions
  from public.differential_questions q
  where q.encounter_id = _encounter_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', b.id,
        'ruleCode', b.rule_code,
        'detail', b.detail,
        'createdAt', b.created_at,
        'reviewedBy', b.reviewed_by,
        'reviewedAt', b.reviewed_at,
        'resolution', b.resolution
      )
      order by b.created_at, b.id
    ),
    '[]'::jsonb
  )
  into _blocks
  from public.lens_safety_blocks b
  where b.evaluation_id = _ev.id;

  return jsonb_build_object(
    'evaluationId', _ev.id,
    'paradigm', _ev.paradigm_code,
    'status', _ev.status,
    'invariantCore', _ev.invariant_core,
    'lensFraming', _ev.lens_framing,
    'inputSnapshot', _ev.input_snapshot,
    'inputCutoffAt', _ev.input_cutoff_at,
    'ruleSetVersion', _ev.rule_set_version,
    'knowledgeVersions', _ev.knowledge_versions,
    'model', _ev.model,
    'provider', _ev.provider,
    'promptTemplateVersion', _ev.prompt_template_version,
    'outputSchemaVersion', _ev.output_schema_version,
    'outputSha256', _ev.output_sha256,
    'validationResult', _ev.validation_result,
    'stale', _ev.stale,
    'staleReason', _ev.stale_reason,
    'createdAt', _ev.created_at,
    'questions', _questions,
    'safetyBlocks', _blocks
  );
end;
$$;

-- Every answer version for a question — corrections append, originals stay.
create or replace function public.list_desktop_question_answers(_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _q public.differential_questions%rowtype;
  _rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into _q
    from public.differential_questions
    where id = _question_id;
  if not found then
    raise exception 'question not found' using errcode = 'P0002';
  end if;
  if not private.can_access_patient(_q.patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'version', a.version,
        'value', a.answer_value,
        'correctsVersion', a.corrects_version,
        'correctionReason', a.correction_reason,
        'answeredAt', a.answered_at
      )
      order by a.version
    ),
    '[]'::jsonb
  )
  into _rows
  from public.question_answers a
  where a.question_id = _question_id;

  return _rows;
end;
$$;

-- ------------------------------------------------------------------ grants
revoke all on function public.list_desktop_lens_paradigms() from public, anon;
revoke all on function public.list_desktop_lens_domains() from public, anon;
revoke all on function public.list_desktop_lens_knowledge_sources() from public, anon;
revoke all on function public.get_desktop_lens_evaluation(uuid, text) from public, anon;
revoke all on function public.list_desktop_question_answers(uuid) from public, anon;

grant execute on function public.list_desktop_lens_paradigms() to authenticated;
grant execute on function public.list_desktop_lens_domains() to authenticated;
grant execute on function public.list_desktop_lens_knowledge_sources() to authenticated;
grant execute on function public.get_desktop_lens_evaluation(uuid, text) to authenticated;
grant execute on function public.list_desktop_question_answers(uuid) to authenticated;

commit;
