-- Desktop-owned reasoning workspace + hypothesis review acceptance tests.
-- Rolled back: the project is unchanged after the final statement.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v uuid) on commit drop;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000311','reasoning-pract@verify.local'),
  ('11111111-0000-0000-0000-000000000312','reasoning-outsider@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000311','Reasoning Org','reasoning-0031'),
  ('bbbbbbbb-0000-0000-0000-000000000312','Reasoning Other','reasoning-other-0031');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000311','11111111-0000-0000-0000-000000000311','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000312','11111111-0000-0000-0000-000000000312','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000311','bbbbbbbb-0000-0000-0000-000000000311','Reasoning','Patient');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000311','11111111-0000-0000-0000-000000000311','cccccccc-0000-0000-0000-000000000311','active');
insert into public.practitioner_profiles (organization_id,user_id,display_name) values
  ('bbbbbbbb-0000-0000-0000-000000000311','11111111-0000-0000-0000-000000000311','Dr. Verify');

-- Grants and definer hygiene for both functions.
insert into _v
select 'authenticated can execute reasoning functions',
  has_function_privilege('authenticated','public.get_reasoning_workspace(uuid,uuid)','execute')
  and has_function_privilege('authenticated','public.review_hypothesis(uuid,text,text)','execute'),
  null;
insert into _v
select 'anon cannot execute reasoning functions',
  not has_function_privilege('anon','public.get_reasoning_workspace(uuid,uuid)','execute')
  and not has_function_privilege('anon','public.review_hypothesis(uuid,text,text)','execute'),
  null;
insert into _v
select 'reasoning functions pin an empty search_path',
  (select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('get_reasoning_workspace','review_hypothesis')),
  null;
insert into _v
select 'hypothesis_reviews has RLS and no direct authenticated privileges',
  (select relrowsecurity from pg_class where oid = 'public.hypothesis_reviews'::regclass)
  and not has_table_privilege('authenticated','public.hypothesis_reviews','insert')
  and not has_table_privilege('authenticated','public.hypothesis_reviews','update')
  and not has_table_privilege('authenticated','public.hypothesis_reviews','delete'),
  null;

select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000311","role":"authenticated"}', true);

-- Empty workspace: snapshot null, AI generation honestly not configured.
do $$
declare _w jsonb;
begin
  _w := public.get_reasoning_workspace(
    'bbbbbbbb-0000-0000-0000-000000000311',
    'cccccccc-0000-0000-0000-000000000311');
  insert into _v values('empty workspace reports no snapshot and AI not configured',
    (_w->'snapshot') = 'null'::jsonb
      and (_w->'aiGeneration'->>'configured')::boolean = false
      and jsonb_array_length(_w->'hypotheses') = 0,
    _w #>> '{}');
end $$;

-- Seed reasoning content AS the definer path would have: snapshot, facts,
-- hypothesis (with and without strength), evidence both directions, missing
-- data, urgent + non-urgent questions.
-- Snapshot backdated: within one transaction now() is frozen, so staleness
-- (source updated_at > snapshot created_at) needs an explicit earlier stamp.
insert into public.reasoning_snapshots (id,organization_id,patient_id,trigger,structured_output,created_at)
values ('eeeeeeee-0000-0000-0000-000000000311','bbbbbbbb-0000-0000-0000-000000000311',
        'cccccccc-0000-0000-0000-000000000311','manual','{}'::jsonb, now() - interval '1 day');
insert into _ids values ('snapshot','eeeeeeee-0000-0000-0000-000000000311');

insert into public.clinical_facts (id,organization_id,patient_id,fact_type,statement,source_table,source_record_id,observed_at) values
  ('ffffffff-0000-0000-0000-000000000311','bbbbbbbb-0000-0000-0000-000000000311','cccccccc-0000-0000-0000-000000000311',
   'measured','TSH 6.2 mIU/L (high)','biomarker_observations','obs-1', now() - interval '3 days'),
  ('ffffffff-0000-0000-0000-000000000312','bbbbbbbb-0000-0000-0000-000000000311','cccccccc-0000-0000-0000-000000000311',
   'patient_reported','Reports persistent fatigue','symptom_observations','sym-1', now() - interval '5 days');

insert into public.clinical_hypotheses
  (id,organization_id,patient_id,title,status,reasoning_strength) values
  ('aaaaaaaa-0000-0000-0000-000000000311','bbbbbbbb-0000-0000-0000-000000000311',
   'cccccccc-0000-0000-0000-000000000311','Subclinical hypothyroid pattern','under_review',78),
  ('aaaaaaaa-0000-0000-0000-000000000312','bbbbbbbb-0000-0000-0000-000000000311',
   'cccccccc-0000-0000-0000-000000000311','Iron-deficiency contribution','proposed',null);

insert into public.evidence_items
  (organization_id,patient_id,hypothesis_id,fact_id,direction,summary) values
  ('bbbbbbbb-0000-0000-0000-000000000311','cccccccc-0000-0000-0000-000000000311',
   'aaaaaaaa-0000-0000-0000-000000000311','ffffffff-0000-0000-0000-000000000311','supporting','Elevated TSH'),
  ('bbbbbbbb-0000-0000-0000-000000000311','cccccccc-0000-0000-0000-000000000311',
   'aaaaaaaa-0000-0000-0000-000000000311','ffffffff-0000-0000-0000-000000000312','contradicting','Fatigue is nonspecific');

insert into public.missing_data_recommendations
  (organization_id,patient_id,hypothesis_id,description,data_type,status) values
  ('bbbbbbbb-0000-0000-0000-000000000311','cccccccc-0000-0000-0000-000000000311',
   'aaaaaaaa-0000-0000-0000-000000000311','Free T4 not on file','lab_panel','open');

insert into public.encounters (id,organization_id,patient_id,encounter_type,status) values
  ('dddddddd-0000-0000-0000-000000000311','bbbbbbbb-0000-0000-0000-000000000311',
   'cccccccc-0000-0000-0000-000000000311','follow-up','in_progress');
insert into public.lens_evaluations
  (id,organization_id,patient_id,encounter_id,paradigm_code,status,input_snapshot,input_cutoff_at,
   source_versions,rule_set_version,knowledge_versions,output_schema_version,output_sha256,invariant_core) values
  ('99999999-0000-0000-0000-000000000311','bbbbbbbb-0000-0000-0000-000000000311',
   'cccccccc-0000-0000-0000-000000000311','dddddddd-0000-0000-0000-000000000311',
   'western_conventional','complete','{}'::jsonb, now(),'{}'::jsonb,'v1','{}'::jsonb,'v1','x','{}'::jsonb);
insert into public.differential_questions
  (organization_id,patient_id,encounter_id,evaluation_id,paradigm_code,domain_code,question_text,rationale,
   priority,answer_type,generation_method,generation_version,dedupe_key,status) values
  ('bbbbbbbb-0000-0000-0000-000000000311','cccccccc-0000-0000-0000-000000000311',
   'dddddddd-0000-0000-0000-000000000311','99999999-0000-0000-0000-000000000311',
   'western_conventional','endocrine','Any chest pain or palpitations at rest?','Urgent cardiac screen',
   'urgent','yes_no','deterministic_rules','v1','urgent-cardiac','suggested'),
  ('bbbbbbbb-0000-0000-0000-000000000311','cccccccc-0000-0000-0000-000000000311',
   'dddddddd-0000-0000-0000-000000000311','99999999-0000-0000-0000-000000000311',
   'western_conventional','endocrine','Morning body temperature pattern?','Low-priority context',
   'low','free_text','deterministic_rules','v1','low-temp','suggested');

do $$
declare _w jsonb; _h jsonb;
begin
  _w := public.get_reasoning_workspace(
    'bbbbbbbb-0000-0000-0000-000000000311',
    'cccccccc-0000-0000-0000-000000000311');

  insert into _v values('snapshot meta carries version and generation time',
    (_w->'snapshot'->>'version')::int = 1
      and (_w->'snapshot'->>'generatedAt') is not null,
    _w->'snapshot' #>> '{}');

  insert into _v values('snapshot is stale when source data changed after generation',
    (_w->'snapshot'->>'stale')::boolean = true
      and (_w->'snapshot'->>'staleReason') is not null,
    _w->'snapshot' #>> '{}');

  select h into _h from jsonb_array_elements(_w->'hypotheses') h
  where h->>'id' = 'aaaaaaaa-0000-0000-0000-000000000311';

  insert into _v values('strength wording is internal weighting, never probability',
    (_h->>'strengthLabel') like 'Internal evidence weighting 78/100%'
      and (_h->>'strengthLabel') like '%not a medical probability%'
      and (_h->>'strengthLabel') not ilike '%likelihood%'
      and (_h->>'strengthLabel') not ilike '%chance%',
    _h->>'strengthLabel');

  insert into _v values('unknown strength stays Unknown',
    exists (select 1 from jsonb_array_elements(_w->'hypotheses') h
            where h->>'id' = 'aaaaaaaa-0000-0000-0000-000000000312'
              and h->>'strengthLabel' = 'Unknown'),
    null);

  insert into _v values('evidence is split supporting/conflicting/missing with source links',
    jsonb_array_length(_h->'supporting') = 1
      and jsonb_array_length(_h->'conflicting') = 1
      and jsonb_array_length(_h->'missing') = 1
      and (_h->'supporting'->0->'source'->>'kind') = 'biomarker_observations'
      and (_h->'supporting'->0->'source'->>'id') = 'obs-1',
    _h #>> '{}');

  insert into _v values('urgent safety questions surface; non-urgent do not',
    jsonb_array_length(_w->'urgentQuestions') = 1
      and (_w->'urgentQuestions'->0->>'text') like 'Any chest pain%',
    _w->'urgentQuestions' #>> '{}');
end $$;

-- Review actions: persist + audit atomically; accept never writes a note.
do $$
declare _r jsonb; _notes_before int; _notes_after int;
begin
  select count(*) into _notes_before from public.clinical_notes
  where patient_id = 'cccccccc-0000-0000-0000-000000000311';

  _r := public.review_hypothesis(
    'aaaaaaaa-0000-0000-0000-000000000311', 'accepted', 'Consistent with labs');

  insert into _v values('accept persists review state on the hypothesis',
    (select review_status from public.clinical_hypotheses
     where id = 'aaaaaaaa-0000-0000-0000-000000000311') = 'accepted'
    and (_r->>'ok')::boolean,
    _r #>> '{}');

  insert into _v values('accept appends an immutable review row',
    exists (select 1 from public.hypothesis_reviews
            where hypothesis_id = 'aaaaaaaa-0000-0000-0000-000000000311'
              and action = 'accepted'
              and reviewer_user_id = '11111111-0000-0000-0000-000000000311'),
    null);

  insert into _v values('accept writes the audit event in the same transaction',
    exists (select 1 from public.audit_events
            where resource_type = 'clinical_hypothesis'
              and resource_id = 'aaaaaaaa-0000-0000-0000-000000000311'
              and action = 'hypothesis.accepted'
              and actor_user_id = '11111111-0000-0000-0000-000000000311')
    and (_r->>'auditId') is not null,
    _r->>'auditId');

  insert into _v values('audit safe_message carries no clinical content',
    not exists (select 1 from public.audit_events
                where resource_id = 'aaaaaaaa-0000-0000-0000-000000000311'
                  and (safe_message ilike '%hypothyroid%' or safe_message ilike '%TSH%')),
    null);

  select count(*) into _notes_after from public.clinical_notes
  where patient_id = 'cccccccc-0000-0000-0000-000000000311';
  insert into _v values('accepting never inserts into a note or care plan',
    _notes_after = _notes_before,
    _notes_after::text);

  -- needs_data creates an actionable missing-data request.
  _r := public.review_hypothesis(
    'aaaaaaaa-0000-0000-0000-000000000312', 'needs_data', 'Please order ferritin + iron panel');
  insert into _v values('needs_data opens a missing-data recommendation',
    exists (select 1 from public.missing_data_recommendations
            where hypothesis_id = 'aaaaaaaa-0000-0000-0000-000000000312'
              and description = 'Please order ferritin + iron panel'
              and status = 'open'),
    null);
  insert into _v values('needs_data maps to the flagged review state',
    (select review_status from public.clinical_hypotheses
     where id = 'aaaaaaaa-0000-0000-0000-000000000312') = 'flagged',
    null);
end $$;

-- Invalid action.
do $$
begin
  perform public.review_hypothesis('aaaaaaaa-0000-0000-0000-000000000311','approve_all',null);
  insert into _v values('invalid review action is refused',false,'no error');
exception when others then
  insert into _v values('invalid review action is refused', sqlstate = '22023', sqlstate);
end $$;

-- Cross-tenant.
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000312","role":"authenticated"}', true);
do $$
begin
  perform public.get_reasoning_workspace(
    'bbbbbbbb-0000-0000-0000-000000000311','cccccccc-0000-0000-0000-000000000311');
  insert into _v values('cross-tenant workspace read is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant workspace read is refused', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.review_hypothesis('aaaaaaaa-0000-0000-0000-000000000311','rejected',null);
  insert into _v values('cross-tenant hypothesis review is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant hypothesis review is refused', sqlstate='42501', sqlstate);
end $$;

-- Anonymous.
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$
begin
  perform public.review_hypothesis('aaaaaaaa-0000-0000-0000-000000000311','accepted',null);
  insert into _v values('anonymous hypothesis review is refused',false,'no error');
exception when others then
  insert into _v values('anonymous hypothesis review is refused', sqlstate='28000', sqlstate);
end $$;

select name, passed, detail from _v order by name;
rollback;
