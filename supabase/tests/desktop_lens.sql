-- Desktop-owned lens boundary acceptance tests.
-- Rolled back: the project is unchanged after the final statement.
--
-- Covers the bounded Desktop read DTOs added by desktop_owned_lens, the
-- direct question-lifecycle RPCs (0024), version-preserving answers,
-- supersede semantics, cross-tenant refusal, and anonymous refusal.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v uuid) on commit drop;
grant all on _v, _ids to authenticated;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000301','desktop-lens-pract@verify.local'),
  ('11111111-0000-0000-0000-000000000302','desktop-lens-out@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000301','Desktop Lens Org','desktop-lens-0030'),
  ('bbbbbbbb-0000-0000-0000-000000000302','Desktop Lens Other','desktop-lens-other-0030');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000301','11111111-0000-0000-0000-000000000301','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000302','11111111-0000-0000-0000-000000000302','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000301','bbbbbbbb-0000-0000-0000-000000000301','Lens','Patient');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status)
values
  ('bbbbbbbb-0000-0000-0000-000000000301','11111111-0000-0000-0000-000000000301','cccccccc-0000-0000-0000-000000000301','active');

insert into _v
select 'authenticated can execute all Desktop lens reads',
  bool_and(has_function_privilege('authenticated', p.oid, 'execute')),
  string_agg(p.proname, ', ' order by p.proname)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public'
  and p.proname in (
    'list_desktop_lens_paradigms','list_desktop_lens_domains',
    'list_desktop_lens_knowledge_sources','get_desktop_lens_evaluation',
    'list_desktop_question_answers'
  );

insert into _v
select 'anon cannot execute Desktop lens reads',
  not bool_or(has_function_privilege('anon', p.oid, 'execute')),
  string_agg(p.proname, ', ' order by p.proname)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public'
  and p.proname in (
    'list_desktop_lens_paradigms','list_desktop_lens_domains',
    'list_desktop_lens_knowledge_sources','get_desktop_lens_evaluation',
    'list_desktop_question_answers'
  );

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000301","role":"authenticated"}',
  true
);

-- Reference reads mirror the seeded registry.
do $$
declare _p jsonb; _d jsonb; _k jsonb;
begin
  _p := public.list_desktop_lens_paradigms();
  _d := public.list_desktop_lens_domains();
  _k := public.list_desktop_lens_knowledge_sources();
  insert into _v values(
    'reference reads return seeded paradigms, domains, and registry sources',
    (_p @> '[{"code":"western_conventional"}]'::jsonb)
      and (_p @> '[{"code":"synergistic","isComposite":true}]'::jsonb)
      and (_d @> '[{"code":"sleep"}]'::jsonb)
      and (_k @> '[{"code":"aasm_sleep_questions"}]'::jsonb),
    jsonb_array_length(_p)::text || ' paradigms, '
      || jsonb_array_length(_d)::text || ' domains, '
      || jsonb_array_length(_k)::text || ' sources'
  );
exception when others then
  insert into _v values('reference reads return seeded paradigms, domains, and registry sources',false,sqlstate||' '||sqlerrm);
end $$;

-- Worker-persisted evaluation under the caller JWT (setup + assertion).
do $$
declare _e uuid; _r jsonb;
begin
  _e := public.start_encounter(
    'bbbbbbbb-0000-0000-0000-000000000301',
    'cccccccc-0000-0000-0000-000000000301',
    'follow-up',
    null
  );
  insert into _ids values ('encounter', _e);
  _r := public.run_lens_evaluation(
    _e, 'western_conventional',
    '{"counts":{"biomarkers":1}}'::jsonb, now(),
    '[{"ref":"biomarker_observation:seed","updatedAt":"2026-07-29T00:00:00Z"}]'::jsonb,
    'lens-rules-v1',
    '[{"code":"aasm_sleep_questions","revision":1}]'::jsonb,
    null, null, null,
    'lens-output-v1', repeat('a', 64),
    '{"objectiveFacts":[],"provenance":[],"missingInformation":[],"conflicts":[],
      "allergies":[],"interactions":[],"criticalLabs":[],"redFlags":[],
      "emergencyConsiderations":[],"evidenceQuality":[],"limitations":[]}'::jsonb,
    '{"ranking":[]}'::jsonb,
    '[{"domainCode":"sleep","questionText":"How many hours do you sleep on a typical night?",
       "rationale":"Sleep complaint present; quantify baseline.","priority":"medium",
       "answerType":"free_text","knowledgeSourceCodes":["aasm_sleep_questions"],
       "dedupeKey":"lens-accept-sleep-1"},
      {"domainCode":"sleep","questionText":"Has anyone witnessed pauses in your breathing during sleep?",
       "rationale":"Screens the apnea safety consideration.","priority":"high",
       "answerType":"yes_no","knowledgeSourceCodes":["aasm_sleep_questions"],
       "dedupeKey":"lens-accept-sleep-2"}]'::jsonb
  );
  insert into _v values(
    'worker evaluation persists atomically under the caller JWT',
    (_r->>'status')='complete' and (_r->>'questionsInserted')='2',
    _r::text
  );
  insert into _ids values ('evaluation', (_r->>'evaluationId')::uuid);
exception when others then
  insert into _v values('worker evaluation persists atomically under the caller JWT',false,sqlstate||' '||sqlerrm);
end $$;

-- Bounded evaluation DTO: exact top-level shape, exact question shape.
do $$
declare _r jsonb; _keys text[]; _qkeys text[];
begin
  _r := public.get_desktop_lens_evaluation(
    (select v from _ids where k='encounter'), 'western_conventional');
  select array_agg(k order by k) into _keys from jsonb_object_keys(_r) k;
  select array_agg(k order by k) into _qkeys from jsonb_object_keys(_r->'questions'->0) k;
  insert into _v values(
    'evaluation DTO carries the exact bounded shape',
    _keys = array['createdAt','evaluationId','inputCutoffAt','inputSnapshot','invariantCore',
                  'knowledgeVersions','lensFraming','model','outputSchemaVersion','outputSha256',
                  'paradigm','promptTemplateVersion','provider','questions','ruleSetVersion',
                  'safetyBlocks','stale','staleReason','status','validationResult'],
    array_to_string(_keys, ',')
  );
  insert into _v values(
    'question DTO carries the exact bounded shape',
    _qkeys = array['answerType','createdAt','distinguishes','domainCode','generationMethod',
                   'generationVersion','id','knowledgeSourceIds','missingDataAssumptions',
                   'patientSources','priority','questionText','rationale','safetyRelation',
                   'status','statusReason'],
    array_to_string(_qkeys, ',')
  );
  insert into _ids
  select 'question', (q->>'id')::uuid
  from jsonb_array_elements(_r->'questions') q
  where q->>'questionText' like 'How many hours%';
exception when others then
  insert into _v values('evaluation DTO carries the exact bounded shape',false,sqlstate||' '||sqlerrm);
end $$;

-- No evaluation for another paradigm → SQL NULL, never an invented row.
do $$
begin
  insert into _v values(
    'missing evaluation returns null for an unevaluated paradigm',
    public.get_desktop_lens_evaluation((select v from _ids where k='encounter'), 'tcm') is null,
    'tcm'
  );
exception when others then
  insert into _v values('missing evaluation returns null for an unevaluated paradigm',false,sqlstate||' '||sqlerrm);
end $$;

-- Unknown paradigm is a hard rejection.
do $$
begin
  perform public.get_desktop_lens_evaluation((select v from _ids where k='encounter'), 'astrology');
  insert into _v values('unknown paradigm is refused',false,'no error');
exception when others then
  insert into _v values('unknown paradigm is refused', sqlstate='22023', sqlstate);
end $$;

-- Lifecycle: suggested → accepted → asked through the direct RPC.
do $$
begin
  perform public.set_question_status((select v from _ids where k='question'), 'accepted', null);
  perform public.set_question_status((select v from _ids where k='question'), 'asked', null);
  insert into _v values(
    'question lifecycle transitions through the direct RPCs',
    (select status from public.differential_questions
     where id=(select v from _ids where k='question'))='asked',
    'suggested -> accepted -> asked'
  );
exception when others then
  insert into _v values('question lifecycle transitions through the direct RPCs',false,sqlstate||' '||sqlerrm);
end $$;

-- Invalid transition refused with the state-machine errcode.
do $$
begin
  perform public.set_question_status((select v from _ids where k='question'), 'skipped', null);
  insert into _v values('invalid lifecycle transition is refused',false,'no error');
exception when others then
  insert into _v values('invalid lifecycle transition is refused', sqlstate='40003', sqlstate);
end $$;

-- Answer + correction: versions append; originals are preserved.
do $$
declare _v1 integer; _v2 integer; _a jsonb;
begin
  _v1 := public.answer_question((select v from _ids where k='question'), '{"text":"About five hours"}'::jsonb);
  _v2 := public.correct_question_answer((select v from _ids where k='question'), '{"text":"About six hours"}'::jsonb, 'patient corrected');
  _a := public.list_desktop_question_answers((select v from _ids where k='question'));
  insert into _v values(
    'answers version and corrections preserve the original',
    _v1=1 and _v2=2 and jsonb_array_length(_a)=2
      and (_a->0->>'version')='1' and (_a->0->>'correctsVersion') is null
      and (_a->0->'value'->>'text')='About five hours'
      and (_a->1->>'correctsVersion')='1'
      and (_a->1->>'correctionReason')='patient corrected',
    _a::text
  );
exception when others then
  insert into _v values('answers version and corrections preserve the original',false,sqlstate||' '||sqlerrm);
end $$;

-- Answering a non-asked question is a precondition failure.
do $$
declare _q uuid;
begin
  select (q->>'id')::uuid into _q
  from jsonb_array_elements(
    public.get_desktop_lens_evaluation((select v from _ids where k='encounter'), 'western_conventional')->'questions') q
  where q->>'questionText' like 'Has anyone witnessed%';
  perform public.answer_question(_q, '{"value":true}'::jsonb);
  insert into _v values('answering a non-asked question is refused',false,'no error');
exception when others then
  insert into _v values('answering a non-asked question is refused', sqlstate='55000', sqlstate);
end $$;

-- A newer run supersedes the prior evaluation; answered questions stay
-- historical clinical facts in the encounter-scoped worklist.
do $$
declare _r jsonb; _read jsonb;
begin
  _r := public.run_lens_evaluation(
    (select v from _ids where k='encounter'), 'western_conventional',
    '{"counts":{"biomarkers":2}}'::jsonb, now(),
    '[{"ref":"biomarker_observation:seed2","updatedAt":"2026-07-29T01:00:00Z"}]'::jsonb,
    'lens-rules-v1',
    '[{"code":"aasm_sleep_questions","revision":1}]'::jsonb,
    null, null, null,
    'lens-output-v1', repeat('b', 64),
    '{"objectiveFacts":[],"provenance":[],"missingInformation":[],"conflicts":[],
      "allergies":[],"interactions":[],"criticalLabs":[],"redFlags":[],
      "emergencyConsiderations":[],"evidenceQuality":[],"limitations":[]}'::jsonb,
    '{"ranking":[]}'::jsonb,
    '[{"domainCode":"sleep","questionText":"Do you snore loudly most nights?",
       "rationale":"Follow-up screening question.","priority":"medium",
       "answerType":"yes_no","knowledgeSourceCodes":["aasm_sleep_questions"],
       "dedupeKey":"lens-accept-sleep-3"}]'::jsonb
  );
  _read := public.get_desktop_lens_evaluation(
    (select v from _ids where k='encounter'), 'western_conventional');
  insert into _v values(
    'a newer run supersedes the prior evaluation and keeps answered history',
    (_read->>'evaluationId')=(_r->>'evaluationId')
      and (select superseded_by is not null from public.lens_evaluations
           where id=(select v from _ids where k='evaluation'))
      and _read->'questions' @> '[{"status":"answered"}]'::jsonb
      and _read->'questions' @> '[{"status":"superseded"}]'::jsonb,
    _read->>'evaluationId'
  );
exception when others then
  insert into _v values('a newer run supersedes the prior evaluation and keeps answered history',false,sqlstate||' '||sqlerrm);
end $$;

-- Cross-tenant refusal: an outsider practitioner sees nothing.
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000302","role":"authenticated"}',
  true
);

do $$
begin
  perform public.get_desktop_lens_evaluation((select v from _ids where k='encounter'), 'western_conventional');
  insert into _v values('cross-tenant evaluation read is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant evaluation read is refused', sqlstate='42501', sqlstate);
end $$;

do $$
begin
  perform public.list_desktop_question_answers((select v from _ids where k='question'));
  insert into _v values('cross-tenant answer read is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant answer read is refused', sqlstate='42501', sqlstate);
end $$;

do $$
begin
  perform public.set_question_status((select v from _ids where k='question'), 'deferred', null);
  insert into _v values('cross-tenant lifecycle mutation is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant lifecycle mutation is refused', sqlstate='42501', sqlstate);
end $$;

-- Anonymous refusal.
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$
begin
  perform public.list_desktop_lens_paradigms();
  insert into _v values('anonymous lens read is refused',false,'no error');
exception when others then
  insert into _v values('anonymous lens read is refused', sqlstate='28000', sqlstate);
end $$;

select name, passed, detail from _v order by name;
rollback;
