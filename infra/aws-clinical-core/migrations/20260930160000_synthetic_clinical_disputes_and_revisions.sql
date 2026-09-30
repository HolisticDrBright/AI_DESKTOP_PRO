-- A contestable record, and a delivered record that can be corrected after delivery.
-- Synthetic-only. No real patient data, and nothing here is enabled for production.
--
-- Two gaps this closes, both of which are about what happens after something is already
-- wrong or already out of date. The review pipeline governs the clinician before a record is
-- made. Nothing governed what happens afterwards.
--
-- FIRST: a patient could not say "this is wrong about me". They could ask for a stored value
-- to be corrected through the privacy path, which is about data accuracy. They could not
-- contest a conclusion — an interpretation, a protocol, the answer the clinic recorded for
-- them. A product whose claim is governed reasoning has to have an answer for being wrong,
-- and the answer cannot be a suggestion box: a dispute has to be visible on the item
-- wherever the item is read.
--
-- The rule that makes it real is that resolution never removes it. A dispute the clinician
-- upholds stays attached to the record and travels with it, which is the same shape as the
-- right to have a statement of disagreement recorded alongside a denied amendment. Only
-- `corrected` means the clinician agreed; `upheld` means the record stands and the
-- disagreement is now part of it. Neither erases the other.
--
-- The patient's own words live in a separate table from the dispute itself, for the same
-- reason a message lives separately from the thread: the words are theirs and an erasure
-- takes them, while the fact that an item was contested and what the clinician answered is
-- the clinic's record and survives.
--
-- SECOND: when a clinician published a corrected program, everyone already holding the old
-- one kept holding it, silently, forever. That is the most dangerous quiet failure in the
-- product: a patient following a protocol the clinician has since changed.
--
-- Delivered content is deliberately NOT mutated. The compiled artifact is immutable and
-- digest-bound, and swapping it under someone mid-protocol would change what they are doing
-- without anyone deciding to. So a revision produces a notice, and re-assignment stays a
-- separate deliberate act.
--
-- A revision also has to be allowed to say which kind it is, because "we improved this" and
-- "stop taking that" are not the same message. A safety withdrawal requires the clinician to
-- say why in their own words and cannot be satisfied by anything but an acknowledgement.

create table clinical_core.clinical_disputes(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 connection_id uuid not null references clinical_core.patient_connections(id),
 -- No foreign key, deliberately: the subject may be an assignment, an observation or a form
 -- response, and one column cannot reference three tables. The function verifies that the
 -- subject exists and belongs to this connection before a row is written, which is the check
 -- a foreign key would have made.
 subject_kind text not null
  check(subject_kind in('program_assignment','lab_observation','intake_response')),
 subject_id uuid not null,
 reason_code text not null check(reason_code in(
  'not_true_of_me','was_true_no_longer','never_discussed','disagree_with_conclusion',
  'wrong_person','missing_context','other')),
 status text not null default 'open' check(status in('open','acknowledged','resolved','withdrawn')),
 resolution text check(resolution in('corrected','upheld','declined')),
 -- A resolution without an answer is a dismissal wearing a decision's clothes.
 clinician_response text check(clinician_response is null
  or char_length(btrim(clinician_response)) between 1 and 2000),
 raised_at timestamptz not null default clock_timestamp(),
 raised_by_person_id uuid not null references clinical_core.persons(id),
 acknowledged_at timestamptz,
 resolved_at timestamptz,
 resolved_by_person_id uuid references clinical_core.persons(id),
 revision bigint not null default 1 check(revision>0),
 unique(id,organization_id),
 unique(connection_id,subject_kind,subject_id),
 check((status='resolved')=(resolved_at is not null)),
 check((resolved_at is null)=(resolved_by_person_id is null)),
 check((status='resolved')=(resolution is not null)),
 check(resolution is null or clinician_response is not null),
 check(status in('open','withdrawn') or acknowledged_at is not null)
);
alter table clinical_core.clinical_disputes enable row level security;
revoke all on clinical_core.clinical_disputes from public,clinical_core_api;
create index clinical_disputes_subject_idx
 on clinical_core.clinical_disputes(subject_kind,subject_id);
create index clinical_disputes_org_status_idx
 on clinical_core.clinical_disputes(organization_id,status,raised_at desc);
create index clinical_disputes_connection_idx
 on clinical_core.clinical_disputes(connection_id,raised_at desc);
create index clinical_disputes_raised_by_idx on clinical_core.clinical_disputes(raised_by_person_id);
create index clinical_disputes_resolved_by_idx on clinical_core.clinical_disputes(resolved_by_person_id);

-- What the patient said, in their own words, separately from the clinic's record of the
-- dispute. They may add to it while the dispute is open; nothing here is ever edited.
create table clinical_core.clinical_dispute_statements(
 id uuid primary key default gen_random_uuid(),
 dispute_id uuid not null references clinical_core.clinical_disputes(id),
 organization_id uuid not null references clinical_core.organizations(id),
 body text not null check(char_length(btrim(body)) between 1 and 2000),
 stated_at timestamptz not null default clock_timestamp(),
 stated_by_person_id uuid not null references clinical_core.persons(id),
 foreign key (dispute_id,organization_id)
  references clinical_core.clinical_disputes(id,organization_id)
);
alter table clinical_core.clinical_dispute_statements enable row level security;
revoke all on clinical_core.clinical_dispute_statements from public,clinical_core_api;
create index clinical_dispute_statements_dispute_idx
 on clinical_core.clinical_dispute_statements(dispute_id,stated_at);
create index clinical_dispute_statements_author_idx
 on clinical_core.clinical_dispute_statements(stated_by_person_id);

/* A dispute's own facts never move; only the clinic's handling of it does. And a resolved
   dispute is never removed, because a disagreement the clinician did not accept is exactly
   the one that has to stay attached to the record. */
create or replace function clinical_private.protect_clinical_dispute() returns trigger
language plpgsql set search_path='' as $$
declare _owner uuid;
begin
 if tg_op='DELETE' then
  _owner:=clinical_private.care_erasure_owner();
  if _owner is not null and exists(select 1 from clinical_core.patient_connections c
   where c.id=old.connection_id and c.consumer_person_id=_owner) then return old; end if;
  raise exception using errcode='55000',message='append_only_record';
 end if;
 if new.id is distinct from old.id
 or new.organization_id is distinct from old.organization_id
 or new.connection_id is distinct from old.connection_id
 or new.subject_kind is distinct from old.subject_kind
 or new.subject_id is distinct from old.subject_id
 or new.reason_code is distinct from old.reason_code
 or new.raised_at is distinct from old.raised_at
 or new.raised_by_person_id is distinct from old.raised_by_person_id
 -- Once answered, the answer stands. An amended answer is a new dispute, not a rewrite.
 or (old.clinician_response is not null
     and new.clinician_response is distinct from old.clinician_response)
 or (old.resolution is not null and new.resolution is distinct from old.resolution) then
  raise exception using errcode='55000',message='clinical_dispute_immutable';
 end if;
 return new;
end $$;
revoke all on function clinical_private.protect_clinical_dispute() from public;
create trigger clinical_disputes_protected before update or delete
 on clinical_core.clinical_disputes for each row
 execute function clinical_private.protect_clinical_dispute();

create or replace function clinical_private.protect_dispute_statement() returns trigger
language plpgsql set search_path='' as $$
declare _owner uuid;
begin
 if tg_op='DELETE' and clinical_private.care_erasure_owner() is not null then
  _owner:=clinical_private.care_erasure_owner();
  if old.stated_by_person_id=_owner then return old; end if;
 end if;
 raise exception using errcode='55000',message='append_only_record';
end $$;
revoke all on function clinical_private.protect_dispute_statement() from public;
create trigger clinical_dispute_statements_append_only before update or delete
 on clinical_core.clinical_dispute_statements for each row
 execute function clinical_private.protect_dispute_statement();

create table clinical_core.content_revision_notices(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 connection_id uuid not null references clinical_core.patient_connections(id),
 assignment_id uuid not null references clinical_core.program_assignments(id),
 from_version_id uuid not null,
 to_version_id uuid not null,
 revision_class text not null
  check(revision_class in('safety_withdrawal','correction','enhancement')),
 -- Counts, not content: what changed in detail is in the new version, which the patient is
 -- given if the clinician re-assigns it. A notice is not a second copy of the program.
 items_added integer not null check(items_added>=0),
 items_removed integer not null check(items_removed>=0),
 items_changed integer not null check(items_changed>=0),
 statement text check(statement is null or char_length(btrim(statement)) between 1 and 2000),
 status text not null default 'pending' check(status in('pending','delivered','acknowledged')),
 created_at timestamptz not null default clock_timestamp(),
 created_by_person_id uuid not null references clinical_core.persons(id),
 delivered_at timestamptz,
 acknowledged_at timestamptz,
 unique(assignment_id,to_version_id),
 check(from_version_id<>to_version_id),
 -- "Stop taking that" is not a silent notice, and it is not satisfied by being displayed.
 check(revision_class<>'safety_withdrawal' or statement is not null),
 check((status='acknowledged')=(acknowledged_at is not null)),
 check(status='pending' or delivered_at is not null),
 foreign key (from_version_id,organization_id)
  references clinical_core.synthetic_desktop_program_versions(id,organization_id),
 foreign key (to_version_id,organization_id)
  references clinical_core.synthetic_desktop_program_versions(id,organization_id)
);
alter table clinical_core.content_revision_notices enable row level security;
revoke all on clinical_core.content_revision_notices from public,clinical_core_api;
create index content_revision_notices_connection_idx
 on clinical_core.content_revision_notices(connection_id,status,created_at desc);
create index content_revision_notices_org_idx
 on clinical_core.content_revision_notices(organization_id,status,created_at desc);
create index content_revision_notices_assignment_idx
 on clinical_core.content_revision_notices(assignment_id);
create index content_revision_notices_from_idx on clinical_core.content_revision_notices(from_version_id);
create index content_revision_notices_to_idx on clinical_core.content_revision_notices(to_version_id);
create index content_revision_notices_author_idx
 on clinical_core.content_revision_notices(created_by_person_id);

create or replace function clinical_private.protect_revision_notice() returns trigger
language plpgsql set search_path='' as $$
declare _owner uuid;
begin
 if tg_op='DELETE' then
  _owner:=clinical_private.care_erasure_owner();
  if _owner is not null and exists(select 1 from clinical_core.patient_connections c
   where c.id=old.connection_id and c.consumer_person_id=_owner) then return old; end if;
  raise exception using errcode='55000',message='append_only_record';
 end if;
 if new.id is distinct from old.id or new.assignment_id is distinct from old.assignment_id
 or new.from_version_id is distinct from old.from_version_id
 or new.to_version_id is distinct from old.to_version_id
 or new.revision_class is distinct from old.revision_class
 or new.items_added is distinct from old.items_added
 or new.items_removed is distinct from old.items_removed
 or new.items_changed is distinct from old.items_changed
 or new.statement is distinct from old.statement
 or new.created_at is distinct from old.created_at then
  raise exception using errcode='55000',message='revision_notice_immutable';
 end if;
 return new;
end $$;
revoke all on function clinical_private.protect_revision_notice() from public;
create trigger content_revision_notices_protected before update or delete
 on clinical_core.content_revision_notices for each row
 execute function clinical_private.protect_revision_notice();

/* Item identity and item content, so a revision can be described without describing it in
   the notice. Digests rather than bodies: what changed belongs in the new version. */
create or replace function clinical_private.program_item_digests(_content jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare _phase jsonb; _item jsonb; _out jsonb:='{}'::jsonb; _phases jsonb;
begin
 -- Two shapes reach this. A published version compiles to {title,phases}; an assignment
 -- stores the phases array alone. Reading only one of them silently reported every item as
 -- added, because the other side came back empty — which the first test caught.
 if _content is null then return _out; end if;
 _phases:=case when clinical_private.jsonb_kind(_content)='array' then _content
  else _content->'phases' end;
 if clinical_private.jsonb_kind(_phases)<>'array' then return _out; end if;
 for _phase in select value from jsonb_array_elements(_phases) loop
  if clinical_private.jsonb_kind(_phase->'items')<>'array' then continue; end if;
  for _item in select value from jsonb_array_elements(_phase->'items') loop
   if clinical_private.jsonb_kind(_item->'id')<>'string' then continue; end if;
   _out:=_out||jsonb_build_object(_item->>'id',
    encode(public.digest(convert_to(_item::text,'UTF8'),'sha256'),'hex'));
  end loop;
 end loop;
 return _out;
end $$;
revoke all on function clinical_private.program_item_digests(jsonb) from public;

-- The program audit row outlives the assignment it describes.
--
-- Found by the closure test here rather than by reading, and it is a defect in the erasure
-- path shipped earlier today: `program_assignment_audit.assignment_id` referenced the
-- assignment with no delete action, so an account closure for anyone who had ever been
-- assigned a program failed outright on the foreign key. Same remedy as the consult audit —
-- release the reference, and narrow the audit's refusal to permit exactly that one update.
alter table clinical_core.program_assignment_audit
 drop constraint program_assignment_audit_assignment_id_fkey,
 add constraint program_assignment_audit_assignment_id_fkey
  foreign key (assignment_id) references clinical_core.program_assignments(id) on delete set null;

create or replace function clinical_private.program_audit_guard() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE'
 and old.assignment_id is not null and new.assignment_id is null
 and new.id=old.id and new.actor_id=old.actor_id
 and new.organization_id=old.organization_id
 and new.action=old.action and new.occurred_at=old.occurred_at then
  return new;
 end if;
 raise exception using errcode='55000',message='append_only_record';
end $$;
revoke all on function clinical_private.program_audit_guard() from public;
drop trigger program_assignment_audit_immutable on clinical_core.program_assignment_audit;
create trigger program_assignment_audit_immutable before update or delete
 on clinical_core.program_assignment_audit for each row
 execute function clinical_private.program_audit_guard();

/* Shared authority assertion for the two workforce functions here. */
create or replace function clinical_private.assert_care_workforce(_org uuid) returns uuid
language plpgsql stable set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _pool text:=clinical_private.claim('identity_pool');
begin
 perform clinical_private.assert_synthetic_context(_org,'clinical_data');
 if _actor is null or _pool<>'workforce'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool
   and i.identity_subject=clinical_private.claim('identity_subject')
   and i.status='active' and p.status='active' and i.synthetic_attested)
 or not clinical_private.has_clinical_role(_org) then
  raise exception using errcode='42501',message='clinical_dispute_forbidden';
 end if;
 return _actor;
end $$;
revoke all on function clinical_private.assert_care_workforce(uuid) from public;

create or replace function clinical_private.assert_care_consumer(_org uuid) returns uuid
language plpgsql stable set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _pool text:=clinical_private.claim('identity_pool');
begin
 perform clinical_private.assert_synthetic_context(_org,'clinical_data');
 if _actor is null or _pool<>'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool
   and i.identity_subject=clinical_private.claim('identity_subject')
   and i.status='active' and p.status='active' and i.synthetic_attested) then
  raise exception using errcode='42501',message='clinical_dispute_forbidden';
 end if;
 return _actor;
end $$;
revoke all on function clinical_private.assert_care_consumer(uuid) from public;

/* Whether a subject exists and belongs to this connection. The check a foreign key cannot
   make, made in the one place a dispute is created. */
create or replace function clinical_private.dispute_subject_exists(
 _connection uuid,_kind text,_subject uuid
) returns boolean language plpgsql stable set search_path='' as $$
declare _patient uuid;
begin
 if _kind='program_assignment' then
  return exists(select 1 from clinical_core.program_assignments a
   where a.id=_subject and a.connection_id=_connection);
 elsif _kind='intake_response' then
  return exists(select 1 from clinical_core.intake_form_responses r
   where r.id=_subject and r.connection_id=_connection);
 end if;
 select c.patient_record_id into _patient from clinical_core.patient_connections c where c.id=_connection;
 -- A rejected observation is not part of the record, so there is nothing to contest.
 return exists(select 1 from clinical_core.lab_observations o
  where o.id=_subject and o.patient_record_id=_patient and o.review_status<>'rejected');
end $$;
revoke all on function clinical_private.dispute_subject_exists(uuid,text,uuid) from public;

/* The patient's side: contest something, add to what they said, or withdraw it. */
create or replace function clinical_core.clinical_dispute_consumer(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text;
 _connection clinical_core.patient_connections%rowtype; _row clinical_core.clinical_disputes%rowtype;
begin
 _actor:=clinical_private.assert_care_consumer(_org);
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('raise','add_statement','withdraw','list') then
  raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;

 if _action='list' then
  if _request-array['action']<>'{}'::jsonb then
   raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
  return jsonb_build_object('action','list','disputes',coalesce((
   select jsonb_agg(jsonb_build_object('disputeId',d.id,'subjectKind',d.subject_kind,
    'subjectId',d.subject_id,'reasonCode',d.reason_code,'status',d.status,
    'resolution',d.resolution,'clinicianResponse',d.clinician_response,
    'raisedAt',d.raised_at,'acknowledgedAt',d.acknowledged_at,'resolvedAt',d.resolved_at,
    'revision',d.revision::text,
    'statements',(select coalesce(jsonb_agg(jsonb_build_object('body',s.body,'statedAt',s.stated_at)
      order by s.stated_at),'[]'::jsonb)
     from clinical_core.clinical_dispute_statements s where s.dispute_id=d.id))
    order by d.raised_at desc)
   from clinical_core.clinical_disputes d
   join clinical_core.patient_connections c on c.id=d.connection_id
   where c.consumer_person_id=_actor and d.organization_id=_org),'[]'::jsonb));
 end if;

 if _action='raise' then
  if _request-array['action','connectionId','subjectKind','subjectId','reasonCode','statement']<>'{}'::jsonb
  or (_request->>'connectionId') is null or (_request->>'subjectId') is null
  or (_request->>'subjectKind') is null
  or (_request->>'subjectKind') not in('program_assignment','lab_observation','intake_response')
  or (_request->>'reasonCode') is null
  or (_request->>'reasonCode') not in('not_true_of_me','was_true_no_longer','never_discussed',
   'disagree_with_conclusion','wrong_person','missing_context','other')
  or (_request->>'statement') is null
  or char_length(btrim(_request->>'statement')) not between 1 and 2000 then
   raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
  begin
   select * into _connection from clinical_core.patient_connections
    where id=(_request->>'connectionId')::uuid and organization_id=_org
     and consumer_person_id=_actor;
  exception when invalid_text_representation then
   raise exception using errcode='22023',message='clinical_dispute_invalid'; end;
  if _connection.id is null then
   raise exception using errcode='P0002',message='clinical_dispute_connection_absent'; end if;
  begin
   if not clinical_private.dispute_subject_exists(_connection.id,_request->>'subjectKind',
    (_request->>'subjectId')::uuid) then
    raise exception using errcode='P0002',message='clinical_dispute_subject_absent'; end if;
  exception when invalid_text_representation then
   raise exception using errcode='22023',message='clinical_dispute_invalid'; end;
  -- One open trail per item. A second complaint about the same thing is a statement added
  -- to the first, not a parallel dispute nobody is reading.
  if exists(select 1 from clinical_core.clinical_disputes
   where connection_id=_connection.id and subject_kind=_request->>'subjectKind'
    and subject_id=(_request->>'subjectId')::uuid) then
   raise exception using errcode='40001',message='clinical_dispute_exists'; end if;
  insert into clinical_core.clinical_disputes(organization_id,connection_id,subject_kind,subject_id,
   reason_code,raised_by_person_id)
  values(_org,_connection.id,_request->>'subjectKind',(_request->>'subjectId')::uuid,
   _request->>'reasonCode',_actor) returning * into _row;
  insert into clinical_core.clinical_dispute_statements(dispute_id,organization_id,body,stated_by_person_id)
   values(_row.id,_org,btrim(_request->>'statement'),_actor);
  return jsonb_build_object('action','raise','disputeId',_row.id,'status',_row.status,
   'revision',_row.revision::text);
 end if;

 if (_request->>'disputeId') is null then
  raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
 begin
  select d.* into _row from clinical_core.clinical_disputes d
   join clinical_core.patient_connections c on c.id=d.connection_id
   where d.id=(_request->>'disputeId')::uuid and d.organization_id=_org
    and c.consumer_person_id=_actor for update of d;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='clinical_dispute_invalid'; end;
 if _row.id is null then raise exception using errcode='P0002',message='clinical_dispute_absent'; end if;

 if _action='add_statement' then
  if _request-array['action','disputeId','statement']<>'{}'::jsonb
  or (_request->>'statement') is null
  or char_length(btrim(_request->>'statement')) not between 1 and 2000 then
   raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
  if _row.status not in('open','acknowledged') then
   raise exception using errcode='40001',message='clinical_dispute_closed'; end if;
  insert into clinical_core.clinical_dispute_statements(dispute_id,organization_id,body,stated_by_person_id)
   values(_row.id,_org,btrim(_request->>'statement'),_actor);
  return jsonb_build_object('action','add_statement','disputeId',_row.id,'status',_row.status);
 end if;

 if _request-array['action','disputeId','expectedRevision']<>'{}'::jsonb
 or (_request->>'expectedRevision') !~ '^[0-9]{1,18}$' then
  raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
 if _row.revision<>(_request->>'expectedRevision')::bigint then
  raise exception using errcode='40001',message='clinical_dispute_revision_stale'; end if;
 -- A resolved dispute cannot be withdrawn. The clinician has answered, and that answer is
 -- part of the record now whether or not the patient still wants to press it.
 if _row.status not in('open','acknowledged') then
  raise exception using errcode='40001',message='clinical_dispute_closed'; end if;
 update clinical_core.clinical_disputes set status='withdrawn',revision=_row.revision+1
  where id=_row.id returning * into _row;
 return jsonb_build_object('action','withdraw','disputeId',_row.id,'status',_row.status,
  'revision',_row.revision::text);
end $$;
revoke all on function clinical_core.clinical_dispute_consumer(jsonb) from public;
grant execute on function clinical_core.clinical_dispute_consumer(jsonb) to clinical_core_api;

/* The clinic's side: see what is contested, acknowledge it, answer it. And the summary any
   screen showing one of these items must be able to ask for, which is what stops a dispute
   from being a note nobody reads. */
create or replace function clinical_core.clinical_dispute_workforce(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text; _status text;
 _row clinical_core.clinical_disputes%rowtype; _subjects uuid[];
begin
 _actor:=clinical_private.assert_care_workforce(_org);
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('list','summary','acknowledge','resolve') then
  raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;

 if _action='list' then
  if _request-array['action','status']<>'{}'::jsonb then
   raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
  _status:=_request->>'status';
  if _status is not null and _status not in('open','acknowledged','resolved','withdrawn') then
   raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
  return jsonb_build_object('action','list','disputes',coalesce((
   select jsonb_agg(jsonb_build_object('disputeId',d.id,'connectionId',d.connection_id,
    'subjectKind',d.subject_kind,'subjectId',d.subject_id,'reasonCode',d.reason_code,
    'status',d.status,'resolution',d.resolution,'clinicianResponse',d.clinician_response,
    'raisedAt',d.raised_at,'acknowledgedAt',d.acknowledged_at,'resolvedAt',d.resolved_at,
    'revision',d.revision::text,
    'statements',(select coalesce(jsonb_agg(jsonb_build_object('body',s.body,'statedAt',s.stated_at)
      order by s.stated_at),'[]'::jsonb)
     from clinical_core.clinical_dispute_statements s where s.dispute_id=d.id))
    order by d.raised_at desc)
   from clinical_core.clinical_disputes d where d.organization_id=_org
    and (_status is null or d.status=_status)),'[]'::jsonb));
 end if;

 if _action='summary' then
  if _request-array['action','subjectKind','subjectIds']<>'{}'::jsonb
  or (_request->>'subjectKind') is null
  or (_request->>'subjectKind') not in('program_assignment','lab_observation','intake_response')
  or clinical_private.jsonb_kind(_request->'subjectIds')<>'array'
  or jsonb_array_length(_request->'subjectIds')>200 then
   raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
  begin _subjects:=array(select (value#>>'{}')::uuid from jsonb_array_elements(_request->'subjectIds'));
  exception when others then raise exception using errcode='22023',message='clinical_dispute_invalid'; end;
  -- Resolved disputes are reported too. An upheld disagreement stays visible on the item:
  -- that is the whole point of recording it rather than closing it.
  return jsonb_build_object('action','summary','subjectKind',_request->>'subjectKind',
   'subjects',coalesce((
   select jsonb_agg(jsonb_build_object('subjectId',d.subject_id,'disputeId',d.id,
    'status',d.status,'resolution',d.resolution,'raisedAt',d.raised_at))
   from clinical_core.clinical_disputes d
   where d.organization_id=_org and d.subject_kind=_request->>'subjectKind'
    and d.subject_id=any(_subjects) and d.status<>'withdrawn'),'[]'::jsonb));
 end if;

 if (_request->>'disputeId') is null then
  raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
 begin
  select * into _row from clinical_core.clinical_disputes
   where id=(_request->>'disputeId')::uuid and organization_id=_org for update;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='clinical_dispute_invalid'; end;
 if _row.id is null then raise exception using errcode='P0002',message='clinical_dispute_absent'; end if;
 if (_request->>'expectedRevision') is null
 or (_request->>'expectedRevision') !~ '^[0-9]{1,18}$' then
  raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
 if _row.revision<>(_request->>'expectedRevision')::bigint then
  raise exception using errcode='40001',message='clinical_dispute_revision_stale'; end if;

 if _action='acknowledge' then
  if _request-array['action','disputeId','expectedRevision']<>'{}'::jsonb then
   raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
  if _row.status<>'open' then
   raise exception using errcode='40001',message='clinical_dispute_state_invalid'; end if;
  update clinical_core.clinical_disputes set status='acknowledged',
   acknowledged_at=clock_timestamp(),revision=_row.revision+1
   where id=_row.id returning * into _row;
  return jsonb_build_object('action','acknowledge','disputeId',_row.id,'status',_row.status,
   'revision',_row.revision::text);
 end if;

 if _request-array['action','disputeId','expectedRevision','resolution','clinicianResponse']<>'{}'::jsonb
 or (_request->>'resolution') is null
 or (_request->>'resolution') not in('corrected','upheld','declined')
 or (_request->>'clinicianResponse') is null
 or char_length(btrim(_request->>'clinicianResponse')) not between 1 and 2000 then
  raise exception using errcode='22023',message='clinical_dispute_invalid'; end if;
 if _row.status not in('open','acknowledged') then
  raise exception using errcode='40001',message='clinical_dispute_state_invalid'; end if;
 update clinical_core.clinical_disputes set status='resolved',resolution=_request->>'resolution',
  clinician_response=btrim(_request->>'clinicianResponse'),resolved_at=clock_timestamp(),
  resolved_by_person_id=_actor,
  acknowledged_at=coalesce(_row.acknowledged_at,clock_timestamp()),revision=_row.revision+1
  where id=_row.id returning * into _row;
 return jsonb_build_object('action','resolve','disputeId',_row.id,'status',_row.status,
  'resolution',_row.resolution,'revision',_row.revision::text);
end $$;
revoke all on function clinical_core.clinical_dispute_workforce(jsonb) from public;
grant execute on function clinical_core.clinical_dispute_workforce(jsonb) to clinical_core_api;

/* Telling everyone who holds an older version that a newer one exists.
   Deliberately not automatic on publish: the clinician states which kind of revision it is,
   and a machine cannot tell "we improved the wording" from "stop taking that". */
create or replace function clinical_core.content_revision_workforce(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text;
 _version clinical_core.synthetic_desktop_program_versions%rowtype;
 _new jsonb; _class text; _statement text; _created integer:=0; _rows jsonb:='[]'::jsonb;
 _assignment record; _old jsonb; _added integer; _removed integer; _changed integer;
begin
 _actor:=clinical_private.assert_care_workforce(_org);
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='revision_notice_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('preview','publish_notices','list') then
  raise exception using errcode='22023',message='revision_notice_invalid'; end if;

 if _action='list' then
  if _request-array['action','status']<>'{}'::jsonb then
   raise exception using errcode='22023',message='revision_notice_invalid'; end if;
  return jsonb_build_object('action','list','notices',coalesce((
   select jsonb_agg(jsonb_build_object('noticeId',n.id,'connectionId',n.connection_id,
    'assignmentId',n.assignment_id,'revisionClass',n.revision_class,
    'itemsAdded',n.items_added,'itemsRemoved',n.items_removed,'itemsChanged',n.items_changed,
    'statement',n.statement,'status',n.status,'createdAt',n.created_at,
    'acknowledgedAt',n.acknowledged_at) order by n.created_at desc)
   from clinical_core.content_revision_notices n where n.organization_id=_org
    and ((_request->>'status') is null or n.status=_request->>'status')),'[]'::jsonb));
 end if;

 if (_request->>'toVersionId') is null then
  raise exception using errcode='22023',message='revision_notice_invalid'; end if;
 begin
  select * into _version from clinical_core.synthetic_desktop_program_versions
   where id=(_request->>'toVersionId')::uuid and organization_id=_org;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='revision_notice_invalid'; end;
 if _version.id is null then raise exception using errcode='P0002',message='revision_version_absent'; end if;
 -- The same rule as delivery: only a published version may be announced. Telling a patient
 -- their protocol changed, on the strength of a draft, is worse than not telling them.
 if _version.status<>'published' then
  raise exception using errcode='42501',message='revision_version_unpublished'; end if;
 _new:=clinical_private.program_consumer_content(_version.content);
 if _new is null then raise exception using errcode='42501',message='revision_version_unpublished'; end if;

 if _action='preview' then
  if _request-array['action','toVersionId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='revision_notice_invalid'; end if;
 else
  if _request-array['action','toVersionId','revisionClass','statement']<>'{}'::jsonb then
   raise exception using errcode='22023',message='revision_notice_invalid'; end if;
  _class:=_request->>'revisionClass';
  _statement:=nullif(btrim(coalesce(_request->>'statement','')),'');
  if _class is null or _class not in('safety_withdrawal','correction','enhancement')
  or (_statement is not null and char_length(_statement) not between 1 and 2000) then
   raise exception using errcode='22023',message='revision_notice_invalid'; end if;
  if _class='safety_withdrawal' and _statement is null then
   raise exception using errcode='22023',message='revision_statement_required'; end if;
 end if;

 for _assignment in
  select a.id,a.connection_id,a.content,a.program_version_id,v.version as from_version
  from clinical_core.program_assignments a
  join clinical_core.synthetic_desktop_program_versions v on v.id=a.program_version_id
  where a.organization_id=_org and v.program_id=_version.program_id
   and v.version<_version.version and a.state<>'withdrawn'
   and not exists(select 1 from clinical_core.content_revision_notices n
    where n.assignment_id=a.id and n.to_version_id=_version.id)
 loop
  _old:=clinical_private.program_item_digests(_assignment.content);
  select count(*) into _added from jsonb_object_keys(clinical_private.program_item_digests(_new)) k
   where not _old ? k;
  select count(*) into _removed from jsonb_object_keys(_old) k
   where not clinical_private.program_item_digests(_new) ? k;
  select count(*) into _changed from jsonb_each_text(_old) o
   where clinical_private.program_item_digests(_new) ? o.key
    and clinical_private.program_item_digests(_new)->>o.key<>o.value;
  if _action='preview' then
   _rows:=_rows||jsonb_build_array(jsonb_build_object('assignmentId',_assignment.id,
    'connectionId',_assignment.connection_id,'fromVersion',_assignment.from_version,
    'itemsAdded',_added,'itemsRemoved',_removed,'itemsChanged',_changed));
  else
   insert into clinical_core.content_revision_notices(organization_id,connection_id,assignment_id,
    from_version_id,to_version_id,revision_class,items_added,items_removed,items_changed,
    statement,created_by_person_id)
   values(_org,_assignment.connection_id,_assignment.id,_assignment.program_version_id,_version.id,
    _class,_added,_removed,_changed,_statement,_actor);
   _created:=_created+1;
  end if;
 end loop;

 if _action='preview' then
  return jsonb_build_object('action','preview','toVersionId',_version.id,
   'affected',jsonb_array_length(_rows),'assignments',_rows);
 end if;
 return jsonb_build_object('action','publish_notices','toVersionId',_version.id,
  'revisionClass',_class,'noticesCreated',_created);
end $$;
revoke all on function clinical_core.content_revision_workforce(jsonb) from public;
grant execute on function clinical_core.content_revision_workforce(jsonb) to clinical_core_api;

/* The patient's side of a revision. Reading it marks it delivered; saying so marks it
   acknowledged. A safety withdrawal is not satisfied by being read. */
create or replace function clinical_core.content_revision_consumer(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text;
 _row clinical_core.content_revision_notices%rowtype; _items jsonb;
begin
 _actor:=clinical_private.assert_care_consumer(_org);
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='revision_notice_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('list','acknowledge') then
  raise exception using errcode='22023',message='revision_notice_invalid'; end if;

 if _action='list' then
  if _request-array['action']<>'{}'::jsonb then
   raise exception using errcode='22023',message='revision_notice_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('noticeId',n.id,'assignmentId',n.assignment_id,
    'title',a.title,'revisionClass',n.revision_class,'itemsAdded',n.items_added,
    'itemsRemoved',n.items_removed,'itemsChanged',n.items_changed,'statement',n.statement,
    'status',n.status,'createdAt',n.created_at,
    'requiresAcknowledgement',n.revision_class='safety_withdrawal') order by n.created_at desc),'[]'::jsonb)
   into _items
  from clinical_core.content_revision_notices n
  join clinical_core.program_assignments a on a.id=n.assignment_id
  join clinical_core.patient_connections c on c.id=n.connection_id
  where c.consumer_person_id=_actor and n.organization_id=_org and n.status<>'acknowledged';
  -- Reading is delivery. It is recorded so the clinic can tell "they have not seen it" from
  -- "they have seen it and not replied", which are different clinical situations.
  update clinical_core.content_revision_notices n set status='delivered',
   delivered_at=coalesce(n.delivered_at,clock_timestamp())
  where n.status='pending' and n.organization_id=_org
   and exists(select 1 from clinical_core.patient_connections c
    where c.id=n.connection_id and c.consumer_person_id=_actor);
  return jsonb_build_object('action','list','notices',_items);
 end if;

 if _request-array['action','noticeId']<>'{}'::jsonb or (_request->>'noticeId') is null then
  raise exception using errcode='22023',message='revision_notice_invalid'; end if;
 begin
  select n.* into _row from clinical_core.content_revision_notices n
   join clinical_core.patient_connections c on c.id=n.connection_id
   where n.id=(_request->>'noticeId')::uuid and n.organization_id=_org
    and c.consumer_person_id=_actor for update of n;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='revision_notice_invalid'; end;
 if _row.id is null then raise exception using errcode='P0002',message='revision_notice_absent'; end if;
 if _row.status='acknowledged' then
  return jsonb_build_object('action','acknowledge','noticeId',_row.id,'status','acknowledged'); end if;
 update clinical_core.content_revision_notices set status='acknowledged',
  acknowledged_at=clock_timestamp(),delivered_at=coalesce(delivered_at,clock_timestamp())
  where id=_row.id returning * into _row;
 return jsonb_build_object('action','acknowledge','noticeId',_row.id,'status',_row.status);
end $$;
revoke all on function clinical_core.content_revision_consumer(jsonb) from public;
grant execute on function clinical_core.content_revision_consumer(jsonb) to clinical_core_api;

-- Lifecycle, in the same migration as the domain rather than a morning later. The patient's
-- own words go on either scope; the fact that an item was contested and what the clinician
-- answered is the clinic's record and survives a domain erase, as a message thread does.
alter table clinical_core.care_data_erasures
 add column dispute_statements_erased integer not null default 0 check(dispute_statements_erased>=0),
 add column disputes_retained integer not null default 0 check(disputes_retained>=0),
 add column disputes_erased integer not null default 0 check(disputes_erased>=0),
 add column revision_notices_erased integer not null default 0 check(revision_notices_erased>=0);
-- A dispute is the clinic's record of a decision, so only closure removes it. A revision
-- notice is not: it hangs off the assignment it is about, and an assignment goes on either
-- scope, so the notice goes with it. A notice with no delivered program to be about would be
-- a dangling row that nothing could read.
alter table clinical_core.care_data_erasures
 add constraint care_data_erasures_dispute_scope
  check(scope='account_closure' or disputes_erased=0);

-- The owner's copy and erasure, extended to the two domains above.
--
-- Design debt, stated rather than left to be discovered: each new domain now replaces these
-- functions wholesale, and this is the third migration to carry a near-identical copy of the
-- export. The next domain added should refactor them into one function per section with a
-- registry, rather than a fourth copy.
create or replace function clinical_core.care_data_export(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _section text:=_request->>'section';
 _limit integer; _after text; _items jsonb; _next text;
begin
 perform clinical_private.assert_synthetic_context(_org,'consent_management');
 if _actor is null or _pool<>'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=clinical_private.claim('identity_subject')
  and i.status='active' and p.status='active' and i.synthetic_attested) then
  raise exception using errcode='42501',message='care_data_forbidden'; end if;
 if _request is null or clinical_private.jsonb_kind(_request)<>'object'
 or _request-array['action','section','limit','after']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'export'
 or _section is null or _section not in('threads','messages','settlements','assignments','completions',
  'authorizations','intake_packets','intake_responses','signatures','consult_requests',
  'disputes','revision_notices') then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 _limit:=coalesce((_request->>'limit')::integer,100);
 if _limit<1 or _limit>100 then raise exception using errcode='22023',message='care_data_invalid'; end if;
 _after:=nullif(_request->>'after','');

 if _section='threads' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',lpad(t.sequence::text,19,'0'),'threadId',t.id,'subject',t.subject,
    'createdAt',t.created_at,'updatedAt',t.updated_at) as row
   from clinical_core.care_message_threads t
   where exists(select 1 from clinical_core.care_messages m where m.thread_id=t.id and m.sender_id=_actor)
   and (_after is null or lpad(t.sequence::text,19,'0')>_after)
   order by t.sequence limit _limit+1) page;
 elsif _section='messages' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',lpad(m.sequence::text,19,'0'),'messageId',m.id,'threadId',m.thread_id,
    'requestId',m.request_id,'body',m.body,'createdAt',m.created_at) as row
   from clinical_core.care_messages m
   where m.sender_id=_actor and m.sender_pool='consumer'
   and (_after is null or lpad(m.sequence::text,19,'0')>_after)
   order by m.sequence limit _limit+1) page;
 elsif _section='settlements' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',s.request_id::text,'requestId',s.request_id,'settledAt',s.settled_at) as row
   from clinical_core.care_message_settlements s
   where s.sender_id=_actor and (_after is null or s.request_id::text>_after)
   order by s.request_id limit _limit+1) page;
 elsif _section='assignments' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',a.id::text,'enrollmentId',a.id,'title',a.title,'state',a.state,
    'programVersionId',a.program_version_id,'sourceDigest',a.source_digest,'phaseIndex',a.phase_index,
    'finished',a.finished,'assignedAt',a.created_at,'phases',a.content) as row
   from clinical_core.program_assignments a
   where a.consumer_person_id=_actor and (_after is null or a.id::text>_after)
   order by a.id limit _limit+1) page;
 elsif _section='completions' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',c.assignment_id::text||':'||c.item_id,'enrollmentId',c.assignment_id,
    'itemId',c.item_id,'completedAt',c.completed_at) as row
   from clinical_core.program_assignment_completions c
   join clinical_core.program_assignments a on a.id=c.assignment_id
   where a.consumer_person_id=_actor
   and (_after is null or c.assignment_id::text||':'||c.item_id>_after)
   order by c.assignment_id,c.item_id limit _limit+1) page;
 elsif _section='authorizations' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',z.assignment_id::text||':'||z.phase_id||':'||z.kind,
    'enrollmentId',z.assignment_id,'phaseId',z.phase_id,'kind',z.kind,'authorizedAt',z.recorded_at) as row
   from clinical_core.program_phase_authorizations z
   join clinical_core.program_assignments a on a.id=z.assignment_id
   where a.consumer_person_id=_actor
   and (_after is null or z.assignment_id::text||':'||z.phase_id||':'||z.kind>_after)
   order by z.assignment_id,z.phase_id,z.kind limit _limit+1) page;
 elsif _section='intake_packets' then
  -- What was asked of them, whatever happened to the link since.
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',p.id::text,'packetId',p.id,'label',p.label,'status',p.status,
    'dueBefore',p.due_before,'assignedAt',p.created_at,'completedAt',p.completed_at,
    'forms',(select coalesce(jsonb_agg(jsonb_build_object('itemId',i.id,'position',i.position,
      'required',i.required,'formKey',v.form_key,'version',v.version,'title',v.title,'kind',v.kind,
      'contentSha256',v.content_sha256) order by i.position),'[]'::jsonb)
     from clinical_core.intake_packet_items i
     join clinical_core.intake_form_versions v on v.id=i.form_version_id
     where i.packet_id=p.id)) as row
   from clinical_core.intake_packets p
   join clinical_core.patient_connections c on c.id=p.connection_id
   where c.consumer_person_id=_actor and (_after is null or p.id::text>_after)
   order by p.id limit _limit+1) page;
 elsif _section='intake_responses' then
  -- Their own answers, in full, with the text they were answering identified by digest.
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',r.id::text,'responseId',r.id,'packetItemId',r.packet_item_id,
    'formKey',v.form_key,'version',v.version,'title',v.title,
    'formContentSha256',r.form_content_sha256,'answers',r.answers,'answersSha256',r.answers_sha256,
    'submittedAt',r.submitted_at) as row
   from clinical_core.intake_form_responses r
   join clinical_core.intake_form_versions v on v.id=r.form_version_id
   where r.submitted_by_person_id=_actor and (_after is null or r.id::text>_after)
   order by r.id limit _limit+1) page;
 elsif _section='signatures' then
  -- A copy of a signed document is the thing a person most needs to be able to keep, so
  -- the export carries the words themselves and not only a digest of them.
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',s.id::text,'signatureId',s.id,'packetItemId',s.packet_item_id,
    'formKey',v.form_key,'version',v.version,'title',v.title,
    'document',v.content,'formContentSha256',s.form_content_sha256,
    'agreementStatement',v.content->'agreement'->>'statement','agreementSha256',s.agreement_sha256,
    'signerName',s.signer_name,'signerAuthority',s.signer_authority,'signedAt',s.signed_at) as row
   from clinical_core.document_signatures s
   join clinical_core.intake_form_versions v on v.id=s.form_version_id
   where s.signed_by_person_id=_actor and (_after is null or s.id::text>_after)
   order by s.id limit _limit+1) page;
 elsif _section='disputes' then
  -- What they contested, what they said about it, and what the clinician answered. A dispute
  -- the clinician did not accept is in here too: the disagreement is part of the record.
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',d.id::text,'disputeId',d.id,'subjectKind',d.subject_kind,
    'subjectId',d.subject_id,'reasonCode',d.reason_code,'status',d.status,
    'resolution',d.resolution,'clinicianResponse',d.clinician_response,
    'raisedAt',d.raised_at,'resolvedAt',d.resolved_at,
    'statements',(select coalesce(jsonb_agg(jsonb_build_object('body',s.body,'statedAt',s.stated_at)
      order by s.stated_at),'[]'::jsonb)
     from clinical_core.clinical_dispute_statements s where s.dispute_id=d.id)) as row
   from clinical_core.clinical_disputes d
   join clinical_core.patient_connections c on c.id=d.connection_id
   where c.consumer_person_id=_actor and (_after is null or d.id::text>_after)
   order by d.id limit _limit+1) page;
 elsif _section='revision_notices' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',n.id::text,'noticeId',n.id,'assignmentId',n.assignment_id,
    'revisionClass',n.revision_class,'itemsAdded',n.items_added,'itemsRemoved',n.items_removed,
    'itemsChanged',n.items_changed,'statement',n.statement,'status',n.status,
    'createdAt',n.created_at,'acknowledgedAt',n.acknowledged_at) as row
   from clinical_core.content_revision_notices n
   join clinical_core.patient_connections c on c.id=n.connection_id
   where c.consumer_person_id=_actor and (_after is null or n.id::text>_after)
   order by n.id limit _limit+1) page;
 else
  -- Reached through their own connection, which is the only thing that ties a request made
  -- before they had an account to the account they now have. The sealed contact envelope is
  -- deliberately not here: this database cannot open it, and a ciphertext in an export is
  -- not a copy of anything the owner can read.
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',q.id::text,'requestId',q.id,'reference',q.reference_code,
    'visitType',q.visit_type,'reasonCode',q.reason_code,'status',q.status,
    'preferredWindows',q.preferred_windows,'timeZone',q.time_zone,
    'receivedAt',q.received_at,'decidedAt',q.decided_at,'declineReason',q.decline_reason,
    'convertedAt',q.converted_at) as row
   from clinical_core.consult_requests q
   join clinical_core.patient_connections c on c.id=q.connection_id
   where c.consumer_person_id=_actor and (_after is null or q.id::text>_after)
   order by q.id limit _limit+1) page;
 end if;

 if jsonb_array_length(_items)>_limit then
  _next:=(_items->(_limit-1))->>'cursor';
  _items:=(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(_items) with ordinality
   where ordinality<=_limit);
 else _next:=null; end if;
 return jsonb_build_object('action','export','section',_section,
  'items',(select coalesce(jsonb_agg(value-'cursor'),'[]'::jsonb) from jsonb_array_elements(_items)),
  'next',_next);
end $$;
revoke all on function clinical_core.care_data_export(jsonb) from public;
grant execute on function clinical_core.care_data_export(jsonb) to clinical_core_api;

create or replace function clinical_core.care_data_erase(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _scope text:=_request->>'scope';
 _messages integer:=0; _threads integer:=0; _kept integer:=0; _settlements integer:=0;
 _retained integer:=0; _assignments integer:=0; _responses integer:=0;
 _packets_kept integer:=0; _packets_gone integer:=0; _signatures_kept integer:=0;
 _signatures_gone integer:=0; _consults integer:=0; _statements integer:=0;
 _disputes_kept integer:=0; _disputes_gone integer:=0; _notices_gone integer:=0;
 _row clinical_core.care_data_erasures%rowtype;
begin
 perform clinical_private.assert_synthetic_context(_org,'consent_management');
 if _actor is null or _pool<>'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=clinical_private.claim('identity_subject')
  and i.status='active' and p.status='active' and i.synthetic_attested) then
  raise exception using errcode='42501',message='care_data_forbidden'; end if;
 if _request is null or clinical_private.jsonb_kind(_request)<>'object'
 or _request-array['action','scope']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'erase'
 or _scope is null or _scope not in('domain','account_closure') then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
 perform set_config('clinical_private.care_erasure',_actor::text,true);

 -- Before the assignments: a notice references the assignment it is about.
 delete from clinical_core.content_revision_notices n
  using clinical_core.patient_connections c
  where c.id=n.connection_id and c.consumer_person_id=_actor;
 get diagnostics _notices_gone=row_count;

 delete from clinical_core.program_phase_authorizations z
  using clinical_core.program_assignments a
  where z.assignment_id=a.id and a.consumer_person_id=_actor;
 delete from clinical_core.program_assignment_completions c
  using clinical_core.program_assignments a
  where c.assignment_id=a.id and a.consumer_person_id=_actor;
 delete from clinical_core.program_assignments a where a.consumer_person_id=_actor;
 get diagnostics _assignments=row_count;

 delete from clinical_core.care_messages m where m.sender_id=_actor and m.sender_pool='consumer';
 get diagnostics _messages=row_count;

 with candidates as (
  select t.id from clinical_core.care_message_threads t
  where not exists(select 1 from clinical_core.care_messages m where m.thread_id=t.id)
 ), removed as (
  delete from clinical_core.care_message_threads t using candidates c where t.id=c.id returning t.id
 ) select count(*) into _threads from removed;
 select count(*) into _kept from clinical_core.care_message_threads t
  where exists(select 1 from clinical_core.care_messages m where m.thread_id=t.id);

 -- Their answers are their own words, so they go on either scope.
 delete from clinical_core.intake_form_responses r where r.submitted_by_person_id=_actor;
 get diagnostics _responses=row_count;

 -- What they said in a dispute is theirs. The dispute itself is not: it records that an item
 -- was contested and what the clinician answered, which is the clinic's record of a decision.
 delete from clinical_core.clinical_dispute_statements s where s.stated_by_person_id=_actor;
 get diagnostics _statements=row_count;

 if _scope='account_closure' then
  delete from clinical_core.care_message_settlements s where s.sender_id=_actor;
  get diagnostics _settlements=row_count;
  _retained:=0;

  delete from clinical_core.document_signatures s where s.signed_by_person_id=_actor;
  get diagnostics _signatures_gone=row_count;
  _signatures_kept:=0;

  -- Items before packets, and both only once nothing points at them any more.
  delete from clinical_core.intake_packet_items i
   using clinical_core.intake_packets p, clinical_core.patient_connections c
   where i.packet_id=p.id and c.id=p.connection_id and c.consumer_person_id=_actor;
  delete from clinical_core.intake_packets p
   using clinical_core.patient_connections c
   where c.id=p.connection_id and c.consumer_person_id=_actor;
  get diagnostics _packets_gone=row_count;
  _packets_kept:=0;

  delete from clinical_core.consult_requests q
   using clinical_core.patient_connections c
   where c.id=q.connection_id and c.consumer_person_id=_actor;
  get diagnostics _consults=row_count;

  delete from clinical_core.clinical_disputes d
   using clinical_core.patient_connections c
   where c.id=d.connection_id and c.consumer_person_id=_actor;
  get diagnostics _disputes_gone=row_count;
  _disputes_kept:=0;
 else
  select count(*) into _retained from clinical_core.care_message_settlements s where s.sender_id=_actor;
  select count(*) into _signatures_kept from clinical_core.document_signatures s
   where s.signed_by_person_id=_actor;
  -- The packet is the clinic's record that it asked, so a domain erase keeps it, exactly as
  -- it keeps a thread the clinic has written in.
  select count(*) into _packets_kept from clinical_core.intake_packets p
   join clinical_core.patient_connections c on c.id=p.connection_id
   where c.consumer_person_id=_actor;
  select count(*) into _disputes_kept from clinical_core.clinical_disputes d
   join clinical_core.patient_connections c on c.id=d.connection_id
   where c.consumer_person_id=_actor;
 end if;

 insert into clinical_core.care_data_erasures(owner_id,scope,messages_erased,threads_erased,threads_retained,
  settlements_erased,settlements_retained,assignments_erased,late_admission_refusable,
  responses_erased,packets_retained,packets_erased,signatures_retained,signatures_erased,
  consult_requests_erased,dispute_statements_erased,disputes_retained,disputes_erased,
  revision_notices_erased)
 values(_actor,_scope,_messages,_threads,_kept,_settlements,_retained,_assignments,_scope='domain',
  _responses,_packets_kept,_packets_gone,_signatures_kept,_signatures_gone,_consults,
  _statements,_disputes_kept,_disputes_gone,_notices_gone)
 returning * into _row;

 perform set_config('clinical_private.care_erasure','',true);

 return jsonb_build_object('action','erase','scope',_scope,'erasureId',_row.id,
  'messagesErased',_messages,'threadsErased',_threads,'threadsRetained',_kept,
  'assignmentsErased',_assignments,
  'settlementsErased',_settlements,'settlementsRetained',_retained,
  'responsesErased',_responses,
  'packetsRetained',_packets_kept,'packetsErased',_packets_gone,
  'signaturesRetained',_signatures_kept,'signaturesErased',_signatures_gone,
  'consultRequestsErased',_consults,
  'disputeStatementsErased',_statements,
  'disputesRetained',_disputes_kept,'disputesErased',_disputes_gone,
  'revisionNoticesErased',_notices_gone,
  'lateAdmissionRefusable',_scope='domain',
  'retainedReason',case when _scope='domain' and _retained>0
   then 'cancellation_refusal_must_outlive_late_admission' else null end,
  'threadsRetainedReason',case when _kept>0 then 'thread_holds_another_participant_record' else null end,
  'packetsRetainedReason',case when _packets_kept>0
   then 'packet_is_the_clinic_record_of_what_was_asked' else null end,
  'signaturesRetainedReason',case when _signatures_kept>0
   then 'signature_is_the_recorded_basis_for_care_already_given' else null end,
  'disputesRetainedReason',case when _disputes_kept>0
   then 'dispute_records_a_decision_and_the_disagreement_with_it' else null end);
end $$;
revoke all on function clinical_core.care_data_erase(jsonb) from public;
grant execute on function clinical_core.care_data_erase(jsonb) to clinical_core_api;

create or replace function clinical_core.care_data_erasure_history(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _pool text:=clinical_private.claim('identity_pool');
 _org uuid:=clinical_private.organization_id(); _items jsonb;
begin
 perform clinical_private.assert_synthetic_context(_org,'consent_management');
 if _actor is null or _pool<>'consumer' then
  raise exception using errcode='42501',message='care_data_forbidden'; end if;
 if _request is null or clinical_private.jsonb_kind(_request)<>'object'
 or _request-array['action']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'erasure_history' then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('erasureId',e.id,'scope',e.scope,
   'messagesErased',e.messages_erased,'threadsErased',e.threads_erased,'threadsRetained',e.threads_retained,
   'settlementsErased',e.settlements_erased,'settlementsRetained',e.settlements_retained,
   'assignmentsErased',e.assignments_erased,'responsesErased',e.responses_erased,
   'packetsRetained',e.packets_retained,'packetsErased',e.packets_erased,
   'signaturesRetained',e.signatures_retained,'signaturesErased',e.signatures_erased,
   'consultRequestsErased',e.consult_requests_erased,
   'disputeStatementsErased',e.dispute_statements_erased,
   'disputesRetained',e.disputes_retained,'disputesErased',e.disputes_erased,
   'revisionNoticesErased',e.revision_notices_erased,
   'lateAdmissionRefusable',e.late_admission_refusable,
   'occurredAt',e.occurred_at) order by e.occurred_at desc),'[]'::jsonb) into _items
 from (select * from clinical_core.care_data_erasures where owner_id=_actor order by occurred_at desc limit 50) e;
 return jsonb_build_object('action','erasure_history','erasures',_items);
end $$;
revoke all on function clinical_core.care_data_erasure_history(jsonb) from public;
grant execute on function clinical_core.care_data_erasure_history(jsonb) to clinical_core_api;
