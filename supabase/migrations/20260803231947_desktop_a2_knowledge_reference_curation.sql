-- Phase 9E-A.2: extend governed_knowledge_references with structured fields
-- and add the governed CRUD RPCs.

alter table public.governed_knowledge_references
  add column if not exists reference_type text,
  add column if not exists clinical_domain text,
  add column if not exists structured_claim jsonb not null default '{}'::jsonb,
  add column if not exists population text,
  add column if not exists intervention text,
  add column if not exists outcome_field text,
  add column if not exists evidence_grade text,
  add column if not exists source_version text,
  add column if not exists publication_date date,
  add column if not exists limitations text[] not null default '{}'::text[],
  add column if not exists contradictions text[] not null default '{}'::text[],
  add column if not exists reviewer_state text not null default 'draft',
  add column if not exists reviewer_notes text,
  add column if not exists superseded_by uuid references public.governed_knowledge_references(id) on delete restrict,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references auth.users(id),
  add column if not exists verification_reason text;

alter table public.governed_knowledge_references
  drop constraint if exists governed_knowledge_references_reviewer_state_check;
alter table public.governed_knowledge_references
  add constraint governed_knowledge_references_reviewer_state_check
  check (reviewer_state in ('draft','in_review','approved','superseded','retired'));

alter table public.governed_knowledge_references
  drop constraint if exists governed_knowledge_references_evidence_grade_check;
alter table public.governed_knowledge_references
  add constraint governed_knowledge_references_evidence_grade_check
  check (evidence_grade is null
         or evidence_grade in ('A','B','C','expert_consensus',
                               'practitioner_experience','unclassified'));

create or replace function private.enforce_approved_reference_immutable()
returns trigger language plpgsql security invoker set search_path to '' as $function$
begin
  if TG_OP = 'UPDATE' and OLD.reviewer_state in ('approved','superseded','retired') then
    if NEW.claim is distinct from OLD.claim
       or NEW.citation is distinct from OLD.citation
       or NEW.structured_claim is distinct from OLD.structured_claim
       or NEW.evidence_grade is distinct from OLD.evidence_grade
       or NEW.population is distinct from OLD.population
       or NEW.intervention is distinct from OLD.intervention
       or NEW.outcome_field is distinct from OLD.outcome_field
       or NEW.publication_date is distinct from OLD.publication_date
       or NEW.limitations is distinct from OLD.limitations
       or NEW.contradictions is distinct from OLD.contradictions
       or NEW.reference_type is distinct from OLD.reference_type
       or NEW.clinical_domain is distinct from OLD.clinical_domain
       or NEW.jurisdiction is distinct from OLD.jurisdiction
       or NEW.source_kind is distinct from OLD.source_kind
       or NEW.source_version is distinct from OLD.source_version
    then
      raise exception 'an approved knowledge reference is immutable; use supersede_knowledge_reference'
        using errcode = '55000';
    end if;
  end if;
  if TG_OP = 'DELETE' and OLD.reviewer_state in ('approved','superseded') then
    raise exception 'an approved knowledge reference cannot be deleted' using errcode = '55000';
  end if;
  return case TG_OP when 'DELETE' then OLD else NEW end;
end;
$function$;

drop trigger if exists governed_knowledge_references_immutable on public.governed_knowledge_references;
create trigger governed_knowledge_references_immutable
  before update or delete on public.governed_knowledge_references
  for each row execute function private.enforce_approved_reference_immutable();

create or replace function public.create_knowledge_reference_draft(
  _organization_id uuid,
  _claim text,
  _reference_type text default null,
  _clinical_domain text default null,
  _structured_claim jsonb default '{}'::jsonb,
  _population text default null,
  _intervention text default null,
  _outcome_field text default null,
  _evidence_grade text default null,
  _citation text default null,
  _source_kind text default null,
  _source_version text default null,
  _publication_date date default null,
  _jurisdiction text default null,
  _limitations text[] default '{}'::text[],
  _contradictions text[] default '{}'::text[],
  _restricted_flags text[] default '{}'::text[]
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid;
  _id uuid;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_claim), '') = '' then
    raise exception 'claim is required' using errcode = '22023';
  end if;

  insert into public.governed_knowledge_references
    (organization_id, claim, citation, source_kind, jurisdiction,
     restricted_flags, status, created_by,
     reference_type, clinical_domain, structured_claim,
     population, intervention, outcome_field, evidence_grade,
     source_version, publication_date, limitations, contradictions,
     reviewer_state)
  values
    (_organization_id, btrim(_claim),
     nullif(btrim(coalesce(_citation, '')), ''),
     nullif(btrim(coalesce(_source_kind, '')), ''),
     nullif(btrim(coalesce(_jurisdiction, '')), ''),
     coalesce(_restricted_flags, '{}'::text[]),
     'pending', _uid,
     nullif(btrim(coalesce(_reference_type, '')), ''),
     nullif(btrim(coalesce(_clinical_domain, '')), ''),
     coalesce(_structured_claim, '{}'::jsonb),
     nullif(btrim(coalesce(_population, '')), ''),
     nullif(btrim(coalesce(_intervention, '')), ''),
     nullif(btrim(coalesce(_outcome_field, '')), ''),
     nullif(btrim(coalesce(_evidence_grade, '')), ''),
     nullif(btrim(coalesce(_source_version, '')), ''),
     _publication_date,
     coalesce(_limitations, '{}'::text[]),
     coalesce(_contradictions, '{}'::text[]),
     'draft')
  returning id into _id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'knowledge_reference.draft_created',
     'governed_knowledge_reference', _id::text,
     'Knowledge reference draft created',
     jsonb_build_object('hasCitation', _citation is not null,
                        'hasStructuredClaim', jsonb_typeof(_structured_claim) = 'object'
                                              and _structured_claim <> '{}'::jsonb));

  return jsonb_build_object('ok', true, 'id', _id, 'reviewerState', 'draft');
end;
$function$;

revoke all on function public.create_knowledge_reference_draft(uuid, text, text, text, jsonb, text, text, text, text, text, text, text, date, text, text[], text[], text[]) from public, anon;
grant execute on function public.create_knowledge_reference_draft(uuid, text, text, text, jsonb, text, text, text, text, text, text, text, date, text, text[], text[], text[]) to authenticated;

create or replace function public.approve_knowledge_reference(
  _organization_id uuid,
  _reference_id uuid,
  _verification_reason text
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid;
  _row public.governed_knowledge_references%rowtype;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_verification_reason), '') = '' then
    raise exception 'approval requires a stated reason' using errcode = '22023';
  end if;

  select * into _row from public.governed_knowledge_references
  where id = _reference_id for update;
  if not found then
    raise exception 'reference not found' using errcode = 'P0002';
  end if;
  if _row.organization_id <> _organization_id then
    raise exception 'reference belongs to a different tenant' using errcode = '42501';
  end if;
  if _row.reviewer_state not in ('draft','in_review') then
    raise exception 'only draft or in_review references can be approved' using errcode = '55000';
  end if;

  if _row.evidence_grade in ('A','B','C','expert_consensus')
     and coalesce(btrim(_row.citation), '') = '' then
    raise exception 'a graded reference (%) must have a citation before approval',
      _row.evidence_grade using errcode = '22023';
  end if;

  update public.governed_knowledge_references
  set reviewer_state = 'approved',
      verified_at = clock_timestamp(),
      verified_by = _uid,
      verification_reason = btrim(_verification_reason),
      status = 'verified'
  where id = _reference_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'knowledge_reference.approved',
     'governed_knowledge_reference', _reference_id::text,
     'Knowledge reference approved',
     jsonb_build_object('grade', _row.evidence_grade,
                        'restricted', cardinality(_row.restricted_flags) > 0));

  return jsonb_build_object('ok', true, 'id', _reference_id, 'reviewerState', 'approved');
end;
$function$;

revoke all on function public.approve_knowledge_reference(uuid, uuid, text) from public, anon;
grant execute on function public.approve_knowledge_reference(uuid, uuid, text) to authenticated;

create or replace function public.supersede_knowledge_reference(
  _organization_id uuid,
  _supersedes_id uuid,
  _new_claim text,
  _reason text
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid;
  _prior public.governed_knowledge_references%rowtype;
  _id uuid;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'supersede requires a stated reason' using errcode = '22023';
  end if;
  if coalesce(btrim(_new_claim), '') = '' then
    raise exception 'a new claim text is required' using errcode = '22023';
  end if;

  select * into _prior from public.governed_knowledge_references where id = _supersedes_id;
  if not found then
    raise exception 'prior reference not found' using errcode = 'P0002';
  end if;
  if _prior.organization_id <> _organization_id then
    raise exception 'prior reference belongs to a different tenant' using errcode = '42501';
  end if;

  insert into public.governed_knowledge_references
    (organization_id, claim, citation, source_kind, jurisdiction,
     restricted_flags, status, created_by,
     reference_type, clinical_domain, structured_claim,
     population, intervention, outcome_field, evidence_grade,
     source_version, publication_date, limitations, contradictions,
     reviewer_state)
  values
    (_organization_id, btrim(_new_claim),
     _prior.citation, _prior.source_kind, _prior.jurisdiction,
     _prior.restricted_flags, 'pending', _uid,
     _prior.reference_type, _prior.clinical_domain,
     _prior.structured_claim, _prior.population, _prior.intervention,
     _prior.outcome_field, _prior.evidence_grade,
     _prior.source_version, _prior.publication_date,
     _prior.limitations, _prior.contradictions,
     'draft')
  returning id into _id;

  update public.governed_knowledge_references
  set reviewer_state = 'superseded', superseded_by = _id
  where id = _supersedes_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'knowledge_reference.superseded',
     'governed_knowledge_reference', _id::text,
     'Knowledge reference superseded — new draft created',
     jsonb_build_object('supersedes', _supersedes_id));

  return jsonb_build_object('ok', true, 'id', _id, 'supersedesId', _supersedes_id,
                            'reviewerState', 'draft');
end;
$function$;

revoke all on function public.supersede_knowledge_reference(uuid, uuid, text, text) from public, anon;
grant execute on function public.supersede_knowledge_reference(uuid, uuid, text, text) to authenticated;

create or replace function public.list_knowledge_references(_organization_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _rows jsonb;
begin
  if _uid is null then raise exception 'authentication required' using errcode='28000'; end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id=_organization_id and user_id=_uid and status='active') then
    raise exception 'not a member of this organization' using errcode='42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'claim', r.claim, 'citation', r.citation,
    'referenceType', r.reference_type, 'clinicalDomain', r.clinical_domain,
    'structuredClaim', r.structured_claim, 'population', r.population,
    'intervention', r.intervention, 'outcomeField', r.outcome_field,
    'evidenceGrade', r.evidence_grade, 'sourceKind', r.source_kind,
    'sourceVersion', r.source_version, 'publicationDate', r.publication_date,
    'jurisdiction', r.jurisdiction, 'limitations', r.limitations,
    'contradictions', r.contradictions, 'restrictedFlags', r.restricted_flags,
    'reviewerState', r.reviewer_state, 'status', r.status,
    'verifiedAt', r.verified_at, 'verifiedBy', r.verified_by,
    'verificationReason', r.verification_reason,
    'supersededBy', r.superseded_by, 'createdAt', r.created_at,
    'createdBy', r.created_by
  ) order by r.created_at desc), '[]'::jsonb) into _rows
  from public.governed_knowledge_references r
  where r.organization_id = _organization_id;

  return jsonb_build_object('organizationId', _organization_id, 'references', _rows);
end;
$function$;

revoke all on function public.list_knowledge_references(uuid) from public, anon;
grant execute on function public.list_knowledge_references(uuid) to authenticated;
