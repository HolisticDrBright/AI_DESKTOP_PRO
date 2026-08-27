-- AWS-native nutrition authoring, safety review, and adherence workspace.
-- No plan or template is seeded. Patient rows contain PHI and remain
-- unreachable while the production API activation boundary is blocked.

create table clinical_core.nutrition_templates (
  id uuid primary key default public.gen_random_uuid(), organization_id uuid not null references clinical_core.organizations(id),
  slug text, name text not null check(char_length(btrim(name)) between 1 and 200), pattern text,
  summary text, status text not null default 'active' check(status in('active','archived')),
  version integer not null default 1 check(version>0), created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz, archived_reason text, unique(organization_id,slug), unique(id,organization_id)
);
create table clinical_core.nutrition_template_versions (
  id uuid primary key default public.gen_random_uuid(), template_id uuid not null, organization_id uuid not null references clinical_core.organizations(id),
  version integer not null check(version>0), status text not null default 'draft' check(status in('draft','published','superseded')),
  purpose text, intended_use text, prerequisites text[] not null default '{}'::text[], caution_populations text[] not null default '{}'::text[],
  evidence_grade text, evidence_summary text, patient_education text, education_vs_advice_note text,
  requires_practitioner_review boolean not null default true check(requires_practitioner_review=true),
  missing_information_required text[] not null default '{}'::text[], content jsonb not null default '{}'::jsonb check(jsonb_typeof(content)='object'),
  content_sha256 text check(content_sha256 is null or content_sha256~'^[0-9a-f]{64}$'),
  created_by_person_id uuid not null references clinical_core.persons(id), created_at timestamptz not null default clock_timestamp(),
  published_by_person_id uuid references clinical_core.persons(id), published_at timestamptz,
  foreign key(template_id,organization_id) references clinical_core.nutrition_templates(id,organization_id), unique(template_id,version), unique(id,organization_id),
  check(status<>'published' or (published_at is not null and published_by_person_id is not null and content_sha256 is not null))
);
create table clinical_core.nutrition_plans (
  id uuid primary key default public.gen_random_uuid(), organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id), title text not null check(char_length(btrim(title)) between 1 and 200),
  status text not null default 'draft' check(status in('draft','active','paused','completed','discontinued')),
  active_version_id uuid, created_by_person_id uuid not null references clinical_core.persons(id), created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(), unique(id,organization_id)
);
create table clinical_core.nutrition_plan_versions (
  id uuid primary key default public.gen_random_uuid(), plan_id uuid not null, organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id), version integer not null check(version>0),
  status text not null default 'draft' check(status in('draft','in_review','approved','active','superseded')),
  source_template_version_id uuid references clinical_core.nutrition_template_versions(id), content jsonb not null default '{}'::jsonb check(jsonb_typeof(content)='object'),
  goals jsonb not null default '[]'::jsonb check(jsonb_typeof(goals)='array'), targets jsonb not null default '{}'::jsonb check(jsonb_typeof(targets)='object'),
  guidance jsonb not null default '{}'::jsonb check(jsonb_typeof(guidance)='object'), revision integer not null default 1 check(revision>0),
  safety_evaluated_at timestamptz, safety_result text check(safety_result is null or safety_result in('review_required','clear_after_review')),
  submitted_at timestamptz, approved_at timestamptz, activated_at timestamptz,
  created_by_person_id uuid not null references clinical_core.persons(id), approved_by_person_id uuid references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  foreign key(plan_id,organization_id) references clinical_core.nutrition_plans(id,organization_id), unique(plan_id,version), unique(id,organization_id),
  check(not(content ?| array['affiliateUrl','affiliateUrls','destinationUrl','discountCode','trackingCode']))
);
alter table clinical_core.nutrition_plans add constraint nutrition_plans_active_version_fk foreign key(active_version_id) references clinical_core.nutrition_plan_versions(id);
create table clinical_core.nutrition_constraints (
  id uuid primary key default public.gen_random_uuid(), organization_id uuid not null references clinical_core.organizations(id),
  plan_version_id uuid not null unique references clinical_core.nutrition_plan_versions(id), constraints jsonb not null check(jsonb_typeof(constraints)='array'),
  recorded_by_person_id uuid not null references clinical_core.persons(id), recorded_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create table clinical_core.nutrition_safety_flags (
  id uuid primary key default public.gen_random_uuid(), organization_id uuid not null references clinical_core.organizations(id),
  plan_version_id uuid not null references clinical_core.nutrition_plan_versions(id), kind text not null check(char_length(btrim(kind)) between 1 and 100),
  severity text not null check(severity in('info','low','moderate','high','critical')), detail text not null check(char_length(btrim(detail)) between 1 and 2000),
  state text not null default 'open' check(state in('open','resolved','accepted_risk')), raised_by_person_id uuid not null references clinical_core.persons(id),
  raised_at timestamptz not null default clock_timestamp(), resolved_by_person_id uuid references clinical_core.persons(id), resolved_at timestamptz, resolution_reason text
);
create table clinical_core.nutrition_amendments (
  id uuid primary key default public.gen_random_uuid(), organization_id uuid not null references clinical_core.organizations(id),
  plan_version_id uuid not null references clinical_core.nutrition_plan_versions(id), body text not null check(char_length(btrim(body)) between 1 and 10000),
  reason text not null check(char_length(btrim(reason)) between 10 and 2000), authored_by_person_id uuid not null references clinical_core.persons(id),
  authored_at timestamptz not null default clock_timestamp()
);
create table clinical_core.nutrition_checkins (
  id uuid primary key default public.gen_random_uuid(), organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id), plan_version_id uuid references clinical_core.nutrition_plan_versions(id),
  observed_on date not null, source text not null check(source in('patient','practitioner','import')),
  metrics jsonb not null check(jsonb_typeof(metrics)='object'), symptoms jsonb not null default '[]'::jsonb check(jsonb_typeof(symptoms)='array'),
  patient_note text, review_state text not null default 'unreviewed' check(review_state in('unreviewed','reviewed','needs_followup')),
  recorded_by_person_id uuid not null references clinical_core.persons(id), recorded_at timestamptz not null default clock_timestamp(),
  reviewed_by_person_id uuid references clinical_core.persons(id), reviewed_at timestamptz
);
create table clinical_core.nutrition_events (
  id uuid primary key default public.gen_random_uuid(), organization_id uuid not null references clinical_core.organizations(id),
  plan_id uuid references clinical_core.nutrition_plans(id), plan_version_id uuid references clinical_core.nutrition_plan_versions(id),
  template_id uuid references clinical_core.nutrition_templates(id), action text not null, safe_metadata jsonb not null default '{}'::jsonb,
  actor_person_id uuid not null references clinical_core.persons(id), occurred_at timestamptz not null default clock_timestamp(),
  check(jsonb_typeof(safe_metadata)='object' and not(safe_metadata ?| array['patient_note','body','detail','reason','content','symptoms']))
);

create index nutrition_templates_org_idx on clinical_core.nutrition_templates(organization_id,updated_at desc);
create index nutrition_plans_patient_idx on clinical_core.nutrition_plans(organization_id,patient_record_id,updated_at desc);
create index nutrition_plan_versions_plan_idx on clinical_core.nutrition_plan_versions(plan_id,version desc);
create index nutrition_safety_flags_version_idx on clinical_core.nutrition_safety_flags(plan_version_id,state,severity);
create index nutrition_checkins_patient_idx on clinical_core.nutrition_checkins(organization_id,patient_record_id,observed_on desc);
create index nutrition_events_org_idx on clinical_core.nutrition_events(organization_id,occurred_at desc);

do $$ declare _table text; begin foreach _table in array array['nutrition_templates','nutrition_template_versions','nutrition_plans',
  'nutrition_plan_versions','nutrition_constraints','nutrition_safety_flags','nutrition_amendments','nutrition_checkins','nutrition_events'] loop
  execute format('alter table clinical_core.%I enable row level security',_table);
  execute format('revoke all on clinical_core.%I from public,clinical_core_api',_table); end loop; end $$;
create trigger nutrition_amendments_append_only before update or delete on clinical_core.nutrition_amendments
  for each row execute function clinical_reference.reject_immutable_catalog_history();
create trigger nutrition_events_append_only before update or delete on clinical_core.nutrition_events
  for each row execute function clinical_reference.reject_immutable_catalog_history();

create or replace function clinical_private.require_nutrition_patient(_organization_id uuid,_patient_id uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$ begin
  perform clinical_private.require_clinical_patient(_organization_id,_patient_id);
  return clinical_private.actor_person_id(); end $$;

create or replace function clinical_core.invoke_nutrition_operation(_operation text,_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _org uuid:=clinical_private.organization_id(); _actor uuid; _id uuid; _id2 uuid; _patient uuid; _version integer;
  _state text; _rows jsonb; _content jsonb; _count integer; _plan clinical_core.nutrition_plans%rowtype;
  _pv clinical_core.nutrition_plan_versions%rowtype; _tv clinical_core.nutrition_template_versions%rowtype; _hash text;
begin
  if _args is null or jsonb_typeof(_args)<>'object' or octet_length(_args::text)>1048576 then raise exception using errcode='22023',message='nutrition_arguments_invalid'; end if;
  if (_args->>'_organization_id')::uuid<>_org then raise exception using errcode='42501',message='organization_context_mismatch'; end if;
  _actor:=clinical_private.require_knowledge_editor(_org);

  if _operation='list_nutrition_templates' then
    select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'slug',t.slug,'name',t.name,'pattern',t.pattern,'summary',t.summary,
      'status',t.status,'version',t.version,'publishedVersionId',(select v.id from clinical_core.nutrition_template_versions v where v.template_id=t.id and v.status='published' order by v.version desc limit 1),
      'updatedAt',t.updated_at) order by t.name),'[]'::jsonb) into _rows from clinical_core.nutrition_templates t
      where t.organization_id=_org and ((_args->>'_include_archived')::boolean or t.status<>'archived');
    return jsonb_build_object('templates',_rows,'generatedAt',clock_timestamp());
  elsif _operation='upsert_nutrition_template' then
    _id:=nullif(_args->>'_template_id','')::uuid;
    if _id is null then insert into clinical_core.nutrition_templates(organization_id,name,pattern,summary,created_by_person_id)
      values(_org,btrim(_args->>'_name'),nullif(btrim(_args->>'_pattern'),''),nullif(btrim(_args->>'_summary'),''),_actor) returning id,version into _id,_version;
    else update clinical_core.nutrition_templates set name=btrim(_args->>'_name'),pattern=nullif(btrim(_args->>'_pattern'),''),
      summary=nullif(btrim(_args->>'_summary'),''),version=version+1,updated_at=clock_timestamp()
      where id=_id and organization_id=_org and version=(_args->>'_expected_version')::integer returning version into _version;
      if not found then raise exception using errcode='40001',message='nutrition_template_version_conflict'; end if; end if;
    return jsonb_build_object('ok',true,'templateId',_id,'version',_version);
  elsif _operation='create_nutrition_template_version' then
    _id:=(_args->>'_template_id')::uuid; perform 1 from clinical_core.nutrition_templates where id=_id and organization_id=_org and status='active';
    if not found then raise exception using errcode='P0002',message='nutrition_template_not_found'; end if;
    select coalesce(max(version),0)+1 into _version from clinical_core.nutrition_template_versions where template_id=_id;
    _id2:=nullif(_args->>'_copy_from_version_id','')::uuid; _content:='{}'::jsonb;
    if _id2 is not null then select content into _content from clinical_core.nutrition_template_versions where id=_id2 and organization_id=_org; if not found then raise exception using errcode='P0002',message='nutrition_template_source_not_found'; end if; end if;
    insert into clinical_core.nutrition_template_versions(template_id,organization_id,version,purpose,intended_use,prerequisites,caution_populations,
      evidence_grade,evidence_summary,patient_education,education_vs_advice_note,missing_information_required,content,created_by_person_id)
    values(_id,_org,_version,nullif(_args->>'_purpose',''),nullif(_args->>'_intended_use',''),
      array(select jsonb_array_elements_text(coalesce(_args->'_prerequisites','[]'::jsonb))),array(select jsonb_array_elements_text(coalesce(_args->'_caution_populations','[]'::jsonb))),
      nullif(_args->>'_evidence_grade',''),nullif(_args->>'_evidence_summary',''),nullif(_args->>'_patient_education',''),nullif(_args->>'_education_vs_advice_note',''),
      array(select jsonb_array_elements_text(coalesce(_args->'_missing_information_required','[]'::jsonb))),_content,_actor) returning id into _id2;
    return jsonb_build_object('ok',true,'templateVersionId',_id2,'version',_version,'status','draft');
  elsif _operation='save_nutrition_template_content' then
    _id:=(_args->>'_template_version_id')::uuid; _content:=_args->'_content';
    if jsonb_typeof(_content)<>'object' or _content ?| array['affiliateUrl','affiliateUrls','destinationUrl','discountCode','trackingCode'] then raise exception using errcode='22023',message='nutrition_content_invalid'; end if;
    _hash:=encode(public.digest(convert_to(_content::text,'UTF8'),'sha256'),'hex');
    update clinical_core.nutrition_template_versions set content=_content,content_sha256=_hash where id=_id and organization_id=_org and status='draft';
    if not found then raise exception using errcode='P0002',message='nutrition_template_version_not_editable'; end if;
    return jsonb_build_object('ok',true,'templateVersionId',_id,'contentSha256',_hash);
  elsif _operation='publish_nutrition_template_version' then
    _id:=(_args->>'_template_version_id')::uuid;
    update clinical_core.nutrition_template_versions set status='published',published_by_person_id=_actor,published_at=clock_timestamp()
      where id=_id and organization_id=_org and status='draft' and content_sha256 is not null
        and evidence_grade is not null and evidence_summary is not null and education_vs_advice_note is not null returning template_id into _id2;
    if not found then raise exception using errcode='55000',message='nutrition_template_evidence_review_required'; end if;
    update clinical_core.nutrition_template_versions set status='superseded' where template_id=_id2 and id<>_id and status='published';
    return jsonb_build_object('ok',true,'templateVersionId',_id,'status','published');
  elsif _operation='archive_nutrition_template' then
    _id:=(_args->>'_template_id')::uuid;
    update clinical_core.nutrition_templates set status='archived',archived_at=clock_timestamp(),archived_reason=btrim(_args->>'_reason'),updated_at=clock_timestamp()
      where id=_id and organization_id=_org and status='active'; if not found then raise exception using errcode='P0002',message='nutrition_template_not_active'; end if;
    return jsonb_build_object('ok',true,'templateId',_id,'status','archived');
  elsif _operation='install_nutrition_starter_template' then
    _hash:=_args->>'_content_hash'; if _hash!~'^[0-9a-f]{64}$' then raise exception using errcode='22023',message='content_hash_invalid'; end if;
    select id into _id from clinical_core.nutrition_templates where organization_id=_org and slug=_args->>'_slug';
    if found then return jsonb_build_object('ok',true,'templateId',_id,'idempotent',true); end if;
    insert into clinical_core.nutrition_templates(organization_id,slug,name,pattern,summary,created_by_person_id) values(_org,_args->>'_slug',_args->>'_name',nullif(_args->>'_pattern',''),nullif(_args->>'_summary',''),_actor) returning id into _id;
    insert into clinical_core.nutrition_template_versions(template_id,organization_id,version,status,content,content_sha256,evidence_grade,evidence_summary,education_vs_advice_note,created_by_person_id,published_by_person_id,published_at)
      values(_id,_org,1,'published',_args->'_content',_hash,'starter_review_required','Installed from governed starter package','Education content; practitioner review remains required',_actor,_actor,clock_timestamp()) returning id into _id2;
    return jsonb_build_object('ok',true,'templateId',_id,'templateVersionId',_id2,'idempotent',false);
  elsif _operation='create_nutrition_plan' then
    _patient:=(_args->>'_patient_id')::uuid; perform clinical_private.require_nutrition_patient(_org,_patient);
    _id2:=nullif(_args->>'_source_template_version_id','')::uuid; _content:='{}'::jsonb;
    if _id2 is not null then select * into _tv from clinical_core.nutrition_template_versions where id=_id2 and organization_id=_org and status='published'; if not found then raise exception using errcode='P0002',message='published_nutrition_template_required'; end if; _content:=_tv.content; end if;
    insert into clinical_core.nutrition_plans(organization_id,patient_record_id,title,created_by_person_id) values(_org,_patient,btrim(_args->>'_title'),_actor) returning id into _id;
    insert into clinical_core.nutrition_plan_versions(plan_id,organization_id,patient_record_id,version,source_template_version_id,content,created_by_person_id)
      values(_id,_org,_patient,1,_id2,_content,_actor) returning id into _id2;
    return jsonb_build_object('ok',true,'planId',_id,'planVersionId',_id2,'version',1,'status','draft');
  elsif _operation in ('save_nutrition_plan_version','set_nutrition_plan_constraints','evaluate_nutrition_plan_safety','submit_nutrition_plan_version','approve_nutrition_plan_version','activate_nutrition_plan_version','add_nutrition_amendment') then
    _id:=(_args->>'_plan_version_id')::uuid; select * into _pv from clinical_core.nutrition_plan_versions where id=_id and organization_id=_org for update;
    if not found then raise exception using errcode='P0002',message='nutrition_plan_version_not_found'; end if; perform clinical_private.require_nutrition_patient(_org,_pv.patient_record_id);
    if _operation='save_nutrition_plan_version' then
      if _pv.status<>'draft' or _pv.revision<>(_args->>'_expected_version')::integer then raise exception using errcode='40001',message='nutrition_plan_version_conflict'; end if;
      _content:=_args->'_content'; if jsonb_typeof(_content)<>'object' or _content ?| array['affiliateUrl','affiliateUrls','destinationUrl','discountCode','trackingCode'] then raise exception using errcode='22023',message='nutrition_content_invalid'; end if;
      update clinical_core.nutrition_plan_versions set content=_content,goals=coalesce(_args->'_goals','[]'::jsonb),targets=jsonb_build_object('energyValue',_args->'_energy_target_value','energyUnit',_args->'_energy_target_unit','proteinG',_args->'_protein_g','proteinPct',_args->'_protein_pct','carbohydrateG',_args->'_carbohydrate_g','carbohydratePct',_args->'_carbohydrate_pct','fatG',_args->'_fat_g','fatPct',_args->'_fat_pct','fiberG',_args->'_fiber_g'),guidance=jsonb_build_object('mealTiming',_args->'_meal_timing_guidance','fasting',_args->'_fasting_instructions','patientInstructions',_args->'_patient_instructions','practitionerRationale',_args->'_practitioner_rationale'),revision=revision+1,updated_at=clock_timestamp(),safety_evaluated_at=null,safety_result=null where id=_id returning revision into _version;
      return jsonb_build_object('ok',true,'planVersionId',_id,'version',_version,'autosave',(_args->>'_autosave')::boolean);
    elsif _operation='set_nutrition_plan_constraints' then
      if _pv.status<>'draft' or jsonb_typeof(_args->'_constraints')<>'array' then raise exception using errcode='22023',message='nutrition_constraints_invalid'; end if;
      insert into clinical_core.nutrition_constraints(organization_id,plan_version_id,constraints,recorded_by_person_id) values(_org,_id,_args->'_constraints',_actor)
        on conflict(plan_version_id) do update set constraints=excluded.constraints,recorded_by_person_id=excluded.recorded_by_person_id,updated_at=clock_timestamp();
      update clinical_core.nutrition_plan_versions set safety_evaluated_at=null,safety_result=null where id=_id;
      return jsonb_build_object('ok',true,'planVersionId',_id,'constraintCount',jsonb_array_length(_args->'_constraints'));
    elsif _operation='evaluate_nutrition_plan_safety' then
      insert into clinical_core.nutrition_safety_flags(organization_id,plan_version_id,kind,severity,detail,raised_by_person_id)
        select _org,_id,'clinical_inputs_require_review','high','Medication and allergy inputs require practitioner confirmation before approval',_actor
        where not exists(select 1 from clinical_core.nutrition_safety_flags where plan_version_id=_id and kind='clinical_inputs_require_review' and state='open');
      update clinical_core.nutrition_plan_versions set safety_evaluated_at=clock_timestamp(),safety_result='review_required' where id=_id;
      return jsonb_build_object('planVersionId',_id,'result','review_required','safeToApprove',false,'message','Practitioner review of medication, allergy, and constraint inputs is required');
    elsif _operation='submit_nutrition_plan_version' then
      if _pv.status<>'draft' or _pv.safety_evaluated_at is null then raise exception using errcode='55000',message='nutrition_safety_evaluation_required'; end if;
      update clinical_core.nutrition_plan_versions set status='in_review',submitted_at=clock_timestamp() where id=_id;
      return jsonb_build_object('ok',true,'planVersionId',_id,'status','in_review');
    elsif _operation='approve_nutrition_plan_version' then
      if _pv.status<>'in_review' or exists(select 1 from clinical_core.nutrition_safety_flags where plan_version_id=_id and state='open' and severity in('high','critical')) then raise exception using errcode='55000',message='nutrition_safety_review_unresolved'; end if;
      update clinical_core.nutrition_plan_versions set status='approved',approved_at=clock_timestamp(),approved_by_person_id=_actor where id=_id;
      return jsonb_build_object('ok',true,'planVersionId',_id,'status','approved');
    elsif _operation='activate_nutrition_plan_version' then
      if _pv.status<>'approved' then raise exception using errcode='55000',message='approved_nutrition_plan_required'; end if;
      update clinical_core.nutrition_plan_versions set status='superseded' where plan_id=_pv.plan_id and id<>_id and status='active';
      update clinical_core.nutrition_plan_versions set status='active',activated_at=clock_timestamp() where id=_id;
      update clinical_core.nutrition_plans set status='active',active_version_id=_id,updated_at=clock_timestamp() where id=_pv.plan_id;
      return jsonb_build_object('ok',true,'planId',_pv.plan_id,'planVersionId',_id,'status','active');
    else insert into clinical_core.nutrition_amendments(organization_id,plan_version_id,body,reason,authored_by_person_id)
      values(_org,_id,btrim(_args->>'_body'),btrim(_args->>'_reason'),_actor) returning id into _id2;
      return jsonb_build_object('ok',true,'amendmentId',_id2,'planVersionId',_id); end if;
  elsif _operation='raise_nutrition_safety_flag' then
    _id2:=(_args->>'_plan_version_id')::uuid; select patient_record_id into _patient from clinical_core.nutrition_plan_versions where id=_id2 and organization_id=_org; if not found then raise exception using errcode='P0002',message='nutrition_plan_version_not_found'; end if; perform clinical_private.require_nutrition_patient(_org,_patient);
    insert into clinical_core.nutrition_safety_flags(organization_id,plan_version_id,kind,severity,detail,raised_by_person_id) values(_org,_id2,_args->>'_kind',_args->>'_severity',_args->>'_detail',_actor) returning id into _id;
    return jsonb_build_object('ok',true,'flagId',_id,'state','open');
  elsif _operation='resolve_nutrition_safety_flag' then
    _id:=(_args->>'_flag_id')::uuid; _state:=_args->>'_action'; if _state not in('resolved','accepted_risk') then raise exception using errcode='22023',message='nutrition_safety_action_invalid'; end if;
    update clinical_core.nutrition_safety_flags set state=_state,resolved_by_person_id=_actor,resolved_at=clock_timestamp(),resolution_reason=btrim(_args->>'_reason') where id=_id and organization_id=_org and state='open'; if not found then raise exception using errcode='P0002',message='nutrition_safety_flag_not_open'; end if;
    return jsonb_build_object('ok',true,'flagId',_id,'state',_state);
  elsif _operation='revise_nutrition_plan_version' then
    _id:=(_args->>'_plan_version_id')::uuid; select * into _pv from clinical_core.nutrition_plan_versions where id=_id and organization_id=_org; if not found then raise exception using errcode='P0002',message='nutrition_plan_version_not_found'; end if; perform clinical_private.require_nutrition_patient(_org,_pv.patient_record_id);
    select max(version)+1 into _version from clinical_core.nutrition_plan_versions where plan_id=_pv.plan_id;
    insert into clinical_core.nutrition_plan_versions(plan_id,organization_id,patient_record_id,version,source_template_version_id,content,goals,targets,guidance,created_by_person_id)
      values(_pv.plan_id,_org,_pv.patient_record_id,_version,_pv.source_template_version_id,_pv.content,_pv.goals,_pv.targets,_pv.guidance,_actor) returning id into _id2;
    return jsonb_build_object('ok',true,'planVersionId',_id2,'version',_version,'status','draft','supersedesId',_id);
  elsif _operation='set_nutrition_plan_lifecycle' then
    _id:=(_args->>'_plan_id')::uuid; _state:=_args->>'_action'; if _state not in('pause','resume','complete','discontinue') then raise exception using errcode='22023',message='nutrition_lifecycle_invalid'; end if;
    select * into _plan from clinical_core.nutrition_plans where id=_id and organization_id=_org for update; if not found then raise exception using errcode='P0002',message='nutrition_plan_not_found'; end if; perform clinical_private.require_nutrition_patient(_org,_plan.patient_record_id);
    _state:=case _state when 'pause' then 'paused' when 'resume' then 'active' when 'complete' then 'completed' else 'discontinued' end;
    update clinical_core.nutrition_plans set status=_state,updated_at=clock_timestamp() where id=_id; return jsonb_build_object('ok',true,'planId',_id,'status',_state);
  elsif _operation='record_nutrition_checkin' then
    _patient:=(_args->>'_patient_id')::uuid; perform clinical_private.require_nutrition_patient(_org,_patient);
    insert into clinical_core.nutrition_checkins(organization_id,patient_record_id,plan_version_id,observed_on,source,metrics,symptoms,patient_note,recorded_by_person_id)
      values(_org,_patient,nullif(_args->>'_plan_version_id','')::uuid,(_args->>'_observed_on')::date,_args->>'_source',
        jsonb_build_object('dietAdherencePct',_args->'_diet_adherence_pct','mealPlanAdherencePct',_args->'_meal_plan_adherence_pct','energyRating',_args->'_energy_rating','hungerRating',_args->'_hunger_rating','satietyRating',_args->'_satiety_rating','digestiveTolerance',_args->'_digestive_tolerance','weightValue',_args->'_weight_value','weightUnit',_args->'_weight_unit'),coalesce(_args->'_symptoms','[]'::jsonb),nullif(_args->>'_patient_note',''),_actor) returning id into _id;
    return jsonb_build_object('ok',true,'checkinId',_id,'reviewState','unreviewed');
  elsif _operation='review_nutrition_checkin' then
    _id:=(_args->>'_checkin_id')::uuid; _state:=_args->>'_state'; if _state not in('reviewed','needs_followup') then raise exception using errcode='22023',message='nutrition_checkin_state_invalid'; end if;
    update clinical_core.nutrition_checkins set review_state=_state,reviewed_by_person_id=_actor,reviewed_at=clock_timestamp() where id=_id and organization_id=_org and review_state='unreviewed'; if not found then raise exception using errcode='P0002',message='nutrition_checkin_not_open'; end if;
    return jsonb_build_object('ok',true,'checkinId',_id,'reviewState',_state);
  elsif _operation='get_nutrition_adherence_summary' then
    _patient:=(_args->>'_patient_id')::uuid; perform clinical_private.require_nutrition_patient(_org,_patient);
    select coalesce(jsonb_agg(jsonb_build_object('observedOn',c.observed_on,'metrics',c.metrics,'reviewState',c.review_state) order by c.observed_on desc),'[]'::jsonb),count(*) into _rows,_count from clinical_core.nutrition_checkins c where c.organization_id=_org and c.patient_record_id=_patient and c.observed_on>=current_date-least(greatest((_args->>'_days')::integer,1),365);
    return jsonb_build_object('patientId',_patient,'days',(_args->>'_days')::integer,'checkinCount',_count,'checkins',_rows);
  elsif _operation='get_patient_nutrition' then
    _patient:=(_args->>'_patient_id')::uuid; perform clinical_private.require_nutrition_patient(_org,_patient);
    return jsonb_build_object('patientId',_patient,'plans',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'title',p.title,'status',p.status,'activeVersionId',p.active_version_id,'updatedAt',p.updated_at) order by p.updated_at desc) from clinical_core.nutrition_plans p where p.organization_id=_org and p.patient_record_id=_patient),'[]'::jsonb),'checkins',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'observedOn',c.observed_on,'metrics',c.metrics,'reviewState',c.review_state) order by c.observed_on desc) from (select * from clinical_core.nutrition_checkins where organization_id=_org and patient_record_id=_patient order by observed_on desc limit 30)c),'[]'::jsonb));
  elsif _operation='get_nutrition_version_content' then
    _id:=nullif(_args->>'_plan_version_id','')::uuid; _id2:=nullif(_args->>'_template_version_id','')::uuid;
    if (_id is null)=(_id2 is null) then raise exception using errcode='22023',message='nutrition_version_selector_invalid'; end if;
    if _id is not null then select jsonb_build_object('id',v.id,'kind','plan','version',v.version,'status',v.status,'content',v.content,'goals',v.goals,'targets',v.targets,'guidance',v.guidance,'safetyResult',v.safety_result) into _content from clinical_core.nutrition_plan_versions v where v.id=_id and v.organization_id=_org; else select jsonb_build_object('id',v.id,'kind','template','version',v.version,'status',v.status,'content',v.content,'purpose',v.purpose,'evidenceGrade',v.evidence_grade) into _content from clinical_core.nutrition_template_versions v where v.id=_id2 and v.organization_id=_org; end if;
    if _content is null then raise exception using errcode='P0002',message='nutrition_version_not_found'; end if; return _content;
  else raise exception using errcode='0A000',message='nutrition_operation_refused'; end if;
end $$;

revoke all on function clinical_private.require_nutrition_patient(uuid,uuid) from public;
revoke all on function clinical_core.invoke_nutrition_operation(text,jsonb) from public;
grant execute on function clinical_core.invoke_nutrition_operation(text,jsonb) to clinical_core_api;
