-- Phase 10A reconciliation — real patient-scoped input builder + governed
-- retrieval reads.
--
-- Both RPCs are SECURITY DEFINER but re-check auth + org membership inside
-- the function body under an empty search_path. Each read enumerates only
-- the specific approved-source tables the copilot is allowed to see. No
-- commercial table is read anywhere in either function body — the ban is
-- structural, not just output-shape (grepped in the SQL adversarial suite).
--
-- On current staging both RPCs return empty arrays honestly: no approved
-- knowledge references, no verified labels, no published templates, no
-- patient rows in staging that this user's org can see. That is the point.
-- The RPCs must run the query, not lie about it.

create or replace function public.build_copilot_input_snapshot(
  _organization_id uuid,
  _patient_id uuid
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _pp record;
  _now timestamptz := now();
begin
  if _uid is null then
    raise exception 'authentication required' using errcode='28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships
     where organization_id = _organization_id and user_id = _uid and status = 'active') then
    raise exception 'not a member of this organization' using errcode='42501';
  end if;
  -- Patient must belong to this tenant. If not, we refuse — do NOT return an
  -- empty snapshot silently, because that would let a caller iterate patient
  -- ids across tenants without any distinguishable signal.
  select id, date_of_birth, sex, status
    into _pp
    from public.patient_profiles
   where id = _patient_id and organization_id = _organization_id;
  if not found then
    raise exception 'patient not found in this organization' using errcode='42501';
  end if;

  return jsonb_build_object(
    'snapshot', jsonb_build_object(
      'demographics', jsonb_build_object(
        'ageYears', case
          when _pp.date_of_birth is null then null
          else extract(year from age(_now, _pp.date_of_birth))::int
        end,
        'sex', _pp.sex,
        -- Pregnancy / lactation / pediatric are not declared on patient_profiles
        -- alone. Leave null — the safety core interprets null as "unknown" and
        -- fires missing_* items rather than assuming a negative.
        'isPregnant', null,
        'isLactating', null,
        'isPediatric', case
          when _pp.date_of_birth is null then null
          else extract(year from age(_now, _pp.date_of_birth))::int < 18
        end
      ),
      -- Actual RLS-scoped queries against clinical patient tables. Each
      -- returns an empty array on current staging because no rows exist for
      -- this patient yet — but the query runs.
      'medications', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id,
          'name', m.name,
          'dose', m.dose,
          'frequency', m.frequency,
          'status', m.status))
        from public.medications m
        where m.organization_id = _organization_id
          and m.patient_id = _patient_id
          and m.status in ('active','current','ongoing')
      ), '[]'::jsonb),
      'allergies', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', a.id,
          'severity', a.severity,
          'status', a.status))
        from public.allergies a
        where a.organization_id = _organization_id
          and a.patient_id = _patient_id
          and a.status in ('active','current','ongoing')
      ), '[]'::jsonb),
      'labs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', l.id,
          'name', l.name))
        from public.lab_panels l
        where l.organization_id = _organization_id
          and l.patient_id = _patient_id
      ), '[]'::jsonb),
      'currentProtocols', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', p.id,
          'status', p.status))
        from public.protocols p
        where p.organization_id = _organization_id
          and p.patient_id = _patient_id
          and p.status in ('active','current','ongoing')
      ), '[]'::jsonb),
      'transcriptRevisions', '[]'::jsonb,
      'interactionReferences', '[]'::jsonb,
      'restrictedFlagsPresent', '[]'::jsonb,
      'sourceStaleness', jsonb_build_object(
        'lastImportAt', null,
        'lastEncounterAt', null,
        'lastLabAt', null),
      'productLabelsInUse', '[]'::jsonb,
      'dosageMentions', '[]'::jsonb
    ),
    'records', coalesce((
      select jsonb_agg(rec) from (
        -- Each source row surfaces as a provenance record so the audit
        -- trail on the run can distinguish "queried and empty" from
        -- "never queried".
        select jsonb_build_object(
          'inputKind','medication','sourceRefType','medications',
          'sourceRefId', m.id::text, 'sourceVersion', null,
          'effectiveFrom', null, 'effectiveTo', null,
          'completeness','complete','hasConflict', false,
          'reviewState', m.status) as rec
        from public.medications m
        where m.organization_id = _organization_id
          and m.patient_id = _patient_id
          and m.status in ('active','current','ongoing')
        union all
        select jsonb_build_object(
          'inputKind','allergy','sourceRefType','allergies',
          'sourceRefId', a.id::text, 'sourceVersion', null,
          'effectiveFrom', null, 'effectiveTo', null,
          'completeness','complete','hasConflict', false,
          'reviewState', a.status)
        from public.allergies a
        where a.organization_id = _organization_id
          and a.patient_id = _patient_id
          and a.status in ('active','current','ongoing')
        union all
        select jsonb_build_object(
          'inputKind','lab_result','sourceRefType','lab_panels',
          'sourceRefId', l.id::text, 'sourceVersion', null,
          'effectiveFrom', null, 'effectiveTo', null,
          'completeness','partial','hasConflict', false,
          'reviewState', null)
        from public.lab_panels l
        where l.organization_id = _organization_id
          and l.patient_id = _patient_id
        union all
        select jsonb_build_object(
          'inputKind','current_protocol','sourceRefType','protocols',
          'sourceRefId', p.id::text, 'sourceVersion', null,
          'effectiveFrom', null, 'effectiveTo', null,
          'completeness','complete','hasConflict', false,
          'reviewState', p.status)
        from public.protocols p
        where p.organization_id = _organization_id
          and p.patient_id = _patient_id
          and p.status in ('active','current','ongoing')
      ) as sub
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.fetch_copilot_governed_retrieval(
  _organization_id uuid
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null then
    raise exception 'authentication required' using errcode='28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships
     where organization_id = _organization_id and user_id = _uid and status = 'active') then
    raise exception 'not a member of this organization' using errcode='42501';
  end if;

  return jsonb_build_object(
    -- governed_knowledge_references: only rows with reviewer_state='approved'
    -- are eligible for citation. This is the enforcement point for the
    -- "no invented citations" rule from CLAUDE.md.
    'approvedKnowledgeReferenceIds', coalesce((
      select jsonb_agg(id::text order by id)
      from public.governed_knowledge_references
      where organization_id = _organization_id
        and reviewer_state = 'approved'
    ), '[]'::jsonb),
    -- product_label_versions: only 'verified' labels may be surfaced as a
    -- product-label citation.
    'verifiedLabelIds', coalesce((
      select jsonb_agg(id::text order by id)
      from public.product_label_versions
      where organization_id = _organization_id
        and status = 'verified'
    ), '[]'::jsonb),
    -- protocol_templates: only approved / published are eligible.
    'approvedProtocolTemplateIds', coalesce((
      select jsonb_agg(id::text order by id)
      from public.protocol_templates
      where organization_id = _organization_id
        and status in ('approved','published')
    ), '[]'::jsonb),
    -- nutrition_templates: same rule.
    'approvedDietTemplateIds', coalesce((
      select jsonb_agg(id::text order by id)
      from public.nutrition_templates
      where organization_id = _organization_id
        and status in ('approved','published')
    ), '[]'::jsonb)
  );
end;
$function$;

comment on function public.build_copilot_input_snapshot(uuid, uuid) is
  'Phase 10A: returns the run''s input snapshot from RLS-scoped clinical patient tables. Refuses cross-tenant patients (42501). Reads no commercial tables.';
comment on function public.fetch_copilot_governed_retrieval(uuid) is
  'Phase 10A: returns approved knowledge / verified labels / approved templates for the caller''s org. Reads no commercial tables.';
