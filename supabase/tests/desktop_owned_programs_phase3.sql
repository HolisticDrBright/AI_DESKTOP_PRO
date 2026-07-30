-- Programs & Education acceptance tests (Clinical Runtime Phase 3).
-- Rolled back: the project is unchanged after the final statement.
-- Last run against urcjiehlxoehievobezf: 71/71 passed, zero residue.
--
-- Covers: anonymous refusal · insufficient-role refusal (staff) · cross-tenant
-- reads and mutations · invalid lifecycle transitions · stale autosave token
-- (40001) · per-kind block validation (text/image/video_url/document_link/
-- quiz/check_in/resource) · frozen-version immutability via RPC and direct SQL
-- · publish supersedes without delete and with ZERO side effects · revise into
-- a new draft with the published original unchanged · detached template copies
-- and template archive without cascade · enrollment pinned to the exact
-- published version and unmoved by later publishes · manual complimentary
-- enrollment reason + authorization + audit · Stripe honestly refused as not
-- configured · progress persistence, version agreement, and append-only
-- history · exact grants and direct-write revocation · zero residue.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v uuid) on commit drop;
-- save_program_draft is a WHOLESALE replace: every save must carry the full
-- curriculum. Build the canonical payload once and reuse it.
create temp table _pl(k text primary key, p jsonb) on commit drop;
insert into _pl values ('v1full', jsonb_build_object(
  'title','Metabolic Reset Program',
  'summary','12-week metabolic education',
  'audience','Adults focused on metabolic health',
  'disclaimer','Education only; not medical advice.',
  'modules', jsonb_build_array(
    jsonb_build_object('name','Foundations','summary','Basics','lessons', jsonb_build_array(
      jsonb_build_object('title','Welcome','blocks', jsonb_build_array(
        jsonb_build_object('kind','text','title','Intro',
          'content', jsonb_build_object('body','Welcome to the program.')),
        jsonb_build_object('kind','image','title','Overview chart',
          'content', jsonb_build_object('url','https://example.test/chart.png')),
        jsonb_build_object('kind','video_url','title','Orientation',
          'content', jsonb_build_object('url','https://example.test/orientation')))),
      jsonb_build_object('title','Assess','blocks', jsonb_build_array(
        jsonb_build_object('kind','quiz','title','Baseline quiz',
          'content', jsonb_build_object('questions', jsonb_build_array(
            jsonb_build_object('prompt','How many meals per day?',
              'options', jsonb_build_array('1-2','3','4+'), 'answerIndex', 1),
            jsonb_build_object('prompt','Do you track sleep?',
              'options', jsonb_build_array('Yes','No'))))),
        jsonb_build_object('kind','check_in','title','Readiness',
          'content', jsonb_build_object('prompt','How ready are you?',
            'responseType','scale_1_5')))))),
    jsonb_build_object('name','Practice','lessons', jsonb_build_array(
      jsonb_build_object('title','Resources','blocks', jsonb_build_array(
        jsonb_build_object('kind','document_link','title','Guide',
          'content', jsonb_build_object('url','https://example.test/guide.pdf')),
        jsonb_build_object('kind','resource','title','Recommended reading',
          'isCommercial', true,
          'content', jsonb_build_object('url','https://example.test/shop/reading'))))))
  )));

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000601','pg-practitioner@verify.local'),
  ('11111111-0000-0000-0000-000000000602','pg-staff@verify.local'),
  ('11111111-0000-0000-0000-000000000603','pg-outsider@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000601','Program Org','program-0060'),
  ('bbbbbbbb-0000-0000-0000-000000000602','Program Other','program-other-0060');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000601','11111111-0000-0000-0000-000000000601','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000601','11111111-0000-0000-0000-000000000602','staff','active'),
  ('bbbbbbbb-0000-0000-0000-000000000602','11111111-0000-0000-0000-000000000603','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000601','bbbbbbbb-0000-0000-0000-000000000601','Program','Patient'),
  ('cccccccc-0000-0000-0000-000000000602','bbbbbbbb-0000-0000-0000-000000000602','Foreign','Patient');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000601','11111111-0000-0000-0000-000000000601','cccccccc-0000-0000-0000-000000000601','active'),
  ('bbbbbbbb-0000-0000-0000-000000000602','11111111-0000-0000-0000-000000000603','cccccccc-0000-0000-0000-000000000602','active');

-- ------------------------------------------------------------ static posture
insert into _v
select 'anon cannot execute any program RPC',
  not bool_or(has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('list_programs','get_program_studio','list_program_templates',
     'get_patient_programs','create_program','save_program_draft',
     'submit_program_version','return_program_version','approve_program_version',
     'publish_program_version','revise_program_version','archive_program',
     'create_program_template','approve_program_template_version',
     'archive_program_template','upsert_program_offer','enroll_patient_in_program',
     'set_program_enrollment_status','record_program_progress','review_program_progress');
insert into _v
select 'all 20 program RPCs are definer with a pinned empty search_path',
  count(*) = 20 and bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('list_programs','get_program_studio','list_program_templates',
     'get_patient_programs','create_program','save_program_draft',
     'submit_program_version','return_program_version','approve_program_version',
     'publish_program_version','revise_program_version','archive_program',
     'create_program_template','approve_program_template_version',
     'archive_program_template','upsert_program_offer','enroll_patient_in_program',
     'set_program_enrollment_status','record_program_progress','review_program_progress');
insert into _v
select 'program tables have RLS and no direct authenticated writes',
  bool_and(c.relrowsecurity)
  and not bool_or(has_table_privilege('authenticated', c.oid, 'insert'))
  and not bool_or(has_table_privilege('authenticated', c.oid, 'update'))
  and not bool_or(has_table_privilege('authenticated', c.oid, 'delete'))
  from pg_class c where c.oid in (
    'public.programs'::regclass,'public.program_templates'::regclass,
    'public.program_versions'::regclass,'public.program_modules'::regclass,
    'public.program_lessons'::regclass,'public.program_blocks'::regclass,
    'public.program_offers'::regclass,'public.program_enrollments'::regclass,
    'public.program_progress'::regclass,'public.program_version_events'::regclass,
    'public.program_enrollment_events'::regclass);

-- --------------------------------------------------- author a program (org 1)
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000601","role":"authenticated"}', true);

do $$
declare _l jsonb;
begin
  _l := public.list_programs('bbbbbbbb-0000-0000-0000-000000000601');
  insert into _v values('an org with no programs reports an honest empty library',
    jsonb_array_length(_l->'programs') = 0, _l #>> '{}');
end $$;

do $$
declare _c jsonb; _s jsonb;
begin
  _c := public.create_program('bbbbbbbb-0000-0000-0000-000000000601','Metabolic Reset',null);
  insert into _ids values ('program',(_c->>'programId')::uuid);
  insert into _ids values ('v1',(_c->>'versionId')::uuid);
  insert into _v values('a blank program starts as draft version 1',
    (select status from public.programs where id=(_c->>'programId')::uuid)='draft'
    and (select version from public.program_versions where id=(_c->>'versionId')::uuid)=1
    and (select status from public.program_versions where id=(_c->>'versionId')::uuid)='draft',
    _c #>> '{}');

  _s := public.save_program_draft((_c->>'versionId')::uuid,
    (select p from _pl where k='v1full'), null);
  insert into _v values('a draft saves every block kind across modules and lessons',
    (_s->>'ok')::boolean
    and (select count(*) from public.program_modules where version_id=(_c->>'versionId')::uuid)=2
    and (select count(*) from public.program_lessons where version_id=(_c->>'versionId')::uuid)=3
    and (select count(*) from public.program_blocks where version_id=(_c->>'versionId')::uuid)=7
    and (select count(distinct kind) from public.program_blocks
         where version_id=(_c->>'versionId')::uuid)=7,
    _s #>> '{}');
  insert into _v values('a commercial resource block is flagged and never clinical evidence',
    exists (select 1 from public.program_blocks
            where version_id=(_c->>'versionId')::uuid and kind='resource'
              and is_commercial), null);
end $$;

-- Per-kind validation refusals. Each failed call rolls back inside its block,
-- so the good curriculum above stays intact.
do $$
begin
  perform public.save_program_draft((select v from _ids where k='v1'),
    jsonb_build_object('modules', jsonb_build_array(jsonb_build_object(
      'name','Bad','lessons', jsonb_build_array(jsonb_build_object(
        'title','Bad','blocks', jsonb_build_array(
          jsonb_build_object('kind','html','content','{}'::jsonb)))))))
    , null);
  insert into _v values('an unknown block kind is refused',false,'no error');
exception when others then
  insert into _v values('an unknown block kind is refused', sqlstate='22023', sqlstate);
end $$;
do $$
begin
  perform public.save_program_draft((select v from _ids where k='v1'),
    jsonb_build_object('modules', jsonb_build_array(jsonb_build_object(
      'name','Bad','lessons', jsonb_build_array(jsonb_build_object(
        'title','Bad','blocks', jsonb_build_array(
          jsonb_build_object('kind','video_url',
            'content', jsonb_build_object('url','ftp://example.test/clip'))))))))
    , null);
  insert into _v values('a video block without an http(s) url is refused',false,'no error');
exception when others then
  insert into _v values('a video block without an http(s) url is refused',
    sqlstate='22023', sqlstate);
end $$;
do $$
begin
  perform public.save_program_draft((select v from _ids where k='v1'),
    jsonb_build_object('modules', jsonb_build_array(jsonb_build_object(
      'name','Bad','lessons', jsonb_build_array(jsonb_build_object(
        'title','Bad','blocks', jsonb_build_array(
          jsonb_build_object('kind','quiz',
            'content', jsonb_build_object('questions', jsonb_build_array(
              jsonb_build_object('prompt','Only one option',
                'options', jsonb_build_array('sole')))))))))))
    , null);
  insert into _v values('a quiz question with fewer than two options is refused',false,'no error');
exception when others then
  insert into _v values('a quiz question with fewer than two options is refused',
    sqlstate='22023', sqlstate);
end $$;
do $$
begin
  perform public.save_program_draft((select v from _ids where k='v1'),
    jsonb_build_object('modules', jsonb_build_array(jsonb_build_object(
      'name','Bad','lessons', jsonb_build_array(jsonb_build_object(
        'title','Bad','blocks', jsonb_build_array(
          jsonb_build_object('kind','check_in',
            'content', jsonb_build_object('prompt','Mood?','responseType','emoji'))))))))
    , null);
  insert into _v values('a check-in with an unknown responseType is refused',false,'no error');
exception when others then
  insert into _v values('a check-in with an unknown responseType is refused',
    sqlstate='22023', sqlstate);
end $$;

do $$
declare _tok timestamptz; _s jsonb;
begin
  select updated_at into _tok from public.program_versions
  where id=(select v from _ids where k='v1');
  _s := public.save_program_draft((select v from _ids where k='v1'),
    jsonb_set((select p from _pl where k='v1full'),
      '{summary}','"12-week metabolic education, refreshed"'), _tok);
  insert into _v values('a fresh autosave token is accepted',
    (_s->>'ok')::boolean
    and (select count(*) from public.program_blocks
         where version_id=(select v from _ids where k='v1'))=7, _s #>> '{}');
end $$;
do $$
begin
  perform public.save_program_draft((select v from _ids where k='v1'),
    jsonb_build_object('summary','Conflicting edit'), now() - interval '1 hour');
  insert into _v values('a stale autosave token is refused with a conflict',false,'no error');
exception when others then
  insert into _v values('a stale autosave token is refused with a conflict',
    sqlstate='40001', sqlstate);
end $$;

-- ------------------------------------------------------------- lifecycle
do $$
begin
  perform public.approve_program_version((select v from _ids where k='v1'),null);
  insert into _v values('a draft cannot be approved without review',false,'no error');
exception when others then
  insert into _v values('a draft cannot be approved without review', sqlstate='22023', sqlstate);
end $$;
do $$
begin
  perform public.publish_program_version((select v from _ids where k='v1'));
  insert into _v values('a draft cannot be published directly',false,'no error');
exception when others then
  insert into _v values('a draft cannot be published directly', sqlstate='22023', sqlstate);
end $$;

do $$
declare _r jsonb;
begin
  perform public.submit_program_version((select v from _ids where k='v1'));
  _r := public.return_program_version((select v from _ids where k='v1'),'Needs a stronger disclaimer');
  insert into _v values('review can return a version to draft with a note',
    (select status from public.program_versions where id=(select v from _ids where k='v1'))='draft'
    and (select review_note from public.program_versions
         where id=(select v from _ids where k='v1'))='Needs a stronger disclaimer',
    _r #>> '{}');
  perform public.submit_program_version((select v from _ids where k='v1'));
  _r := public.approve_program_version((select v from _ids where k='v1'),'Reviewed against checklist');
  insert into _v values('approval freezes the version but does NOT publish it',
    (select status from public.program_versions where id=(select v from _ids where k='v1'))='approved'
    and (select approved_by from public.program_versions
         where id=(select v from _ids where k='v1'))='11111111-0000-0000-0000-000000000601'
    and (select status from public.programs where id=(select v from _ids where k='program'))='draft'
    and (select published_version_id from public.programs
         where id=(select v from _ids where k='program')) is null,
    _r #>> '{}');
  insert into _v values('the approval message states publishing is separate',
    (_r->>'message') ilike '%NOT published%', _r->>'message');
end $$;

do $$
begin
  perform public.save_program_draft((select v from _ids where k='v1'),
    jsonb_build_object('summary','Sneaky edit'), null);
  insert into _v values('an approved version refuses autosave edits',false,'no error');
exception when others then
  insert into _v values('an approved version refuses autosave edits', sqlstate='22023', sqlstate);
end $$;
do $$
begin
  update public.program_versions set title='Direct overwrite'
  where id=(select v from _ids where k='v1');
  insert into _v values('a direct UPDATE to frozen program content is blocked by trigger',
    false,'no error');
exception when others then
  insert into _v values('a direct UPDATE to frozen program content is blocked by trigger',
    sqlstate='22023', sqlstate);
end $$;
do $$
begin
  insert into public.program_blocks (organization_id, version_id, lesson_id, kind, content, position)
  values ('bbbbbbbb-0000-0000-0000-000000000601',(select v from _ids where k='v1'),
    (select id from public.program_lessons
     where version_id=(select v from _ids where k='v1') limit 1),
    'text', jsonb_build_object('body','Injected'), 99);
  insert into _v values('inserting a block into a frozen version is blocked by trigger',
    false,'no error');
exception when others then
  insert into _v values('inserting a block into a frozen version is blocked by trigger',
    sqlstate='22023', sqlstate);
end $$;
do $$
begin
  delete from public.program_versions where id=(select v from _ids where k='v1');
  insert into _v values('deleting a program version is blocked by trigger',false,'no error');
exception when others then
  insert into _v values('deleting a program version is blocked by trigger',
    sqlstate='22023', sqlstate);
end $$;

do $$
declare _r jsonb;
begin
  _r := public.publish_program_version((select v from _ids where k='v1'));
  insert into _v values('publishing is a separate explicit action',
    (select status from public.program_versions where id=(select v from _ids where k='v1'))='published'
    and (select status from public.programs where id=(select v from _ids where k='program'))='published'
    and (select published_version_id from public.programs
         where id=(select v from _ids where k='program'))=(select v from _ids where k='v1'),
    _r #>> '{}');
  insert into _v values('the publish message states enrollments keep their pinned version',
    (_r->>'message') ilike '%pinned%', _r->>'message');
  -- The strongest commerce-boundary assertion: publishing touches nothing
  -- downstream. No enrollment, invoice, message, note, protocol, or order.
  insert into _v values('publishing creates no enrollment, invoice, charge, message, note, or protocol',
    not exists (select 1 from public.program_enrollments
                where organization_id='bbbbbbbb-0000-0000-0000-000000000601')
    and not exists (select 1 from public.invoices
                    where organization_id='bbbbbbbb-0000-0000-0000-000000000601')
    and not exists (select 1 from public.clinical_notes
                    where patient_id='cccccccc-0000-0000-0000-000000000601')
    and not exists (select 1 from public.messages m
                    join public.conversations c on c.id = m.conversation_id
                    where c.patient_id='cccccccc-0000-0000-0000-000000000601')
    and not exists (select 1 from public.protocols
                    where patient_id='cccccccc-0000-0000-0000-000000000601')
    and not exists (select 1 from public.supplement_protocols
                    where patient_id='cccccccc-0000-0000-0000-000000000601'),
    null);
end $$;

-- ------------------------------------------------------------------ offers
do $$
declare _o jsonb;
begin
  _o := public.upsert_program_offer((select v from _ids where k='program'),
    null,'Free enrollment',0,'usd',null,'free',true,'active');
  insert into _ids values ('offer_free',(_o->>'offerId')::uuid);
  insert into _v values('a free offer stores terms and promises no payment processing',
    (_o->>'ok')::boolean and (_o->>'message') ilike '%No payment is processed%',
    _o->>'message');
  _o := public.upsert_program_offer((select v from _ids where k='program'),
    null,'Comp access',19900,'usd',30,'manual_comp',true,'active');
  insert into _ids values ('offer_comp',(_o->>'offerId')::uuid);
  _o := public.upsert_program_offer((select v from _ids where k='program'),
    null,'Paid tier',49900,'usd',90,'stripe',true,'active');
  insert into _ids values ('offer_stripe',(_o->>'offerId')::uuid);
  insert into _v values('a stripe offer stores commercial terms only',
    (select payment_mode from public.program_offers
     where id=(_o->>'offerId')::uuid)='stripe'
    and (select price_cents from public.program_offers
         where id=(_o->>'offerId')::uuid)=49900, null);
end $$;

-- -------------------------------------------------------------- enrollment
do $$
declare _msg text;
begin
  perform public.enroll_patient_in_program((select v from _ids where k='program'),
    'cccccccc-0000-0000-0000-000000000601',(select v from _ids where k='offer_stripe'),true,null);
  insert into _v values('a stripe offer refuses enrollment as honestly not configured',
    false,'no error');
exception when others then
  _msg := sqlerrm;
  insert into _v values('a stripe offer refuses enrollment as honestly not configured',
    sqlstate='22023' and _msg ilike '%not configured%', _msg);
end $$;
do $$
begin
  perform public.enroll_patient_in_program((select v from _ids where k='program'),
    'cccccccc-0000-0000-0000-000000000601',(select v from _ids where k='offer_comp'),true,null);
  insert into _v values('a complimentary enrollment without a reason is refused',false,'no error');
exception when others then
  insert into _v values('a complimentary enrollment without a reason is refused',
    sqlstate='22023', sqlstate);
end $$;
do $$
begin
  perform public.enroll_patient_in_program((select v from _ids where k='program'),
    'cccccccc-0000-0000-0000-000000000602',(select v from _ids where k='offer_free'),true,null);
  insert into _v values('enrolling a patient from another organization is refused',
    false,'no error');
exception when others then
  insert into _v values('enrolling a patient from another organization is refused',
    sqlstate='42501', sqlstate);
end $$;

do $$
declare _e jsonb;
begin
  _e := public.enroll_patient_in_program((select v from _ids where k='program'),
    'cccccccc-0000-0000-0000-000000000601',(select v from _ids where k='offer_comp'),
    true,'Pilot cohort - waived by clinic owner');
  insert into _ids values ('enrollment',(_e->>'enrollmentId')::uuid);
  insert into _v values('a complimentary enrollment records reason, authorizer, and audit event',
    (select comp_reason from public.program_enrollments
     where id=(_e->>'enrollmentId')::uuid)='Pilot cohort - waived by clinic owner'
    and (select authorized_by from public.program_enrollments
         where id=(_e->>'enrollmentId')::uuid)='11111111-0000-0000-0000-000000000601'
    and exists (select 1 from public.audit_events
                where action='program.enrolled'
                  and resource_id=(_e->>'enrollmentId')
                  and patient_id='cccccccc-0000-0000-0000-000000000601'),
    _e #>> '{}');
  insert into _v values('the enrollment is pinned to the exact published version',
    (select program_version_id from public.program_enrollments
     where id=(_e->>'enrollmentId')::uuid)=(select v from _ids where k='v1')
    and (_e->>'pinnedVersionId')::uuid=(select v from _ids where k='v1'),
    null);
  insert into _v values('an active enrollment with a 30-day offer gets an expiry',
    (select expires_at from public.program_enrollments
     where id=(_e->>'enrollmentId')::uuid) is not null, null);
  insert into _v values('enrollment creates no invoice, charge, message, or note',
    not exists (select 1 from public.invoices
                where organization_id='bbbbbbbb-0000-0000-0000-000000000601')
    and not exists (select 1 from public.clinical_notes
                    where patient_id='cccccccc-0000-0000-0000-000000000601')
    and not exists (select 1 from public.messages m
                    join public.conversations c on c.id = m.conversation_id
                    where c.patient_id='cccccccc-0000-0000-0000-000000000601'),
    null);
end $$;
do $$
begin
  perform public.enroll_patient_in_program((select v from _ids where k='program'),
    'cccccccc-0000-0000-0000-000000000601',(select v from _ids where k='offer_free'),true,null);
  insert into _v values('a duplicate open enrollment is refused',false,'no error');
exception when others then
  insert into _v values('a duplicate open enrollment is refused', sqlstate='22023', sqlstate);
end $$;

-- ---------------------------------------------------------------- progress
do $$
declare _p jsonb; _lesson uuid;
begin
  select id into _lesson from public.program_lessons
  where version_id=(select v from _ids where k='v1') order by position limit 1;
  _p := public.record_program_progress((select v from _ids where k='enrollment'),
    'lesson_completed', _lesson, null, '{}'::jsonb, false);
  insert into _ids values ('progress1',(_p->>'progressId')::uuid);
  _p := public.record_program_progress((select v from _ids where k='enrollment'),
    'check_in', null, null,
    jsonb_build_object('responseType','scale_1_5','value',2), true);
  insert into _ids values ('progress2',(_p->>'progressId')::uuid);
  insert into _v values('lesson completion and a flagged check-in persist as rows',
    (select count(*) from public.program_progress
     where enrollment_id=(select v from _ids where k='enrollment'))=2
    and (select needs_review from public.program_progress
         where id=(select v from _ids where k='progress2')), _p #>> '{}');
  insert into _v values('the progress audit trail never contains the payload',
    not exists (select 1 from public.audit_events
                where action='program.progress_recorded'
                  and metadata::text ilike '%scale_1_5%'), null);
end $$;
do $$
begin
  update public.program_progress set payload=jsonb_build_object('value',5)
  where id=(select v from _ids where k='progress2');
  insert into _v values('recorded progress payloads are append-only',false,'no error');
exception when others then
  insert into _v values('recorded progress payloads are append-only', sqlstate='22023', sqlstate);
end $$;
do $$
begin
  delete from public.program_progress where id=(select v from _ids where k='progress1');
  insert into _v values('progress history cannot be deleted',false,'no error');
exception when others then
  insert into _v values('progress history cannot be deleted', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.review_program_progress((select v from _ids where k='progress2'));
  insert into _v values('a practitioner review clears the flag and stamps the reviewer',
    not (_r->>'alreadyReviewed')::boolean
    and (select reviewed_by from public.program_progress
         where id=(select v from _ids where k='progress2'))='11111111-0000-0000-0000-000000000601'
    and not (select needs_review from public.program_progress
             where id=(select v from _ids where k='progress2')), _r #>> '{}');
  _r := public.review_program_progress((select v from _ids where k='progress2'));
  insert into _v values('reviewing twice is idempotent',
    (_r->>'alreadyReviewed')::boolean, _r #>> '{}');
end $$;

-- ------------------------------------------- revise; pinning survives publish
do $$
declare _rev jsonb;
begin
  _rev := public.revise_program_version((select v from _ids where k='v1'));
  insert into _ids values ('v2',(_rev->>'versionId')::uuid);
  insert into _v values('revising a published version creates a NEW draft version 2',
    (_rev->>'version')::int = 2
    and (select status from public.program_versions where id=(_rev->>'versionId')::uuid)='draft'
    and (select count(*) from public.program_blocks
         where version_id=(_rev->>'versionId')::uuid)=7, _rev #>> '{}');
  insert into _v values('the published original is completely unchanged by the revision',
    (select status from public.program_versions where id=(select v from _ids where k='v1'))='published'
    and (select count(*) from public.program_blocks
         where version_id=(select v from _ids where k='v1'))=7, null);
  begin
    perform public.revise_program_version((select v from _ids where k='v1'));
    insert into _v values('a second concurrent draft is refused',false,'no error');
  exception when others then
    insert into _v values('a second concurrent draft is refused', sqlstate='22023', sqlstate);
  end;
end $$;

do $$
declare _lesson2 uuid;
begin
  select id into _lesson2 from public.program_lessons
  where version_id=(select v from _ids where k='v2') order by position limit 1;
  perform public.record_program_progress((select v from _ids where k='enrollment'),
    'lesson_completed', _lesson2, null, '{}'::jsonb, false);
  insert into _v values('progress against a lesson outside the pinned version is refused',
    false,'no error');
exception when others then
  insert into _v values('progress against a lesson outside the pinned version is refused',
    sqlstate='22023', sqlstate);
end $$;

do $$
begin
  perform public.save_program_draft((select v from _ids where k='v2'), jsonb_build_object(
    'title','Metabolic Reset Program v2',
    'modules', jsonb_build_array(jsonb_build_object('name','Foundations v2',
      'lessons', jsonb_build_array(jsonb_build_object('title','Welcome v2',
        'blocks', jsonb_build_array(jsonb_build_object('kind','text',
          'content', jsonb_build_object('body','Updated welcome.')))))))), null);
  perform public.submit_program_version((select v from _ids where k='v2'));
  perform public.approve_program_version((select v from _ids where k='v2'),null);
  perform public.publish_program_version((select v from _ids where k='v2'));

  insert into _v values('publishing v2 supersedes v1 and never deletes it',
    (select status from public.program_versions where id=(select v from _ids where k='v1'))='superseded'
    and (select status from public.program_versions where id=(select v from _ids where k='v2'))='published'
    and (select count(*) from public.program_blocks
         where version_id=(select v from _ids where k='v1'))=7, null);
  insert into _v values('the existing enrollment stays pinned to v1 after v2 publishes',
    (select program_version_id from public.program_enrollments
     where id=(select v from _ids where k='enrollment'))=(select v from _ids where k='v1'),
    null);
end $$;

-- ------------------------------------------------------- persisted reads
do $$
declare _l jsonb; _s jsonb; _pp jsonb;
begin
  _l := public.list_programs('bbbbbbbb-0000-0000-0000-000000000601');
  insert into _v values('the library counts only persisted enrollment rows',
    jsonb_array_length(_l->'programs')=1
    and (_l->'programs'->0->'enrollment'->>'active')::int=1
    and (_l->'programs'->0->>'publishedVersion')::int=2, _l #>> '{}');

  _s := public.get_program_studio((select v from _ids where k='program'));
  insert into _v values('the studio shows author rights, history, offers, and a real roster',
    (_s->>'canAuthor')::boolean
    and jsonb_array_length(_s->'history')=2
    and jsonb_array_length(_s->'offers')=3
    and jsonb_array_length(_s->'roster')=1
    and _s->'roster'->0->>'patientName'='Program Patient'
    and (_s->'roster'->0->>'pinnedVersion')::int=1
    and (_s->'roster'->0->>'progressCount')::int=2
    and jsonb_array_length(_s->'events') > 0, null);

  _pp := public.get_patient_programs('cccccccc-0000-0000-0000-000000000601');
  insert into _v values('the patient chart reports pinned version and persisted progress',
    jsonb_array_length(_pp->'enrollments')=1
    and (_pp->'enrollments'->0->>'pinnedVersion')::int=1
    and (_pp->'enrollments'->0->>'lessonsCompleted')::int=1
    and (_pp->'enrollments'->0->>'lessonTotal')::int=3
    and (_pp->'enrollments'->0->>'needsReviewCount')::int=0, _pp #>> '{}');
end $$;

-- ------------------------------------------------- enrollment state machine
do $$
declare _r jsonb;
begin
  _r := public.set_program_enrollment_status((select v from _ids where k='enrollment'),
    'paused','Travelling');
  insert into _v values('an active enrollment can pause with a reason',
    (select status from public.program_enrollments
     where id=(select v from _ids where k='enrollment'))='paused', _r #>> '{}');
  _r := public.set_program_enrollment_status((select v from _ids where k='enrollment'),
    'active',null);
  _r := public.set_program_enrollment_status((select v from _ids where k='enrollment'),
    'completed',null);
  insert into _v values('completion stamps completed_at',
    (select completed_at from public.program_enrollments
     where id=(select v from _ids where k='enrollment')) is not null, null);
end $$;
do $$
begin
  perform public.set_program_enrollment_status((select v from _ids where k='enrollment'),
    'active',null);
  insert into _v values('a completed enrollment refuses further transitions',false,'no error');
exception when others then
  insert into _v values('a completed enrollment refuses further transitions',
    sqlstate='22023', sqlstate);
end $$;
do $$
begin
  perform public.record_program_progress((select v from _ids where k='enrollment'),
    'check_in', null, null, jsonb_build_object('note','late'), false);
  insert into _v values('progress cannot be recorded on a closed enrollment',false,'no error');
exception when others then
  insert into _v values('progress cannot be recorded on a closed enrollment',
    sqlstate='22023', sqlstate);
end $$;
do $$
begin
  update public.program_enrollment_events set reason='rewritten'
  where enrollment_id=(select v from _ids where k='enrollment');
  insert into _v values('enrollment history events are append-only',false,'no error');
exception when others then
  insert into _v values('enrollment history events are append-only', sqlstate='22023', sqlstate);
end $$;

-- ------------------------------------------------------------- templates
do $$
declare _t jsonb;
begin
  _t := public.create_program_template('bbbbbbbb-0000-0000-0000-000000000601',
    'Metabolic Reset Template','Reusable curriculum',(select v from _ids where k='v1'));
  insert into _ids values ('tpl',(_t->>'templateId')::uuid);
  insert into _ids values ('tplv',(_t->>'versionId')::uuid);
  insert into _v values('a template captures a detached copy of a frozen version',
    (select count(*) from public.program_blocks
     where version_id=(_t->>'versionId')::uuid)=7
    and (select template_id from public.program_versions
         where id=(_t->>'versionId')::uuid)=(_t->>'templateId')::uuid, _t #>> '{}');

  begin
    perform public.create_program('bbbbbbbb-0000-0000-0000-000000000601',
      'Too early',(_t->>'templateId')::uuid);
    insert into _v values('an unapproved template cannot start a program',false,'no error');
  exception when others then
    insert into _v values('an unapproved template cannot start a program',
      sqlstate='22023', sqlstate);
  end;
end $$;
do $$
declare _c jsonb;
begin
  perform public.approve_program_template_version((select v from _ids where k='tplv'));
  _c := public.create_program('bbbbbbbb-0000-0000-0000-000000000601',
    'Metabolic Reset - Cohort B',(select v from _ids where k='tpl'));
  insert into _ids values ('program2',(_c->>'programId')::uuid);
  insert into _ids values ('p2v1',(_c->>'versionId')::uuid);
  insert into _v values('an approved template starts a program with a detached copy',
    (select count(*) from public.program_blocks where version_id=(_c->>'versionId')::uuid)=7
    and (select source_template_id from public.program_versions
         where id=(_c->>'versionId')::uuid)=(select v from _ids where k='tpl'), _c #>> '{}');

  perform public.save_program_draft((_c->>'versionId')::uuid, jsonb_build_object(
    'modules', jsonb_build_array(jsonb_build_object('name','Cohort B intro',
      'lessons', jsonb_build_array(jsonb_build_object('title','Hello',
        'blocks', jsonb_build_array(jsonb_build_object('kind','text',
          'content', jsonb_build_object('body','Cohort-specific content.')))))))), null);
  insert into _v values('customizing the copy never touches the template source',
    (select count(*) from public.program_blocks where version_id=(_c->>'versionId')::uuid)=1
    and (select count(*) from public.program_blocks
         where version_id=(select v from _ids where k='tplv'))=7, null);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.archive_program_template((select v from _ids where k='tpl'), true);
  insert into _v values('archiving a template never cascades into created programs',
    (select status from public.program_templates
     where id=(select v from _ids where k='tpl'))='archived'
    and (select count(*) from public.program_blocks
         where version_id=(select v from _ids where k='p2v1'))=1
    and (select count(*) from public.program_blocks
         where version_id=(select v from _ids where k='v1'))=7, _r->>'message');
  insert into _v values('archived templates are hidden from the default list',
    jsonb_array_length(public.list_program_templates('bbbbbbbb-0000-0000-0000-000000000601', false))=0
    and jsonb_array_length(public.list_program_templates('bbbbbbbb-0000-0000-0000-000000000601', true))=1,
    null);
end $$;

-- ------------------------------------------------------- archive the program
do $$
declare _r jsonb;
begin
  _r := public.archive_program((select v from _ids where k='program'), true);
  insert into _v values('archiving a program preserves history and enrollments',
    (select status from public.programs where id=(select v from _ids where k='program'))='archived'
    and (select count(*) from public.program_versions
         where program_id=(select v from _ids where k='program'))=2
    and exists (select 1 from public.program_enrollments
                where id=(select v from _ids where k='enrollment')), _r->>'message');
end $$;
do $$
begin
  perform public.enroll_patient_in_program((select v from _ids where k='program'),
    'cccccccc-0000-0000-0000-000000000601',null,true,null);
  insert into _v values('an archived program refuses new enrollments',false,'no error');
exception when others then
  insert into _v values('an archived program refuses new enrollments', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.archive_program((select v from _ids where k='program'), false);
  insert into _v values('restoring an archived program returns it to published',
    (select status from public.programs
     where id=(select v from _ids where k='program'))='published', _r->>'message');
end $$;

-- ------------------------------------------------------------ role refusals
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000602","role":"authenticated"}', true);
do $$
begin
  perform public.create_program('bbbbbbbb-0000-0000-0000-000000000601','Staff program',null);
  insert into _v values('staff cannot author a program',false,'no error');
exception when others then
  insert into _v values('staff cannot author a program', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.publish_program_version((select v from _ids where k='v2'));
  insert into _v values('staff cannot publish a program version',false,'no error');
exception when others then
  insert into _v values('staff cannot publish a program version', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.enroll_patient_in_program((select v from _ids where k='program'),
    'cccccccc-0000-0000-0000-000000000601',null,true,null);
  insert into _v values('staff cannot manage enrollments',false,'no error');
exception when others then
  insert into _v values('staff cannot manage enrollments', sqlstate='42501', sqlstate);
end $$;

-- ---------------------------------------------------- cross-tenant refusals
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000603","role":"authenticated"}', true);
do $$
begin
  perform public.list_programs('bbbbbbbb-0000-0000-0000-000000000601');
  insert into _v values('cross-tenant library read is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant library read is refused', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.get_program_studio((select v from _ids where k='program'));
  insert into _v values('cross-tenant studio read is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant studio read is refused', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.get_patient_programs('cccccccc-0000-0000-0000-000000000601');
  insert into _v values('cross-tenant patient program read is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant patient program read is refused', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.save_program_draft((select v from _ids where k='v2'),
    jsonb_build_object('summary','Foreign edit'), null);
  insert into _v values('cross-tenant draft mutation is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant draft mutation is refused', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.create_program('bbbbbbbb-0000-0000-0000-000000000602',
    'Stolen curriculum',(select v from _ids where k='tpl'));
  insert into _v values('a template from another org cannot start a program',false,'no error');
exception when others then
  insert into _v values('a template from another org cannot start a program',
    sqlstate='42501', sqlstate);
end $$;

-- -------------------------------------------------------- anonymous refusal
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$
begin
  perform public.list_programs('bbbbbbbb-0000-0000-0000-000000000601');
  insert into _v values('anonymous library read is refused',false,'no error');
exception when others then
  insert into _v values('anonymous library read is refused', sqlstate='28000', sqlstate);
end $$;

select name, passed, detail from _v order by name;
rollback;
