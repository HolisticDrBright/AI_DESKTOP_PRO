-- ============================================================
-- Test: 0024 differential questions + clinical lens engine (M2)
--
-- Rolled-back, against the real project. Proves (22 checks, all must pass):
--   - run_lens_evaluation: complete run persists snapshot + invariant core +
--     cited questions; audit carries counts, never question text
--   - cross-lens duplicate suppression by dedupe key
--   - rerun supersedes the prior evaluation and its live questions
--   - invented knowledge references, unknown domains and incomplete cores
--     are hard-rejected (22023)
--   - safety failures BLOCK: zero questions, reviewable lens_safety_blocks
--     rows; human review requires a resolution note
--   - lifecycle: accept -> ask -> answer v1 -> correct v2 (original preserved,
--     answer rows immutable); un-asked answers 55000; backward moves 40003
--   - dismissal validates + captures practitioner feedback
--   - explicit add-to-note is audited (draft notes only)
--   - a medication change marks evaluations + pre-ask questions STALE while
--     answered questions keep their state (no silent recompute)
--   - evaluation snapshots and the invariant core are immutable for ANY role
--   - cross-org RPCs 42501; RLS hides all lens rows from outsiders while
--     paradigms/domains/knowledge registry stay readable reference data
-- Every row must show passed = true.
-- Run inside a transaction and roll back (see docs/live-api.md).
-- ============================================================

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v uuid) on commit drop;
grant all on _v to authenticated; grant all on _ids to authenticated;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000061','pract24@verify.local'),
  ('11111111-0000-0000-0000-000000000062','outsider24@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000041','Verify Org A 24','verify-a-0024'),
  ('bbbbbbbb-0000-0000-0000-000000000042','Verify Org B 24','verify-b-0024');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000041','11111111-0000-0000-0000-000000000061','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000042','11111111-0000-0000-0000-000000000062','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000041','bbbbbbbb-0000-0000-0000-000000000041','OrgA','Lens'),
  ('cccccccc-0000-0000-0000-000000000042','bbbbbbbb-0000-0000-0000-000000000042','OrgB','Other');
insert into public.practitioner_patient_relationships(organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000041','11111111-0000-0000-0000-000000000061','cccccccc-0000-0000-0000-000000000041','active'),
  ('bbbbbbbb-0000-0000-0000-000000000042','11111111-0000-0000-0000-000000000062','cccccccc-0000-0000-0000-000000000042','active');
insert into public.encounters(id,organization_id,patient_id,status) values
  ('eeeeeeee-0000-0000-0000-000000000041','bbbbbbbb-0000-0000-0000-000000000041','cccccccc-0000-0000-0000-000000000041','in_progress');

select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000061","role":"authenticated"}', true);

create temp table _core(j jsonb) on commit drop;
insert into _core values ('{"objectiveFacts":[{"fact":"BP 152/96","sourceRef":"obs:1"}],"provenance":[{"ref":"obs:1","kind":"biomarker_observation"}],"missingInformation":["no home BP readings"],"conflicts":[],"allergies":[{"allergen":"penicillin"}],"interactions":[],"criticalLabs":[],"redFlags":[{"code":"htn_stage2","label":"Stage 2 blood pressure reading"}],"emergencyConsiderations":[],"evidenceQuality":{"labs":"lab-reported"},"limitations":["single-encounter reading"]}'::jsonb);

-- 1. complete evaluation with two cited questions
do $$
declare r jsonb;
begin
  r := public.run_lens_evaluation(
    'eeeeeeee-0000-0000-0000-000000000041','western_conventional',
    '{"facts":1}'::jsonb, now(), '[{"table":"biomarker_observations","id":"x","updatedAt":"t"}]'::jsonb,
    'lens-rules-v1','[{"code":"acc_aha_htn_2017","revision":1}]'::jsonb,
    null, null, null, 'lens-output-v1', repeat('a',64),
    (select j from _core), '{"ranking":["cardiometabolic"]}'::jsonb,
    jsonb_build_array(
      jsonb_build_object('questionText','How was this blood pressure measured (cuff size, rest, position)?',
        'rationale','Stage 2 reading on a single measurement; technique affects classification.',
        'domainCode','cardiometabolic','priority','high','answerType','free_text',
        'knowledgeSourceCodes', jsonb_build_array('acc_aha_htn_2017'),
        'patientSources', jsonb_build_array(jsonb_build_object('ref','obs:1')),
        'dedupeKey','bp-measurement-technique'),
      jsonb_build_object('questionText','Any home or out-of-office blood pressure readings available?',
        'rationale','Out-of-office confirmation distinguishes sustained hypertension from office effects.',
        'domainCode','cardiometabolic','priority','medium','answerType','yes_no',
        'knowledgeSourceCodes', jsonb_build_array('acc_aha_htn_2017'),
        'dedupeKey','bp-out-of-office')));
  insert into _ids values('eval1',(r->>'evaluationId')::uuid);
  insert into _v select 'evaluation completes with cited questions',
    r->>'status'='complete' and (r->>'questionsInserted')::int=2
    and exists (select 1 from public.audit_events where action='lens.evaluation_completed'
                and (metadata->>'questions')::int=2
                and metadata::text not ilike '%blood pressure%'), r::text;
exception when others then
  insert into _v values('evaluation completes with cited questions', false, sqlstate||' '||sqlerrm);
end $$;

-- 2. another paradigm reusing dedupe keys is suppressed as duplicate
do $$
declare r jsonb;
begin
  r := public.run_lens_evaluation(
    'eeeeeeee-0000-0000-0000-000000000041','functional',
    '{"facts":1}'::jsonb, now(), '[]'::jsonb,'lens-rules-v1','[]'::jsonb,
    null,null,null,'lens-output-v1', repeat('b',64),
    (select j from _core), '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('questionText','How was this blood pressure measured?',
      'rationale','Same underlying question through a different lens.',
      'domainCode','cardiometabolic','priority','high','answerType','free_text',
      'knowledgeSourceCodes', jsonb_build_array('acc_aha_htn_2017'),
      'dedupeKey','bp-measurement-technique')));
  insert into _v select 'cross-lens duplicate suppression',
    (r->>'questionsInserted')::int=0 and (r->>'questionsDeduped')::int=1, r::text;
exception when others then
  insert into _v values('cross-lens duplicate suppression', false, sqlstate||' '||sqlerrm);
end $$;

-- 3. rerun same paradigm supersedes prior evaluation + its live questions
do $$
declare r jsonb;
begin
  r := public.run_lens_evaluation(
    'eeeeeeee-0000-0000-0000-000000000041','western_conventional',
    '{"facts":2}'::jsonb, now(), '[]'::jsonb,'lens-rules-v1','[]'::jsonb,
    null,null,null,'lens-output-v1', repeat('c',64),
    (select j from _core), '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('questionText','How was this blood pressure measured (cuff size, rest, position)?',
      'rationale','Regenerated after new inputs.','domainCode','cardiometabolic','priority','high','answerType','free_text',
      'knowledgeSourceCodes', jsonb_build_array('acc_aha_htn_2017'),'dedupeKey','bp-measurement-technique')));
  insert into _ids values('eval2',(r->>'evaluationId')::uuid);
  insert into _v select 'rerun supersedes the prior evaluation and re-suggests',
    (r->>'questionsInserted')::int=1
    and exists (select 1 from public.lens_evaluations where id=(select v from _ids where k='eval1')
                and superseded_by=(select v from _ids where k='eval2'))
    and (select count(*) from public.differential_questions
         where evaluation_id=(select v from _ids where k='eval1') and status='superseded')>=1, '';
exception when others then
  insert into _v values('rerun supersedes the prior evaluation and re-suggests', false, sqlstate||' '||sqlerrm);
end $$;

-- 4. invented reference / unknown domain / missing core section refused
do $$
begin
  perform public.run_lens_evaluation('eeeeeeee-0000-0000-0000-000000000041','western_conventional',
    '{}'::jsonb, now(),'[]'::jsonb,'v','[]'::jsonb,null,null,null,'s',repeat('d',64),
    (select j from _core),'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('questionText','x','rationale','y','domainCode','cardiometabolic',
      'knowledgeSourceCodes', jsonb_build_array('made_up_reference_2026'),'dedupeKey','k1')));
  insert into _v values('invented knowledge reference refused', false, 'no error');
exception when others then
  insert into _v values('invented knowledge reference refused', sqlstate='22023', sqlstate);
end $$;
do $$
begin
  perform public.run_lens_evaluation('eeeeeeee-0000-0000-0000-000000000041','western_conventional',
    '{}'::jsonb, now(),'[]'::jsonb,'v','[]'::jsonb,null,null,null,'s',repeat('d',64),
    (select j from _core),'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('questionText','x','rationale','y','domainCode','astrology',
      'knowledgeSourceCodes', jsonb_build_array('acc_aha_htn_2017'),'dedupeKey','k2')));
  insert into _v values('unknown clinical domain refused', false, 'no error');
exception when others then
  insert into _v values('unknown clinical domain refused', sqlstate='22023', sqlstate);
end $$;
do $$
begin
  perform public.run_lens_evaluation('eeeeeeee-0000-0000-0000-000000000041','western_conventional',
    '{}'::jsonb, now(),'[]'::jsonb,'v','[]'::jsonb,null,null,null,'s',repeat('d',64),
    '{"objectiveFacts":[]}'::jsonb,'{}'::jsonb,'[]'::jsonb);
  insert into _v values('incomplete invariant core refused', false, 'no error');
exception when others then
  insert into _v values('incomplete invariant core refused', sqlstate='22023', sqlstate);
end $$;

-- 5. safety failures block: no questions, reviewable rows, honest audit
do $$
declare r jsonb; _b uuid;
begin
  r := public.run_lens_evaluation('eeeeeeee-0000-0000-0000-000000000041','tcm',
    '{}'::jsonb, now(),'[]'::jsonb,'lens-rules-v1','[]'::jsonb,null,null,null,'lens-output-v1',repeat('e',64),
    (select j from _core),'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('questionText','should not persist','rationale','r','domainCode','sleep',
      'knowledgeSourceCodes', jsonb_build_array('aasm_sleep_questions'),'dedupeKey','blocked-q')),
    jsonb_build_array(jsonb_build_object('ruleCode','lens_suppressed_red_flag',
      'detail', jsonb_build_object('redFlag','htn_stage2'))));
  insert into _ids values('evalblocked',(r->>'evaluationId')::uuid);
  select id into _b from public.lens_safety_blocks where evaluation_id=(r->>'evaluationId')::uuid;
  insert into _ids values('block1', _b);
  insert into _v select 'safety failure blocks output into a reviewable failure',
    r->>'status'='blocked'
    and (select count(*) from public.differential_questions where evaluation_id=(r->>'evaluationId')::uuid)=0
    and _b is not null
    and exists (select 1 from public.audit_events where action='lens.evaluation_blocked'), r::text;
exception when others then
  insert into _v values('safety failure blocks output into a reviewable failure', false, sqlstate||' '||sqlerrm);
end $$;
do $$
begin
  perform public.review_safety_block((select v from _ids where k='block1'), '   ');
  insert into _v values('safety review requires a resolution note', false, 'no error');
exception when others then
  insert into _v values('safety review requires a resolution note', sqlstate='22023', sqlstate);
end $$;
do $$
begin
  perform public.review_safety_block((select v from _ids where k='block1'), 'Reviewed: rule fired correctly; fixture case.');
  insert into _v select 'safety block reviewed by a human',
    exists (select 1 from public.lens_safety_blocks where id=(select v from _ids where k='block1') and reviewed_by is not null), '';
exception when others then
  insert into _v values('safety block reviewed by a human', false, sqlstate||' '||sqlerrm);
end $$;

-- 6. lifecycle: accept -> ask -> answer v1 -> correct v2 (original preserved)
do $$
declare _q uuid; _v1 integer; _v2 integer;
begin
  select id into _q from public.differential_questions
   where evaluation_id=(select v from _ids where k='eval2') limit 1;
  insert into _ids values('q1', _q);
  perform public.set_question_status(_q, 'accepted', null);
  perform public.set_question_status(_q, 'asked', null);
  _v1 := public.answer_question(_q, '{"text":"Manual cuff, seated, after 5 minutes rest"}'::jsonb);
  _v2 := public.correct_question_answer(_q, '{"text":"Automated cuff, seated, after 5 minutes rest"}'::jsonb, 'device corrected');
  insert into _v select 'answer versions append; original preserved',
    _v1=1 and _v2=2
    and (select answer_value->>'text' from public.question_answers where question_id=_q and version=1)='Manual cuff, seated, after 5 minutes rest'
    and (select corrects_version from public.question_answers where question_id=_q and version=2)=1
    and exists (select 1 from public.differential_questions where id=_q and status='answered'), '';
exception when others then
  insert into _v values('answer versions append; original preserved', false, sqlstate||' '||sqlerrm);
end $$;
do $$
begin
  update public.question_answers set answer_value='{"text":"tampered"}'::jsonb
   where question_id=(select v from _ids where k='q1') and version=1;
  insert into _v values('answer rows are immutable', false, 'no error');
exception when others then
  insert into _v values('answer rows are immutable', true, sqlstate);
end $$;
do $$
begin
  perform public.set_question_status((select v from _ids where k='q1'), 'accepted', null);
  insert into _v values('backward transition answered->accepted refused', false, 'no error');
exception when others then
  insert into _v values('backward transition answered->accepted refused', sqlstate='40003', sqlstate);
end $$;

-- 7. answering a merely suggested question is refused
do $$
declare r jsonb; _q uuid;
begin
  r := public.run_lens_evaluation('eeeeeeee-0000-0000-0000-000000000041','naturopathic',
    '{}'::jsonb, now(),'[]'::jsonb,'lens-rules-v1','[]'::jsonb,null,null,null,'lens-output-v1',repeat('f',64),
    (select j from _core),'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('questionText','Sleep quality over the past two weeks?',
      'rationale','Sleep complaints influence cardiometabolic follow-up.','domainCode','sleep',
      'priority','low','answerType','scale',
      'knowledgeSourceCodes', jsonb_build_array('aasm_sleep_questions'),'dedupeKey','sleep-quality')));
  select id into _q from public.differential_questions where evaluation_id=(r->>'evaluationId')::uuid;
  insert into _ids values('q2', _q);
  begin
    perform public.answer_question(_q, '{"scale":3}'::jsonb);
    insert into _v values('answering an un-asked question refused', false, 'no error');
  exception when others then
    insert into _v values('answering an un-asked question refused', sqlstate='55000', sqlstate);
  end;
exception when others then
  insert into _v values('answering an un-asked question refused', false, sqlstate||' '||sqlerrm);
end $$;

-- 8. dismissal requires valid feedback and records it
do $$
begin
  begin
    perform public.dismiss_question((select v from _ids where k='q2'), 'because', null);
    insert into _v values('dismissal validates feedback kind', false, 'no error');
  exception when others then
    insert into _v values('dismissal validates feedback kind', sqlstate='22023', sqlstate);
  end;
  perform public.dismiss_question((select v from _ids where k='q2'), 'not_relevant', 'Sleep already reviewed today.');
  insert into _v select 'dismissal captures practitioner feedback',
    exists (select 1 from public.differential_questions where id=(select v from _ids where k='q2') and status='dismissed')
    and exists (select 1 from public.question_feedback where question_id=(select v from _ids where k='q2') and kind='not_relevant'), '';
exception when others then
  insert into _v values('dismissal captures practitioner feedback', false, sqlstate||' '||sqlerrm);
end $$;

-- 9. explicit add-to-note gate: draft notes only, audited
do $$
declare r jsonb; _note uuid;
begin
  r := public.save_note_draft('bbbbbbbb-0000-0000-0000-000000000041','eeeeeeee-0000-0000-0000-000000000041',
    'soap','{"S":"draft","O":"","A":"","P":""}'::jsonb,0,null,'manual','[]'::jsonb);
  _note := (r->>'note_id')::uuid;
  insert into _ids values('note1', _note);
  perform public.record_question_note_use((select v from _ids where k='q1'), _note);
  insert into _v select 'explicit add-to-note audited for a draft note',
    exists (select 1 from public.audit_events where action='lens.question_added_to_note'), '';
exception when others then
  insert into _v values('explicit add-to-note audited for a draft note', false, sqlstate||' '||sqlerrm);
end $$;

-- 10. stale propagation when a supporting source changes
do $$
begin
  insert into public.medications (organization_id, patient_id, name, status)
  values ('bbbbbbbb-0000-0000-0000-000000000041','cccccccc-0000-0000-0000-000000000041','sertraline','active');
  insert into _v select 'source change marks output stale (answered stays)',
    (select bool_and(stale) from public.lens_evaluations
      where patient_id='cccccccc-0000-0000-0000-000000000041' and superseded_by is null)
    and exists (select 1 from public.differential_questions where id=(select v from _ids where k='q1') and status='answered')
    and not exists (select 1 from public.differential_questions
      where patient_id='cccccccc-0000-0000-0000-000000000041' and status in ('suggested','accepted','deferred')), '';
exception when others then
  insert into _v values('source change marks output stale (answered stays)', false, sqlstate||' '||sqlerrm);
end $$;

-- 11. evaluation snapshot immutability (any role)
do $$
begin
  update public.lens_evaluations set invariant_core='{}'::jsonb where id=(select v from _ids where k='eval2');
  insert into _v values('invariant core cannot be altered after write', false, 'no error');
exception when others then
  insert into _v values('invariant core cannot be altered after write', sqlstate='22023', sqlstate);
end $$;

-- 12. cross-tenant + RLS
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000062","role":"authenticated"}', true);
do $$
begin
  perform public.run_lens_evaluation('eeeeeeee-0000-0000-0000-000000000041','western_conventional',
    '{}'::jsonb, now(),'[]'::jsonb,'v','[]'::jsonb,null,null,null,'s',repeat('9',64),
    (select j from _core),'{}'::jsonb,'[]'::jsonb);
  insert into _v values('cross-org evaluation refused', false, 'no error');
exception when others then
  insert into _v values('cross-org evaluation refused', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.set_question_status((select v from _ids where k='q1'), 'deferred', null);
  insert into _v values('cross-org question action refused', false, 'no error');
exception when others then
  insert into _v values('cross-org question action refused', sqlstate='42501', sqlstate);
end $$;
set local role authenticated;
insert into _v
select 'RLS: outsider sees no lens rows but reads shared reference data',
  (select count(*) from public.lens_evaluations)=0
  and (select count(*) from public.differential_questions)=0
  and (select count(*) from public.question_answers)=0
  and (select count(*) from public.clinical_paradigms)=6
  and (select count(*) from public.clinical_domains where active)=9
  and (select count(*) from public.clinical_knowledge_sources)>=7, '';
do $$
begin
  insert into public.differential_questions
    (organization_id, patient_id, encounter_id, evaluation_id, paradigm_code, domain_code,
     question_text, rationale, priority, answer_type, generation_method, generation_version, dedupe_key)
  values ('bbbbbbbb-0000-0000-0000-000000000042','cccccccc-0000-0000-0000-000000000042',
          'eeeeeeee-0000-0000-0000-000000000041', gen_random_uuid(), 'western_conventional','sleep',
          'x','y','low','free_text','deterministic_rules','v','k');
  insert into _v values('RLS: direct question insert refused', false, 'no error');
exception when others then
  insert into _v values('RLS: direct question insert refused', sqlstate='42501', sqlstate);
end $$;
reset role;

select name, passed, detail from _v order by name;
rollback;
