-- Desktop-owned encounter/note boundary acceptance tests.
-- Rolled back: the project is unchanged after the final statement.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v uuid) on commit drop;
grant all on _v, _ids to authenticated;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000291','desktop-emr-pract@verify.local'),
  ('11111111-0000-0000-0000-000000000292','desktop-emr-out@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000291','Desktop EMR Org','desktop-emr-0029'),
  ('bbbbbbbb-0000-0000-0000-000000000292','Desktop EMR Other','desktop-emr-other-0029');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000291','11111111-0000-0000-0000-000000000291','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000292','11111111-0000-0000-0000-000000000292','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000291','bbbbbbbb-0000-0000-0000-000000000291','Desktop','Patient'),
  ('cccccccc-0000-0000-0000-000000000292','bbbbbbbb-0000-0000-0000-000000000292','Other','Patient');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status)
values
  ('bbbbbbbb-0000-0000-0000-000000000291','11111111-0000-0000-0000-000000000291','cccccccc-0000-0000-0000-000000000291','active'),
  ('bbbbbbbb-0000-0000-0000-000000000292','11111111-0000-0000-0000-000000000292','cccccccc-0000-0000-0000-000000000292','active');
insert into public.appointments
  (id,organization_id,patient_id,practitioner_user_id,appointment_type,status,starts_at,ends_at)
values
  ('dddddddd-0000-0000-0000-000000000291','bbbbbbbb-0000-0000-0000-000000000291',
   'cccccccc-0000-0000-0000-000000000291','11111111-0000-0000-0000-000000000291',
   'follow-up','confirmed',now(),now() + interval '45 minutes');

insert into _v
select 'authenticated can execute all Desktop EMR reads',
  bool_and(has_function_privilege('authenticated', p.oid, 'execute')),
  string_agg(p.proname, ', ' order by p.proname)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public'
  and p.proname in (
    'get_desktop_encounter','list_desktop_patient_encounters',
    'get_desktop_note','get_desktop_patient_timeline'
  );

insert into _v
select 'anon cannot execute Desktop EMR reads',
  not bool_or(has_function_privilege('anon', p.oid, 'execute')),
  string_agg(p.proname, ', ' order by p.proname)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public'
  and p.proname in (
    'get_desktop_encounter','list_desktop_patient_encounters',
    'get_desktop_note','get_desktop_patient_timeline'
  );

insert into _v
select 'active appointment uniqueness index exists',
  exists (
    select 1 from pg_indexes
    where schemaname='public'
      and indexname='encounters_one_active_per_appointment_idx'
      and indexdef like '%WHERE ((appointment_id IS NOT NULL)%'
  ),
  coalesce((select indexdef from pg_indexes
    where schemaname='public'
      and indexname='encounters_one_active_per_appointment_idx'),'missing');

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000291","role":"authenticated"}',
  true
);

do $$
declare _e uuid; _again uuid; _r jsonb; _n uuid;
begin
  _e := public.start_encounter(
    'bbbbbbbb-0000-0000-0000-000000000291',
    'cccccccc-0000-0000-0000-000000000291',
    'follow-up',
    'dddddddd-0000-0000-0000-000000000291'
  );
  insert into _ids values ('encounter', _e);
  _again := public.start_encounter(
    'bbbbbbbb-0000-0000-0000-000000000291',
    'cccccccc-0000-0000-0000-000000000291',
    'follow-up',
    'dddddddd-0000-0000-0000-000000000291'
  );
  insert into _v values(
    'start remains idempotent with the uniqueness guard',
    _again = _e
      and (select count(*) from public.encounters
           where appointment_id='dddddddd-0000-0000-0000-000000000291'
             and status='in_progress')=1,
    _e::text
  );

  _r := public.save_note_draft(
    'bbbbbbbb-0000-0000-0000-000000000291',
    _e,
    'soap',
    '{"S":"Fatigue","O":"BP 118/76","A":"Under review","P":"Review labs"}'::jsonb,
    0,
    null,
    'manual',
    '[{"sectionKey":"S","refType":"practitioner_entered","label":"Practitioner-entered history"}]'::jsonb
  );
  _n := (_r->>'note_id')::uuid;
  insert into _ids values ('note', _n);
exception when others then
  insert into _v values('start remains idempotent with the uniqueness guard',false,sqlstate||' '||sqlerrm);
end $$;

do $$
declare _r jsonb; _enc_keys text[]; _note_keys text[];
begin
  _r := public.get_desktop_encounter((select v from _ids where k='encounter'));
  select array_agg(k order by k) into _enc_keys
    from jsonb_object_keys(_r->'encounter') k;
  select array_agg(k order by k) into _note_keys
    from jsonb_object_keys((_r->'notes')->0) k;
  insert into _v values(
    'encounter read returns exact bounded DTO keys',
    _enc_keys = array[
      'appointment_id','created_at','encounter_id','ended_at','organization_id',
      'patient_id','started_at','status','status_reason','visit_type'
    ]::text[]
    and _note_keys = array[
      'author_user_id','created_at','current_version','encounter_id','note_id',
      'note_type','patient_id','status','status_reason','updated_at'
    ]::text[],
    _r::text
  );
end $$;

do $$
declare _r jsonb;
begin
  _r := public.list_desktop_patient_encounters(
    'cccccccc-0000-0000-0000-000000000291',
    100
  );
  insert into _v values(
    'patient encounter list is scoped and bounded',
    jsonb_array_length(_r)=1
      and (_r->0->>'patient_id')='cccccccc-0000-0000-0000-000000000291',
    _r::text
  );
end $$;

do $$
declare _r jsonb;
begin
  _r := public.get_desktop_note((select v from _ids where k='note'));
  insert into _v values(
    'draft detail returns current content and provenance',
    (_r->'note'->>'note_id')=(select v::text from _ids where k='note')
      and (_r->>'content_version')='1'
      and (_r->'content'->>'S')='Fatigue'
      and jsonb_array_length(_r->'provenance')=1
      and (_r->'provenance'->0->>'ref_type')='practitioner_entered'
      and (_r->>'signature') is null,
    _r::text
  );
end $$;

do $$
declare _sig jsonb; _a uuid; _r jsonb;
begin
  perform public.mark_note_ready((select v from _ids where k='note'));
  _sig := public.sign_note((select v from _ids where k='note'),1);
  _a := public.add_note_addendum(
    (select v from _ids where k='note'),
    'Corrected measurement',
    'BP was 128/76.'
  );
  _r := public.get_desktop_note((select v from _ids where k='note'));
  insert into _v values(
    'signed detail preserves original and exposes append-only addendum',
    (_r->'note'->>'status')='amended'
      and (_r->'signature'->>'signature_id')=(_sig->>'signature_id')
      and (_r->'content'->>'O')='BP 118/76'
      and (_r->'addenda'->0->>'addendum_id')=_a::text
      and (_r->'addenda'->0->>'content')='BP was 128/76.',
    _r::text
  );
end $$;

insert into _v
select 'Desktop timeline is bounded and clinical-only',
  count(*) between 1 and 2
    and bool_and(event_type in (
      'encounter.started','encounter.completed','note.draft_created',
      'note.signed','note.addendum','note.entered_in_error','appointment'
    )),
  'rows='||count(*)
from public.get_desktop_patient_timeline(
  'cccccccc-0000-0000-0000-000000000291',
  2
);

do $$
begin
  perform public.list_desktop_patient_encounters(
    'cccccccc-0000-0000-0000-000000000291',
    201
  );
  insert into _v values('encounter list rejects an excessive limit',false,'no error');
exception when others then
  insert into _v values(
    'encounter list rejects an excessive limit',
    sqlstate='22023',
    sqlstate
  );
end $$;

do $$
begin
  perform public.get_desktop_patient_timeline(
    'cccccccc-0000-0000-0000-000000000291',
    501
  );
  insert into _v values('timeline rejects an excessive limit',false,'no error');
exception when others then
  insert into _v values(
    'timeline rejects an excessive limit',
    sqlstate='22023',
    sqlstate
  );
end $$;

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000292","role":"authenticated"}',
  true
);

do $$
begin
  perform public.get_desktop_encounter((select v from _ids where k='encounter'));
  insert into _v values('cross-tenant encounter read is refused',false,'no error');
exception when others then
  insert into _v values(
    'cross-tenant encounter read is refused',
    sqlstate='42501',
    sqlstate
  );
end $$;

do $$
begin
  perform public.get_desktop_note((select v from _ids where k='note'));
  insert into _v values('cross-tenant note read is refused',false,'no error');
exception when others then
  insert into _v values(
    'cross-tenant note read is refused',
    sqlstate='42501',
    sqlstate
  );
end $$;

do $$
begin
  perform public.get_desktop_patient_timeline(
    'cccccccc-0000-0000-0000-000000000291',
    10
  );
  insert into _v values('cross-tenant timeline read is refused',false,'no error');
exception when others then
  insert into _v values(
    'cross-tenant timeline read is refused',
    sqlstate='42501',
    sqlstate
  );
end $$;

select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$
begin
  perform public.get_desktop_encounter((select v from _ids where k='encounter'));
  insert into _v values('anonymous encounter read is refused',false,'no error');
exception when others then
  insert into _v values(
    'anonymous encounter read is refused',
    sqlstate='28000',
    sqlstate
  );
end $$;

select name, passed, detail from _v order by name;
rollback;
