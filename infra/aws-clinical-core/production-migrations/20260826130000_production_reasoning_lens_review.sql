-- AWS-native, practitioner-review-only reasoning and clinical Lens contracts.
-- No reference, patient, reasoning, or AI-generated rows are seeded. Generation
-- remains unavailable until a separately approved worker is registered.

create table clinical_reference.clinical_paradigms (
  code text primary key check (code in ('western_conventional','functional','naturopathic','tcm','biohacking','synergistic')),
  name text not null check (char_length(name) between 1 and 120),
  description text not null check (char_length(description) between 1 and 4000),
  is_composite boolean not null default false,
  composed_of text[] not null default '{}',
  review_status text not null default 'pending_review' check (review_status in ('pending_review','approved','retired')),
  reviewed_by_person_id uuid references clinical_core.persons(id),
  reviewed_at timestamptz,
  check ((review_status='pending_review' and reviewed_by_person_id is null and reviewed_at is null)
    or (review_status in ('approved','retired') and reviewed_by_person_id is not null and reviewed_at is not null))
);

create table clinical_reference.clinical_domains (
  code text not null check (code ~ '^[a-z][a-z0-9_]{2,63}$'),
  version integer not null check (version > 0),
  name text not null check (char_length(name) between 1 and 120),
  description text not null check (char_length(description) between 1 and 4000),
  active boolean not null default false,
  reviewed_by_person_id uuid references clinical_core.persons(id),
  reviewed_at timestamptz,
  primary key (code,version),
  check ((active and reviewed_by_person_id is not null and reviewed_at is not null) or not active)
);

create table clinical_reference.clinical_knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[a-z][a-z0-9_]{2,95}$'),
  revision integer not null check (revision > 0),
  citation text not null check (char_length(citation) between 1 and 4000),
  publisher text check (publisher is null or char_length(publisher) <= 500),
  release_date date,
  revision_date date,
  intended_purpose text check (intended_purpose is null or char_length(intended_purpose) <= 4000),
  intended_population text check (intended_population is null or char_length(intended_population) <= 4000),
  required_inputs text check (required_inputs is null or char_length(required_inputs) <= 4000),
  data_quality_expectations text check (data_quality_expectations is null or char_length(data_quality_expectations) <= 4000),
  logic_summary text check (logic_summary is null or char_length(logic_summary) <= 8000),
  known_limitations text check (known_limitations is null or char_length(known_limitations) <= 8000),
  out_of_scope_uses text check (out_of_scope_uses is null or char_length(out_of_scope_uses) <= 8000),
  validation_status text not null default 'pending_review' check (validation_status in ('pending_review','validated','partially_validated','unvalidated','retired')),
  funding_conflicts text check (funding_conflicts is null or char_length(funding_conflicts) <= 4000),
  reviewed_by_person_id uuid references clinical_core.persons(id),
  reviewed_at timestamptz,
  unique (code,revision),
  check ((validation_status='pending_review' and reviewed_by_person_id is null and reviewed_at is null)
    or (validation_status<>'pending_review' and reviewed_by_person_id is not null and reviewed_at is not null))
);

create table clinical_core.reasoning_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  encounter_id uuid references clinical_core.encounters(id),
  source_cutoff_at timestamptz not null,
  worker_run_id text not null check (worker_run_id ~ '^[A-Za-z0-9:_-]{8,128}$'),
  generation_status text not null check (generation_status in ('review_pending','blocked','failed')),
  model text,
  provider text,
  prompt_template_version text,
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  output_sha256 text check (output_sha256 is null or output_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id),
  unique (organization_id,worker_run_id)
);

create table clinical_core.clinical_facts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  snapshot_id uuid not null references clinical_core.reasoning_snapshots(id),
  fact_type text not null check (char_length(fact_type) between 1 and 64),
  statement text not null check (char_length(statement) between 1 and 4000),
  observed_at timestamptz,
  source_type text not null check (source_type in ('lab_observation','clinical_note','encounter','patient_form','practitioner_entered')),
  source_record_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id)
);

create table clinical_core.clinical_hypotheses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  snapshot_id uuid not null references clinical_core.reasoning_snapshots(id),
  title text not null check (char_length(title) between 1 and 500),
  status text not null default 'proposed' check (status in ('proposed','under_review','supported','weakened','unresolved','archived')),
  reasoning_strength integer check (reasoning_strength between 0 and 100),
  review_status text not null default 'unreviewed' check (review_status in ('unreviewed','accepted','rejected','needs_data')),
  reviewed_by_person_id uuid references clinical_core.persons(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id),
  check ((review_status='unreviewed' and reviewed_by_person_id is null and reviewed_at is null)
    or (review_status<>'unreviewed' and reviewed_by_person_id is not null and reviewed_at is not null))
);

create table clinical_core.evidence_items (
  id uuid primary key default gen_random_uuid(),
  hypothesis_id uuid not null references clinical_core.clinical_hypotheses(id),
  fact_id uuid references clinical_core.clinical_facts(id),
  direction text not null check (direction in ('supporting','contradicting')),
  summary text check (summary is null or char_length(summary) <= 4000),
  created_at timestamptz not null default clock_timestamp()
);

create table clinical_core.missing_data_recommendations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  hypothesis_id uuid not null references clinical_core.clinical_hypotheses(id),
  description text not null check (char_length(description) between 1 and 2000),
  data_type text not null default 'practitioner_request' check (char_length(data_type) between 1 and 80),
  priority integer check (priority between 0 and 100),
  status text not null default 'open' check (status in ('open','completed','dismissed')),
  source text not null check (source in ('approved_worker','practitioner')),
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id)
);

create table clinical_core.hypothesis_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  hypothesis_id uuid not null references clinical_core.clinical_hypotheses(id),
  action text not null check (action in ('accepted','rejected','needs_data')),
  note text check (note is null or char_length(note) <= 2000),
  reviewer_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id)
);

create table clinical_core.lens_evaluations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  encounter_id uuid not null references clinical_core.encounters(id),
  paradigm_code text not null references clinical_reference.clinical_paradigms(code),
  status text not null check (status in ('complete','blocked')),
  invariant_core jsonb not null check (jsonb_typeof(invariant_core)='object'),
  lens_framing jsonb not null check (jsonb_typeof(lens_framing)='object'),
  input_snapshot jsonb not null check (jsonb_typeof(input_snapshot)='object'),
  input_cutoff_at timestamptz not null,
  rule_set_version text not null check (char_length(rule_set_version) between 1 and 100),
  knowledge_versions jsonb not null default '[]'::jsonb check (jsonb_typeof(knowledge_versions)='array'),
  model text, provider text, prompt_template_version text,
  output_schema_version text not null check (char_length(output_schema_version) between 1 and 100),
  output_sha256 text not null check (output_sha256 ~ '^[0-9a-f]{64}$'),
  validation_result jsonb,
  stale boolean not null default false,
  stale_reason text check (stale_reason is null or char_length(stale_reason) <= 1000),
  superseded_by uuid references clinical_core.lens_evaluations(id),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id)
);

create table clinical_core.differential_questions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  encounter_id uuid not null references clinical_core.encounters(id),
  evaluation_id uuid not null references clinical_core.lens_evaluations(id),
  domain_code text not null,
  question_text text not null check (char_length(question_text) between 1 and 2000),
  rationale text not null check (char_length(rationale) between 1 and 4000),
  distinguishes jsonb not null default '[]'::jsonb check (jsonb_typeof(distinguishes)='array'),
  safety_relation text,
  priority text not null check (priority in ('urgent','high','medium','low')),
  answer_type text not null check (char_length(answer_type) between 1 and 80),
  patient_sources jsonb not null default '[]'::jsonb check (jsonb_typeof(patient_sources)='array'),
  knowledge_source_ids uuid[] not null default '{}',
  missing_data_assumptions jsonb not null default '[]'::jsonb check (jsonb_typeof(missing_data_assumptions)='array'),
  generation_method text not null check (generation_method in ('deterministic_rules','ai_assisted')),
  generation_version text not null check (char_length(generation_version) between 1 and 100),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 128),
  status text not null default 'suggested' check (status in ('suggested','accepted','asked','answered','deferred','skipped','dismissed','superseded','stale')),
  status_reason text check (status_reason is null or char_length(status_reason) <= 2000),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id),
  unique (encounter_id,dedupe_key)
);

create table clinical_core.question_status_transitions (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references clinical_core.differential_questions(id),
  from_status text not null,
  to_status text not null,
  reason text check (reason is null or char_length(reason) <= 2000),
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp()
);

create table clinical_core.question_answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references clinical_core.differential_questions(id),
  version integer not null check (version > 0),
  answer_value jsonb not null check (octet_length(answer_value::text) <= 16384),
  corrects_version integer,
  correction_reason text check (correction_reason is null or char_length(correction_reason) <= 2000),
  answered_by_person_id uuid not null references clinical_core.persons(id),
  answered_at timestamptz not null default clock_timestamp(),
  unique (question_id,version),
  foreign key (question_id,corrects_version) references clinical_core.question_answers(question_id,version)
);

create table clinical_core.question_feedback (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references clinical_core.differential_questions(id),
  kind text not null check (kind in ('helpful','not_relevant','unsafe','incorrect','duplicate','other')),
  comment text check (comment is null or char_length(comment) <= 2000),
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp()
);

create table clinical_core.lens_safety_blocks (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references clinical_core.lens_evaluations(id),
  rule_code text not null check (char_length(rule_code) between 1 and 100),
  detail jsonb not null check (jsonb_typeof(detail)='object'),
  reviewed_by_person_id uuid references clinical_core.persons(id),
  reviewed_at timestamptz,
  resolution text check (resolution is null or char_length(resolution) <= 4000),
  created_at timestamptz not null default clock_timestamp(),
  check ((reviewed_at is null and reviewed_by_person_id is null and resolution is null)
    or (reviewed_at is not null and reviewed_by_person_id is not null and resolution is not null))
);

create index reasoning_snapshots_patient_idx on clinical_core.reasoning_snapshots(patient_record_id,created_at desc);
create index hypotheses_patient_idx on clinical_core.clinical_hypotheses(patient_record_id,status,created_at desc);
create index evidence_hypothesis_idx on clinical_core.evidence_items(hypothesis_id,created_at);
create index questions_encounter_idx on clinical_core.differential_questions(encounter_id,created_at);
create index lens_evaluations_encounter_idx on clinical_core.lens_evaluations(encounter_id,paradigm_code,created_at desc);

alter table clinical_core.reasoning_snapshots enable row level security;
alter table clinical_core.clinical_facts enable row level security;
alter table clinical_core.clinical_hypotheses enable row level security;
alter table clinical_core.evidence_items enable row level security;
alter table clinical_core.missing_data_recommendations enable row level security;
alter table clinical_core.hypothesis_reviews enable row level security;
alter table clinical_core.lens_evaluations enable row level security;
alter table clinical_core.differential_questions enable row level security;
alter table clinical_core.question_status_transitions enable row level security;
alter table clinical_core.question_answers enable row level security;
alter table clinical_core.question_feedback enable row level security;
alter table clinical_core.lens_safety_blocks enable row level security;
revoke all on clinical_reference.clinical_paradigms,clinical_reference.clinical_domains,
  clinical_reference.clinical_knowledge_sources from public,clinical_core_api;
revoke all on clinical_core.reasoning_snapshots,clinical_core.clinical_facts,
  clinical_core.clinical_hypotheses,clinical_core.evidence_items,
  clinical_core.missing_data_recommendations,clinical_core.hypothesis_reviews,
  clinical_core.lens_evaluations,clinical_core.differential_questions,
  clinical_core.question_status_transitions,clinical_core.question_answers,
  clinical_core.question_feedback,clinical_core.lens_safety_blocks from public,clinical_core_api;

create trigger hypothesis_reviews_append_only before update or delete on clinical_core.hypothesis_reviews
  for each row execute function clinical_private.block_update_delete();
create trigger question_transitions_append_only before update or delete on clinical_core.question_status_transitions
  for each row execute function clinical_private.block_update_delete();
create trigger question_answers_append_only before update or delete on clinical_core.question_answers
  for each row execute function clinical_private.block_update_delete();
create trigger question_feedback_append_only before update or delete on clinical_core.question_feedback
  for each row execute function clinical_private.block_update_delete();

create or replace function clinical_private.require_reasoning_actor(_organization_id uuid,_patient_id uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$
begin
  return clinical_private.require_clinical_patient(_organization_id,_patient_id);
end $$;

create or replace function clinical_core.list_desktop_lens_paradigms()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.assert_production_context(clinical_private.organization_id(),'clinical_data','workforce');
  if not clinical_private.has_clinical_role(clinical_private.organization_id()) then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('code',p.code,'name',p.name,
    'description',p.description,'isComposite',p.is_composite,'composedOf',to_jsonb(p.composed_of))
    order by p.is_composite,p.code) from clinical_reference.clinical_paradigms p
    where p.review_status='approved'),'[]'::jsonb);
end $$;

create or replace function clinical_core.list_desktop_lens_domains()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.assert_production_context(clinical_private.organization_id(),'clinical_data','workforce');
  if not clinical_private.has_clinical_role(clinical_private.organization_id()) then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('code',d.code,'version',d.version,
    'name',d.name,'description',d.description) order by d.code,d.version)
    from clinical_reference.clinical_domains d where d.active),'[]'::jsonb);
end $$;

create or replace function clinical_core.list_desktop_lens_knowledge_sources()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.assert_production_context(clinical_private.organization_id(),'clinical_data','workforce');
  if not clinical_private.has_clinical_role(clinical_private.organization_id()) then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'code',s.code,'revision',s.revision,
    'citation',s.citation,'publisher',s.publisher,'releaseDate',s.release_date,'revisionDate',s.revision_date,
    'intendedPurpose',s.intended_purpose,'intendedPopulation',s.intended_population,
    'requiredInputs',s.required_inputs,'dataQualityExpectations',s.data_quality_expectations,
    'logicSummary',s.logic_summary,'knownLimitations',s.known_limitations,'outOfScopeUses',s.out_of_scope_uses,
    'validationStatus',s.validation_status,'fundingConflicts',s.funding_conflicts) order by s.code,s.revision)
    from clinical_reference.clinical_knowledge_sources s where s.validation_status<>'pending_review'),'[]'::jsonb);
end $$;

create or replace function clinical_core.get_reasoning_workspace(_organization_id uuid,_patient_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _snapshot clinical_core.reasoning_snapshots%rowtype; _source_changed timestamptz;
  _hypotheses jsonb; _questions jsonb;
begin
  perform clinical_private.require_reasoning_actor(_organization_id,_patient_id);
  select greatest(max(o.created_at),max(o.reviewed_at)) into _source_changed
    from clinical_core.lab_observations o where o.organization_id=_organization_id and o.patient_record_id=_patient_id;
  select * into _snapshot from clinical_core.reasoning_snapshots s
    where s.organization_id=_organization_id and s.patient_record_id=_patient_id
    order by s.created_at desc,s.id desc limit 1;
  select coalesce(jsonb_agg(item order by sort_order,created_at,id),'[]'::jsonb) into _hypotheses from (
    select h.created_at,h.id,case h.status when 'supported' then 0 when 'under_review' then 1
      when 'proposed' then 2 when 'weakened' then 3 when 'unresolved' then 4 else 5 end sort_order,
      jsonb_build_object('id',h.id,'title',h.title,'status',h.status,'strengthLabel',case
        when h.reasoning_strength is null then 'Unknown' else 'Internal evidence weighting '||h.reasoning_strength||'/100 — not a medical probability' end,
        'supporting',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'factType',coalesce(f.fact_type,'missing'),
          'label',coalesce(e.summary,f.statement,'Unknown'),'observedAt',f.observed_at,'source',case when f.source_record_id is null then null
          else jsonb_build_object('kind',f.source_type,'id',f.source_record_id,'at',coalesce(f.observed_at,f.created_at)) end)
          order by e.created_at) from clinical_core.evidence_items e left join clinical_core.clinical_facts f on f.id=e.fact_id
          where e.hypothesis_id=h.id and e.direction='supporting'),'[]'::jsonb),
        'conflicting',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'factType',coalesce(f.fact_type,'conflicting'),
          'label',coalesce(e.summary,f.statement,'Unknown'),'observedAt',f.observed_at,'source',case when f.source_record_id is null then null
          else jsonb_build_object('kind',f.source_type,'id',f.source_record_id,'at',coalesce(f.observed_at,f.created_at)) end)
          order by e.created_at) from clinical_core.evidence_items e left join clinical_core.clinical_facts f on f.id=e.fact_id
          where e.hypothesis_id=h.id and e.direction='contradicting'),'[]'::jsonb),
        'missing',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'label',m.description,'recommendation',m.data_type)
          order by m.priority nulls last,m.created_at) from clinical_core.missing_data_recommendations m
          where m.hypothesis_id=h.id and m.status='open'),'[]'::jsonb),
        'review',jsonb_build_object('state',h.review_status,'reviewedAt',h.reviewed_at,
          'reviewedBy',case when h.reviewed_by_person_id is null then null else 'Practitioner' end,
          'note',(select r.note from clinical_core.hypothesis_reviews r where r.hypothesis_id=h.id order by r.created_at desc limit 1))) item
    from clinical_core.clinical_hypotheses h where h.organization_id=_organization_id
      and h.patient_record_id=_patient_id and h.status<>'archived' order by h.created_at desc limit 20
  ) bounded;
  select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'text',q.question_text,'status',q.status,
    'createdAt',q.created_at) order by q.created_at desc),'[]'::jsonb) into _questions
    from (select * from clinical_core.differential_questions where organization_id=_organization_id
      and patient_record_id=_patient_id and priority='urgent' and status not in ('dismissed','superseded','stale')
      order by created_at desc limit 10) q;
  return jsonb_build_object('patientId',_patient_id,'snapshot',case when _snapshot.id is null then null else
    jsonb_build_object('id',_snapshot.id,'version',(select count(*) from clinical_core.reasoning_snapshots s
      where s.patient_record_id=_patient_id and s.organization_id=_organization_id and s.created_at<=_snapshot.created_at),
      'generatedAt',_snapshot.created_at,'stale',coalesce(_source_changed>_snapshot.source_cutoff_at,false),
      'staleReason',case when _source_changed>_snapshot.source_cutoff_at then 'Source data changed after this snapshot was generated' else null end) end,
    'hypotheses',_hypotheses,'urgentQuestions',_questions,'aiGeneration',jsonb_build_object('configured',false,
      'message','AI snapshot generation is not configured. Existing governed records are shown; nothing is generated or fabricated.'),
    'generatedAt',clock_timestamp());
end $$;

create or replace function clinical_core.review_hypothesis(_hypothesis_id uuid,_action text,_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _h clinical_core.clinical_hypotheses%rowtype; _actor uuid; _review uuid; _audit uuid;
begin
  if _action not in ('accepted','rejected','needs_data') or char_length(coalesce(_note,''))>2000 then
    raise exception using errcode='22023',message='hypothesis_review_invalid'; end if;
  select * into _h from clinical_core.clinical_hypotheses where id=_hypothesis_id and status<>'archived' for update;
  if not found then raise exception using errcode='P0002',message='hypothesis_not_found'; end if;
  _actor:=clinical_private.require_reasoning_actor(_h.organization_id,_h.patient_record_id);
  insert into clinical_core.hypothesis_reviews(organization_id,patient_record_id,hypothesis_id,action,note,reviewer_person_id)
    values(_h.organization_id,_h.patient_record_id,_h.id,_action,nullif(btrim(_note),''),_actor) returning id into _review;
  update clinical_core.clinical_hypotheses set review_status=_action,reviewed_by_person_id=_actor,
    reviewed_at=clock_timestamp(),updated_at=clock_timestamp() where id=_h.id;
  if _action='needs_data' and nullif(btrim(_note),'') is not null then
    insert into clinical_core.missing_data_recommendations(organization_id,patient_record_id,hypothesis_id,
      description,source,created_by_person_id) values(_h.organization_id,_h.patient_record_id,_h.id,btrim(_note),'practitioner',_actor);
  end if;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_h.organization_id,_actor,'hypothesis.'||_action,
    'clinical_hypothesis',_h.id,_h.patient_record_id,'Practitioner reviewed a clinical hypothesis','clinical_data',
    jsonb_build_object('review_id',_review,'review_state',_action,'note_present',nullif(btrim(_note),'') is not null)) returning id into _audit;
  return jsonb_build_object('ok',true,'hypothesisId',_h.id,'state',_action,'auditId',_audit,
    'message',case _action when 'accepted' then 'Hypothesis accepted as a reviewed inference. Nothing was added to a note or care plan.'
      when 'rejected' then 'Hypothesis rejected. The decision and audit trail are saved to the record.'
      else 'More data requested. The request is saved and linked to this hypothesis.' end);
end $$;

create or replace function clinical_core.get_desktop_lens_evaluation(_encounter_id uuid,_paradigm text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _enc clinical_core.encounters%rowtype; _ev clinical_core.lens_evaluations%rowtype; _questions jsonb; _blocks jsonb;
begin
  select * into _enc from clinical_core.encounters where id=_encounter_id and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='encounter_not_found'; end if;
  perform clinical_private.require_reasoning_actor(_enc.organization_id,_enc.patient_record_id);
  if not exists(select 1 from clinical_reference.clinical_paradigms where code=_paradigm and review_status='approved') then
    raise exception using errcode='22023',message='paradigm_not_approved'; end if;
  select * into _ev from clinical_core.lens_evaluations where encounter_id=_encounter_id
    and paradigm_code=_paradigm and superseded_by is null order by created_at desc,id desc limit 1;
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'domainCode',q.domain_code,'questionText',q.question_text,
    'rationale',q.rationale,'distinguishes',q.distinguishes,'safetyRelation',q.safety_relation,'priority',q.priority,
    'answerType',q.answer_type,'patientSources',q.patient_sources,'knowledgeSourceIds',to_jsonb(q.knowledge_source_ids),
    'missingDataAssumptions',q.missing_data_assumptions,'generationMethod',q.generation_method,
    'generationVersion',q.generation_version,'status',q.status,'statusReason',q.status_reason,'createdAt',q.created_at)
    order by q.created_at,q.id),'[]'::jsonb) into _questions from clinical_core.differential_questions q
    where q.encounter_id=_encounter_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'ruleCode',b.rule_code,'detail',b.detail,
    'createdAt',b.created_at,'reviewedBy',b.reviewed_by_person_id,'reviewedAt',b.reviewed_at,'resolution',b.resolution)
    order by b.created_at,b.id),'[]'::jsonb) into _blocks from clinical_core.lens_safety_blocks b where b.evaluation_id=_ev.id;
  return jsonb_build_object('evaluationId',_ev.id,'paradigm',_ev.paradigm_code,'status',_ev.status,
    'invariantCore',_ev.invariant_core,'lensFraming',_ev.lens_framing,'inputSnapshot',_ev.input_snapshot,
    'inputCutoffAt',_ev.input_cutoff_at,'ruleSetVersion',_ev.rule_set_version,'knowledgeVersions',_ev.knowledge_versions,
    'model',_ev.model,'provider',_ev.provider,'promptTemplateVersion',_ev.prompt_template_version,
    'outputSchemaVersion',_ev.output_schema_version,'outputSha256',_ev.output_sha256,
    'validationResult',_ev.validation_result,'stale',_ev.stale,'staleReason',_ev.stale_reason,
    'createdAt',_ev.created_at,'questions',_questions,'safetyBlocks',_blocks);
end $$;

create or replace function clinical_core.list_desktop_question_answers(_question_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _q clinical_core.differential_questions%rowtype;
begin
  select * into _q from clinical_core.differential_questions where id=_question_id;
  if not found then raise exception using errcode='P0002',message='question_not_found'; end if;
  perform clinical_private.require_reasoning_actor(_q.organization_id,_q.patient_record_id);
  return coalesce((select jsonb_agg(jsonb_build_object('version',a.version,'value',a.answer_value,
    'correctsVersion',a.corrects_version,'correctionReason',a.correction_reason,'answeredAt',a.answered_at)
    order by a.version) from clinical_core.question_answers a where a.question_id=_question_id),'[]'::jsonb);
end $$;

create or replace function clinical_private.transition_question(_question_id uuid,_to text,_reason text,_actor uuid)
returns void language plpgsql security definer set search_path='' as $$
declare _q clinical_core.differential_questions%rowtype;
begin
  select * into _q from clinical_core.differential_questions where id=_question_id for update;
  if not found then raise exception using errcode='P0002',message='question_not_found'; end if;
  if not ((_q.status='suggested' and _to in ('accepted','deferred','skipped','dismissed'))
    or (_q.status='accepted' and _to in ('asked','deferred','skipped','dismissed'))
    or (_q.status='asked' and _to in ('answered','deferred','skipped','dismissed'))
    or (_q.status='deferred' and _to in ('accepted','skipped','dismissed'))) then
    raise exception using errcode='40003',message='question_transition_refused'; end if;
  update clinical_core.differential_questions set status=_to,status_reason=nullif(btrim(_reason),''),updated_at=clock_timestamp()
    where id=_question_id;
  insert into clinical_core.question_status_transitions(question_id,from_status,to_status,reason,created_by_person_id)
    values(_question_id,_q.status,_to,nullif(btrim(_reason),''),_actor);
end $$;

create or replace function clinical_core.set_question_status(_question_id uuid,_to text,_reason text default null)
returns void language plpgsql security definer set search_path='' as $$
declare _q clinical_core.differential_questions%rowtype; _actor uuid;
begin
  select * into _q from clinical_core.differential_questions where id=_question_id;
  if not found then raise exception using errcode='P0002',message='question_not_found'; end if;
  _actor:=clinical_private.require_reasoning_actor(_q.organization_id,_q.patient_record_id);
  if _to not in ('accepted','asked','deferred','skipped') or char_length(coalesce(_reason,''))>2000 then
    raise exception using errcode='22023',message='question_status_invalid'; end if;
  perform clinical_private.transition_question(_question_id,_to,_reason,_actor);
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,patient_record_id,
    safe_message,purpose,safe_metadata) values(_q.organization_id,_actor,'lens.question_'||_to,'differential_question',
    _q.id,_q.patient_record_id,'Question status updated','clinical_data',jsonb_build_object('to',_to));
end $$;

create or replace function clinical_core.dismiss_question(_question_id uuid,_feedback_kind text,_comment text default null)
returns void language plpgsql security definer set search_path='' as $$
declare _q clinical_core.differential_questions%rowtype; _actor uuid;
begin
  select * into _q from clinical_core.differential_questions where id=_question_id;
  if not found then raise exception using errcode='P0002',message='question_not_found'; end if;
  _actor:=clinical_private.require_reasoning_actor(_q.organization_id,_q.patient_record_id);
  if _feedback_kind not in ('helpful','not_relevant','unsafe','incorrect','duplicate','other') or char_length(coalesce(_comment,''))>2000 then
    raise exception using errcode='22023',message='question_feedback_invalid'; end if;
  perform clinical_private.transition_question(_question_id,'dismissed',_comment,_actor);
  insert into clinical_core.question_feedback(question_id,kind,comment,created_by_person_id)
    values(_question_id,_feedback_kind,nullif(btrim(_comment),''),_actor);
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,patient_record_id,
    safe_message,purpose,safe_metadata) values(_q.organization_id,_actor,'lens.question_dismissed','differential_question',
    _q.id,_q.patient_record_id,'Question dismissed with feedback','clinical_data',jsonb_build_object('kind',_feedback_kind));
end $$;

create or replace function clinical_core.answer_question(_question_id uuid,_answer jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare _q clinical_core.differential_questions%rowtype; _actor uuid; _version integer;
begin
  select * into _q from clinical_core.differential_questions where id=_question_id for update;
  if not found then raise exception using errcode='P0002',message='question_not_found'; end if;
  _actor:=clinical_private.require_reasoning_actor(_q.organization_id,_q.patient_record_id);
  if _answer is null or octet_length(_answer::text)>16384 then raise exception using errcode='22023',message='answer_invalid'; end if;
  if _q.status<>'asked' then raise exception using errcode='55000',message='question_not_asked'; end if;
  select coalesce(max(version),0)+1 into _version from clinical_core.question_answers where question_id=_question_id;
  insert into clinical_core.question_answers(question_id,version,answer_value,answered_by_person_id)
    values(_question_id,_version,_answer,_actor);
  perform clinical_private.transition_question(_question_id,'answered','answer recorded',_actor);
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,patient_record_id,
    safe_message,purpose,safe_metadata) values(_q.organization_id,_actor,'lens.question_answered','differential_question',
    _q.id,_q.patient_record_id,'Question answered','clinical_data',jsonb_build_object('version',_version));
  return _version;
end $$;

create or replace function clinical_core.correct_question_answer(_question_id uuid,_answer jsonb,_reason text default null)
returns integer language plpgsql security definer set search_path='' as $$
declare _q clinical_core.differential_questions%rowtype; _actor uuid; _previous integer; _version integer;
begin
  select * into _q from clinical_core.differential_questions where id=_question_id for update;
  if not found then raise exception using errcode='P0002',message='question_not_found'; end if;
  _actor:=clinical_private.require_reasoning_actor(_q.organization_id,_q.patient_record_id);
  if _q.status<>'answered' then raise exception using errcode='55000',message='question_not_answered'; end if;
  if _answer is null or octet_length(_answer::text)>16384 or char_length(coalesce(_reason,''))>2000 then
    raise exception using errcode='22023',message='answer_correction_invalid'; end if;
  select max(version) into _previous from clinical_core.question_answers where question_id=_question_id;
  if _previous is null then raise exception using errcode='55000',message='answer_missing'; end if;
  _version:=_previous+1;
  insert into clinical_core.question_answers(question_id,version,answer_value,corrects_version,correction_reason,answered_by_person_id)
    values(_question_id,_version,_answer,_previous,nullif(btrim(_reason),''),_actor);
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,patient_record_id,
    safe_message,purpose,safe_metadata) values(_q.organization_id,_actor,'lens.answer_corrected','differential_question',
    _q.id,_q.patient_record_id,'Answer corrected; original preserved','clinical_data',jsonb_build_object('version',_version,'corrects',_previous));
  return _version;
end $$;

create or replace function clinical_core.record_question_note_use(_question_id uuid,_note_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare _q clinical_core.differential_questions%rowtype; _note clinical_core.clinical_notes%rowtype; _actor uuid;
begin
  select * into _q from clinical_core.differential_questions where id=_question_id;
  if not found then raise exception using errcode='P0002',message='question_not_found'; end if;
  _actor:=clinical_private.require_reasoning_actor(_q.organization_id,_q.patient_record_id);
  select * into _note from clinical_core.clinical_notes where id=_note_id and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='note_not_found'; end if;
  if _note.encounter_id<>_q.encounter_id or _note.patient_record_id<>_q.patient_record_id then
    raise exception using errcode='42501',message='note_question_mismatch'; end if;
  if _note.status not in ('draft','ready_for_review') then raise exception using errcode='55000',message='note_content_frozen'; end if;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,patient_record_id,
    safe_message,purpose,safe_metadata) values(_q.organization_id,_actor,'lens.question_added_to_note','differential_question',
    _q.id,_q.patient_record_id,'Question content explicitly added to a draft note','clinical_data',jsonb_build_object('note_id',_note_id));
end $$;

create or replace function clinical_core.submit_question_feedback(_question_id uuid,_kind text,_comment text default null)
returns void language plpgsql security definer set search_path='' as $$
declare _q clinical_core.differential_questions%rowtype; _actor uuid;
begin
  select * into _q from clinical_core.differential_questions where id=_question_id;
  if not found then raise exception using errcode='P0002',message='question_not_found'; end if;
  _actor:=clinical_private.require_reasoning_actor(_q.organization_id,_q.patient_record_id);
  if _kind not in ('helpful','not_relevant','unsafe','incorrect','duplicate','other') or char_length(coalesce(_comment,''))>2000 then
    raise exception using errcode='22023',message='question_feedback_invalid'; end if;
  insert into clinical_core.question_feedback(question_id,kind,comment,created_by_person_id)
    values(_question_id,_kind,nullif(btrim(_comment),''),_actor);
end $$;

create or replace function clinical_core.review_safety_block(_block_id uuid,_resolution text)
returns void language plpgsql security definer set search_path='' as $$
declare _block clinical_core.lens_safety_blocks%rowtype; _ev clinical_core.lens_evaluations%rowtype; _actor uuid;
begin
  select * into _block from clinical_core.lens_safety_blocks where id=_block_id for update;
  if not found then raise exception using errcode='P0002',message='safety_block_not_found'; end if;
  select * into _ev from clinical_core.lens_evaluations where id=_block.evaluation_id;
  _actor:=clinical_private.require_reasoning_actor(_ev.organization_id,_ev.patient_record_id);
  if nullif(btrim(_resolution),'') is null or char_length(_resolution)>4000 then
    raise exception using errcode='22023',message='resolution_required'; end if;
  if _block.reviewed_at is not null then raise exception using errcode='55000',message='safety_block_already_reviewed'; end if;
  update clinical_core.lens_safety_blocks set reviewed_by_person_id=_actor,reviewed_at=clock_timestamp(),resolution=btrim(_resolution)
    where id=_block_id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,patient_record_id,
    safe_message,purpose,safe_metadata) values(_ev.organization_id,_actor,'lens.safety_block_reviewed','lens_evaluation',
    _ev.id,_ev.patient_record_id,'Safety block reviewed','clinical_data',jsonb_build_object('rule_code',_block.rule_code));
end $$;

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check(action in(
  'connection.invitation_issued','connection.invitation_claimed','connection.paused','connection.resumed',
  'connection.revoked','consent.granted','consent.revoked','lab_import.received','lab_import.duplicate',
  'lab_import.accepted','lab_import.rejected','clinical_record.received','clinical_record.duplicate',
  'privacy_request.submitted','patient.created','lab_observation.reviewed','marker.view','document.viewed',
  'document.exported','report.exported','audit.exported','membership.role_changed','membership.suspended',
  'review_task.created','review_task.resolved','appointment.booked','appointment.rescheduled',
  'appointment.status_changed','appointment.corrected','encounter.started','encounter.completed',
  'encounter.cancelled','encounter.entered_in_error','note.draft_created','note.draft_saved',
  'note.ready_for_review','note.signed','note.addendum_created','note.entered_in_error',
  'protocol.draft_created','protocol.draft_saved','protocol.approved','protocol.activated',
  'protocol.paused','protocol.completed','protocol.discontinued','protocol.revision_created',
  'sync.export_queued','sync.resource_withdrawal_queued','sync.event_retried','sync.event_cancelled',
  'sync.inbound_accepted','sync.inbound_rejected','sync.inbound_correction_recorded','sync.conflict_resolved',
  'sync.provider_registered','sync.provider_reviewed','protocol.interaction_reviewed',
  'protocol_template.created','protocol_template.approved','protocol_template.archived',
  'hypothesis.accepted','hypothesis.rejected','hypothesis.needs_data','lens.question_accepted',
  'lens.question_asked','lens.question_deferred','lens.question_skipped','lens.question_dismissed',
  'lens.question_answered','lens.answer_corrected','lens.question_added_to_note','lens.safety_block_reviewed'));
alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check check(resource_type in(
  'connection','consent','lab_import','clinical_record','privacy_request','patient_profile','lab_observation',
  'biomarker_observation','lab_document','report','audit_log','organization_membership','review_queue_item',
  'appointment','encounter','clinical_note','patient_protocol','patient_protocol_version',
  'sync_outbound_event','sync_inbound_event','sync_inbound_correction','sync_conflict','sync_provider',
  'protocol_item','protocol_template','protocol_template_version','clinical_hypothesis',
  'differential_question','lens_evaluation'));

revoke all on function clinical_core.list_desktop_lens_paradigms(),
  clinical_core.list_desktop_lens_domains(),clinical_core.list_desktop_lens_knowledge_sources(),
  clinical_core.get_reasoning_workspace(uuid,uuid),clinical_core.review_hypothesis(uuid,text,text),
  clinical_core.get_desktop_lens_evaluation(uuid,text),clinical_core.list_desktop_question_answers(uuid),
  clinical_core.set_question_status(uuid,text,text),clinical_core.dismiss_question(uuid,text,text),
  clinical_core.answer_question(uuid,jsonb),clinical_core.correct_question_answer(uuid,jsonb,text),
  clinical_core.record_question_note_use(uuid,uuid),clinical_core.submit_question_feedback(uuid,text,text),
  clinical_core.review_safety_block(uuid,text) from public;
revoke all on function clinical_private.require_reasoning_actor(uuid,uuid),
  clinical_private.transition_question(uuid,text,text,uuid) from public,clinical_core_api;
grant execute on function clinical_core.list_desktop_lens_paradigms(),
  clinical_core.list_desktop_lens_domains(),clinical_core.list_desktop_lens_knowledge_sources(),
  clinical_core.get_reasoning_workspace(uuid,uuid),clinical_core.review_hypothesis(uuid,text,text),
  clinical_core.get_desktop_lens_evaluation(uuid,text),clinical_core.list_desktop_question_answers(uuid),
  clinical_core.set_question_status(uuid,text,text),clinical_core.dismiss_question(uuid,text,text),
  clinical_core.answer_question(uuid,jsonb),clinical_core.correct_question_answer(uuid,jsonb,text),
  clinical_core.record_question_note_use(uuid,uuid),clinical_core.submit_question_feedback(uuid,text,text),
  clinical_core.review_safety_block(uuid,text) to clinical_core_api;
