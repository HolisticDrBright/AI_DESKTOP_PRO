-- ============================================================
-- Test: 0021 EMR charting slice (encounters, notes, signatures, addenda)
--
-- Rolled-back, against the real project. Proves:
--   - start_encounter: in_progress + participant + audit; idempotent per
--     appointment; appointment/patient/org agreement enforced (42501)
--   - save_note_draft: draft v1 + provenance; autosave appends; stale
--     expected_version → 40001; editing a ready note returns it to draft
--   - sign_note: freezes version + sha; duplicate sign idempotent (ONE
--     signature, ONE audit); stale version → 40001
--   - immutability: editing signed notes refused; the trigger blocks version
--     inserts after signing for ANY role; signature rows append-only
--   - addenda: append-only, reference the signed version, original unchanged;
--     refused on drafts
--   - entered_in_error keeps rows; completed encounters are terminal
--   - role gate: staff cannot start encounters; dual-org member without
--     patient access can neither write notes nor read the timeline
--   - RLS: outsiders see zero rows and cannot insert; practitioners read the
--     full chain
--   - timeline: clinical events only, never security-audit rows
-- Every row must show passed = true.
-- Run inside a transaction and roll back (see docs/live-api.md).
-- ============================================================

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
grant all on _v to authenticated;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000041','pract21@verify.local'),
  ('11111111-0000-0000-0000-000000000042','staff21@verify.local'),
  ('11111111-0000-0000-0000-000000000043','outsider21@verify.local'),
  ('11111111-0000-0000-0000-000000000044','dualorg21@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000021','Verify Org A 21','verify-a-0021'),
  ('bbbbbbbb-0000-0000-0000-000000000022','Verify Org B 21','verify-b-0021');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000021','11111111-0000-0000-0000-000000000041','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000021','11111111-0000-0000-0000-000000000042','staff','active'),
  ('bbbbbbbb-0000-0000-0000-000000000022','11111111-0000-0000-0000-000000000043','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000021','11111111-0000-0000-0000-000000000044','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000022','11111111-0000-0000-0000-000000000044','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000021','bbbbbbbb-0000-0000-0000-000000000021','OrgA','PatientOne'),
  ('cccccccc-0000-0000-0000-000000000022','bbbbbbbb-0000-0000-0000-000000000021','OrgA','PatientTwo'),
  ('cccccccc-0000-0000-0000-000000000023','bbbbbbbb-0000-0000-0000-000000000022','OrgB','PatientThree');
insert into public.practitioner_patient_relationships(organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000021','11111111-0000-0000-0000-000000000041','cccccccc-0000-0000-0000-000000000021','active'),
  ('bbbbbbbb-0000-0000-0000-000000000021','11111111-0000-0000-0000-000000000041','cccccccc-0000-0000-0000-000000000022','active'),
  ('bbbbbbbb-0000-0000-0000-000000000021','11111111-0000-0000-0000-000000000042','cccccccc-0000-0000-0000-000000000021','active'),
  ('bbbbbbbb-0000-0000-0000-000000000022','11111111-0000-0000-0000-000000000043','cccccccc-0000-0000-0000-000000000023','active'),
  ('bbbbbbbb-0000-0000-0000-000000000022','11111111-0000-0000-0000-000000000044','cccccccc-0000-0000-0000-000000000023','active');
insert into public.appointments(id,organization_id,patient_id,practitioner_user_id,appointment_type,status,starts_at,ends_at) values
  ('dddddddd-0000-0000-0000-000000000021','bbbbbbbb-0000-0000-0000-000000000021','cccccccc-0000-0000-0000-000000000021',
   '11111111-0000-0000-0000-000000000041','follow-up','confirmed', now(), now() + interval '45 minutes');

create temp table _ids(k text primary key, v uuid);

-- ===== as the practitioner P =====
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000041","role":"authenticated"}', true);

do $$
declare _e uuid; _e2 uuid;
begin
  _e := public.start_encounter('bbbbbbbb-0000-0000-0000-000000000021','cccccccc-0000-0000-0000-000000000021','follow-up','dddddddd-0000-0000-0000-000000000021');
  insert into _ids values('enc', _e);
  insert into _v select 'start_encounter creates in_progress with participant',
    exists (select 1 from public.encounters where id=_e and status='in_progress' and appointment_id='dddddddd-0000-0000-0000-000000000021')
    and exists (select 1 from public.encounter_participants where encounter_id=_e and participant_role='author'),
    _e::text;
  _e2 := public.start_encounter('bbbbbbbb-0000-0000-0000-000000000021','cccccccc-0000-0000-0000-000000000021','follow-up','dddddddd-0000-0000-0000-000000000021');
  insert into _v values('start is idempotent per appointment', _e2 = _e, _e2::text);
exception when others then
  insert into _v values('start_encounter creates in_progress with participant', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'encounter.started audited exactly once', count(*)=1, 'count='||count(*)
from public.audit_events
where organization_id='bbbbbbbb-0000-0000-0000-000000000021' and action='encounter.started';

do $$
begin
  perform public.start_encounter('bbbbbbbb-0000-0000-0000-000000000021','cccccccc-0000-0000-0000-000000000022','follow-up','dddddddd-0000-0000-0000-000000000021');
  insert into _v values('appointment/patient mismatch refused', false, 'no error');
exception when others then
  insert into _v values('appointment/patient mismatch refused', sqlstate='42501', sqlstate);
end $$;

do $$
declare r jsonb; _n uuid;
begin
  r := public.save_note_draft('bbbbbbbb-0000-0000-0000-000000000021',(select v from _ids where k='enc'),
        'soap','{"S":"tired","O":"","A":"","P":""}'::jsonb,0,null,'autosave',
        '[{"sectionKey":"S","refType":"practitioner_entered","label":"Practitioner-entered history"}]'::jsonb);
  _n := (r->>'note_id')::uuid;
  insert into _ids values('note', _n);
  insert into _v select 'first save creates draft v1 + provenance',
    (r->>'version')='1'
    and exists (select 1 from public.clinical_notes where id=_n and status='draft' and current_version=1)
    and exists (select 1 from public.note_provenance_refs where note_id=_n and ref_type='practitioner_entered'),
    r::text;
  r := public.save_note_draft('bbbbbbbb-0000-0000-0000-000000000021',(select v from _ids where k='enc'),
        'soap','{"S":"tired x2w","O":"BP 118/76","A":"","P":""}'::jsonb,1,_n,'autosave','[]'::jsonb);
  insert into _v values('autosave appends v2', (r->>'version')='2', r::text);
exception when others then
  insert into _v values('first save creates draft v1 + provenance', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.save_note_draft('bbbbbbbb-0000-0000-0000-000000000021',(select v from _ids where k='enc'),
    'soap','{"S":"stale"}'::jsonb,1,(select v from _ids where k='note'),'autosave','[]'::jsonb);
  insert into _v values('stale expected_version → 40001 conflict', false, 'no error');
exception when others then
  insert into _v values('stale expected_version → 40001 conflict', sqlstate='40001', sqlstate);
end $$;

do $$
declare r jsonb;
begin
  perform public.mark_note_ready((select v from _ids where k='note'));
  insert into _v select 'mark ready → ready_for_review',
    exists (select 1 from public.clinical_notes where id=(select v from _ids where k='note') and status='ready_for_review'), '';
  r := public.save_note_draft('bbbbbbbb-0000-0000-0000-000000000021',(select v from _ids where k='enc'),
        'soap','{"S":"tired x2w","O":"BP 118/76","A":"fatigue w/u","P":"labs"}'::jsonb,2,(select v from _ids where k='note'),'manual','[]'::jsonb);
  insert into _v select 'editing ready note returns to draft v3',
    (r->>'version')='3' and exists (select 1 from public.clinical_notes where id=(select v from _ids where k='note') and status='draft'),
    r::text;
exception when others then
  insert into _v values('mark ready → ready_for_review', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.sign_note((select v from _ids where k='note'), 2);
  insert into _v values('sign with stale version → 40001', false, 'no error');
exception when others then
  insert into _v values('sign with stale version → 40001', sqlstate='40001', sqlstate);
end $$;

do $$
declare r jsonb; r2 jsonb;
begin
  r := public.sign_note((select v from _ids where k='note'), 3);
  insert into _v select 'sign freezes v3 with signature row',
    (r->>'already_signed')='false'
    and exists (select 1 from public.note_signatures s join public.clinical_note_versions v
                on v.note_id=s.note_id and v.version=s.note_version
                where s.note_id=(select v from _ids where k='note') and s.note_version=3
                  and s.content_sha256=v.content_sha256)
    and exists (select 1 from public.clinical_notes where id=(select v from _ids where k='note') and status='signed' and is_signed),
    r::text;
  r2 := public.sign_note((select v from _ids where k='note'), 3);
  insert into _v select 'duplicate sign is idempotent (no 2nd signature)',
    (r2->>'already_signed')='true'
    and (select count(*) from public.note_signatures where note_id=(select v from _ids where k='note'))=1,
    r2::text;
exception when others then
  insert into _v values('sign freezes v3 with signature row', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'note.signed audited exactly once', count(*)=1, 'count='||count(*)
from public.audit_events
where action='note.signed' and resource_id=(select v from _ids where k='note')::text;

do $$
begin
  perform public.save_note_draft('bbbbbbbb-0000-0000-0000-000000000021',(select v from _ids where k='enc'),
    'soap','{"S":"tamper"}'::jsonb,3,(select v from _ids where k='note'),'manual','[]'::jsonb);
  insert into _v values('editing a signed note is blocked', false, 'no error');
exception when others then
  insert into _v values('editing a signed note is blocked', sqlstate='22023' and sqlerrm like '%frozen%', sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  insert into public.clinical_note_versions(note_id, version, content, content_sha256, save_kind, created_by)
  values ((select v from _ids where k='note'), 4, '{"S":"tamper"}'::jsonb, 'x', 'manual', '11111111-0000-0000-0000-000000000041');
  insert into _v values('trigger blocks version insert after signing (any role)', false, 'no error');
exception when others then
  insert into _v values('trigger blocks version insert after signing (any role)', sqlstate='22023' and sqlerrm like '%frozen%', sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  update public.note_signatures set attestation='changed' where note_id=(select v from _ids where k='note');
  insert into _v values('signature rows are append-only', false, 'no error');
exception when others then
  insert into _v values('signature rows are append-only', sqlstate='22023', sqlstate);
end $$;

do $$
declare _a uuid;
begin
  _a := public.add_note_addendum((select v from _ids where k='note'), 'Correction: BP transcription', 'BP was 128/76, not 118/76.');
  insert into _v select 'addendum appends and note becomes amended',
    exists (select 1 from public.note_addenda where id=_a and referenced_version=3)
    and exists (select 1 from public.clinical_notes where id=(select v from _ids where k='note') and status='amended'),
    _a::text;
  insert into _v select 'original v3 content unchanged after addendum',
    exists (select 1 from public.clinical_note_versions v join public.note_signatures s
            on s.note_id=v.note_id and s.note_version=v.version
            where v.note_id=(select v from _ids where k='note') and v.version=3
              and v.content_sha256=s.content_sha256
              and v.content->>'P'='labs'), '';
exception when others then
  insert into _v values('addendum appends and note becomes amended', false, sqlstate||' '||sqlerrm);
end $$;

do $$
declare r jsonb; _n2 uuid;
begin
  r := public.save_note_draft('bbbbbbbb-0000-0000-0000-000000000021',(select v from _ids where k='enc'),
        'narrative','{"text":"second note"}'::jsonb,0,null,'manual','[]'::jsonb);
  _n2 := (r->>'note_id')::uuid;
  insert into _ids values('note2', _n2);
  begin
    perform public.add_note_addendum(_n2, 'reason', 'content');
    insert into _v values('addendum on a draft is refused', false, 'no error');
  exception when others then
    insert into _v values('addendum on a draft is refused', sqlstate='22023', sqlstate);
  end;
  perform public.mark_note_error(_n2, 'Wrong patient chart');
  insert into _v select 'entered_in_error keeps the row',
    exists (select 1 from public.clinical_notes where id=_n2 and status='entered_in_error'), '';
exception when others then
  insert into _v values('addendum on a draft is refused', false, sqlstate||' '||sqlerrm);
end $$;

do $$
declare _cnt integer;
begin
  perform public.set_encounter_status((select v from _ids where k='enc'), 'completed', null);
  insert into _v select 'encounter completes with ended_at',
    exists (select 1 from public.encounters where id=(select v from _ids where k='enc') and status='completed' and ended_at is not null), '';
  begin
    perform public.set_encounter_status((select v from _ids where k='enc'), 'completed', null);
    insert into _v values('completed is terminal (no re-complete)', false, 'no error');
  exception when others then
    insert into _v values('completed is terminal (no re-complete)', sqlstate='22023', sqlstate);
  end;
  select count(*) into _cnt from public.get_patient_timeline('cccccccc-0000-0000-0000-000000000021')
   where event_type in ('encounter.started','encounter.completed','note.draft_created','note.signed','note.addendum','appointment');
  insert into _v values('timeline shows the clinical chain', _cnt >= 6, 'clinical events='||_cnt);
  select count(*) into _cnt from public.get_patient_timeline('cccccccc-0000-0000-0000-000000000021')
   where event_type not in ('encounter.started','encounter.completed','note.draft_created','note.signed','note.addendum','note.entered_in_error','appointment');
  insert into _v values('timeline carries no security-audit events', _cnt = 0, 'foreign events='||_cnt);
exception when others then
  insert into _v values('encounter completes with ended_at', false, sqlstate||' '||sqlerrm);
end $$;

-- ===== role + tenant gates =====
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000042","role":"authenticated"}', true);
do $$
begin
  perform public.start_encounter('bbbbbbbb-0000-0000-0000-000000000021','cccccccc-0000-0000-0000-000000000021','follow-up',null);
  insert into _v values('staff role cannot start encounters', false, 'no error');
exception when others then
  insert into _v values('staff role cannot start encounters', sqlstate='42501', sqlstate);
end $$;

select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000044","role":"authenticated"}', true);
do $$
begin
  perform public.save_note_draft('bbbbbbbb-0000-0000-0000-000000000021',(select v from _ids where k='enc'),
    'soap','{"S":"attack"}'::jsonb,0,null,'manual','[]'::jsonb);
  insert into _v values('dual-org member w/o patient access cannot write notes', false, 'no error');
exception when others then
  insert into _v values('dual-org member w/o patient access cannot write notes', sqlstate='42501', sqlstate);
end $$;
do $$
declare _cnt integer;
begin
  select count(*) into _cnt from public.get_patient_timeline('cccccccc-0000-0000-0000-000000000021');
  insert into _v values('dual-org member cannot read the timeline', false, 'rows='||_cnt);
exception when others then
  insert into _v values('dual-org member cannot read the timeline', sqlstate='42501', sqlstate);
end $$;

-- outsider RLS reads: zero rows visible; direct writes refused
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000043","role":"authenticated"}', true);
set local role authenticated;
insert into _v
select 'RLS: outsider sees no encounters/notes/versions/signatures',
  (select count(*) from public.encounters where patient_id='cccccccc-0000-0000-0000-000000000021')=0
  and (select count(*) from public.clinical_notes where patient_id='cccccccc-0000-0000-0000-000000000021')=0
  and (select count(*) from public.clinical_note_versions)=0
  and (select count(*) from public.note_signatures)=0, '';
do $$
begin
  insert into public.encounters(organization_id,patient_id,status)
  values ('bbbbbbbb-0000-0000-0000-000000000022','cccccccc-0000-0000-0000-000000000023','in_progress');
  insert into _v values('RLS: direct encounter insert refused', false, 'no error');
exception when others then
  insert into _v values('RLS: direct encounter insert refused', sqlstate='42501', sqlstate);
end $$;
reset role;

-- practitioner RLS reads see the chain
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000041","role":"authenticated"}', true);
set local role authenticated;
insert into _v
select 'RLS: practitioner reads the full chain',
  (select count(*) from public.encounters where patient_id='cccccccc-0000-0000-0000-000000000021')=1
  and (select count(*) from public.clinical_notes where patient_id='cccccccc-0000-0000-0000-000000000021')=2
  and (select count(*) from public.clinical_note_versions)=4
  and (select count(*) from public.note_signatures)=1
  and (select count(*) from public.note_addenda)=1, '';
reset role;

select name, passed, detail from _v order by name;
rollback;
