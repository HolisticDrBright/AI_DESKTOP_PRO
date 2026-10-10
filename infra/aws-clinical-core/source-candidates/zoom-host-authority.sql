-- UNRELEASED candidate over canonical112. No seeded identity, approval or PHI
-- activation. Not included in any approved migration assembly or runtime route.
create schema clinical_telehealth;
revoke all on schema clinical_telehealth from public,clinical_core_api;
grant usage on schema clinical_telehealth to clinical_core_api;

create function clinical_telehealth.valid_host_configuration(c jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text;
begin
 if c is null or jsonb_typeof(c)<>'object' or octet_length(c::text)>8192 then return false; end if;
 if (select count(*) from jsonb_object_keys(c))<>12 then return false; end if;
 foreach k in array array['runtimeMode','awsAccountId','region','zoomAccountId','zoomHostId','clientId','sdkAppKey',
  'secretArn','secretVersionId','providerReviewSha256','securityReviewSha256','sdkAuthorizationReviewSha256'] loop
  if jsonb_typeof(c->k) is distinct from 'string' or length(c->>k) not between 2 and 2048
   or (c->>k)~'[[:space:][:cntrl:]]' then return false; end if;
 end loop;
 if c->>'runtimeMode' not in ('qualification','production') or c->>'region'<>'us-east-2'
  or (c->>'runtimeMode'='qualification' and c->>'awsAccountId'<>'588966314750')
  or (c->>'runtimeMode'='production' and c->>'awsAccountId'<>'173535830222') then return false; end if;
 foreach k in array array['zoomAccountId','zoomHostId','clientId'] loop
  if (c->>k)!~'^[A-Za-z0-9_-]{2,128}$' or lower(c->>k)='me' then return false; end if;
 end loop;
 if length(c->>'sdkAppKey')>500 or (c->>'secretVersionId')!~'^[A-Za-z0-9_-]{32,64}$'
  or length(split_part(c->>'secretArn',':secret:',2)) not between 8 and 519
  or (c->>'secretArn')!~('^arn:aws:secretsmanager:us-east-2:'||(c->>'awsAccountId')||':secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$')
  then return false; end if;
 foreach k in array array['providerReviewSha256','securityReviewSha256','sdkAuthorizationReviewSha256'] loop
  if (c->>k)!~'^[a-f0-9]{64}$' or c->>k=repeat('0',64) then return false; end if;
 end loop;
 return true;
end $$;
revoke all on function clinical_telehealth.valid_host_configuration(jsonb) from public,clinical_core_api;

create table clinical_telehealth.zoom_host_releases (
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 practitioner_person_id uuid not null references clinical_core.persons(id),
 revision integer not null check(revision>0),
 configuration jsonb not null check(clinical_telehealth.valid_host_configuration(configuration)),
 configuration_sha256 text not null check(configuration_sha256=encode(public.digest(convert_to(configuration::text,'UTF8'),'sha256'),'hex')),
 reviewed_by_person_id uuid not null references clinical_core.persons(id),
 reviewed_at timestamptz not null, expires_at timestamptz not null check(expires_at>reviewed_at),
 unique(organization_id,practitioner_person_id,revision), unique(id,organization_id,practitioner_person_id)
);
create table clinical_telehealth.zoom_host_revocations (
 release_id uuid primary key references clinical_telehealth.zoom_host_releases(id),
 revoked_by_person_id uuid not null references clinical_core.persons(id),
 reason_code text not null check(reason_code in ('provider_withdrawn','security_hold','host_removed','configuration_replaced')),
 revoked_at timestamptz not null default clock_timestamp()
);
-- Retain historical patient identity without freezing the calendar's current
-- patient field. New processing compares that field to the original binding.
alter table clinical_core.appointments add constraint zoom_host_appointment_org_unique unique(id,organization_id);
create table clinical_telehealth.zoom_visit_host_bindings (
 id uuid primary key default public.gen_random_uuid(), organization_id uuid not null,
 appointment_id uuid not null, patient_record_id uuid not null, practitioner_person_id uuid not null,
 appointment_version integer not null check(appointment_version>0),
 scheduled_start timestamptz not null, scheduled_end timestamptz not null check(scheduled_end>scheduled_start),
 release_id uuid not null, intent_id uuid not null, admitted_by_person_id uuid not null references clinical_core.persons(id),
 admitted_at timestamptz not null default clock_timestamp(),
 unique(organization_id,appointment_id), unique(id,organization_id),
 foreign key(appointment_id,organization_id) references clinical_core.appointments(id,organization_id),
 foreign key(patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id),
 foreign key(release_id,organization_id,practitioner_person_id) references clinical_telehealth.zoom_host_releases(id,organization_id,practitioner_person_id)
);
create table clinical_telehealth.host_authority_events (
 id uuid primary key default public.gen_random_uuid(), organization_id uuid not null references clinical_core.organizations(id),
 release_id uuid not null references clinical_telehealth.zoom_host_releases(id),
 binding_id uuid references clinical_telehealth.zoom_visit_host_bindings(id),
 actor_person_id uuid not null references clinical_core.persons(id),
 action text not null check(action in ('release_registered','release_revoked','binding_admitted','new_processing_read','cleanup_metadata_read')),
 occurred_at timestamptz not null default clock_timestamp()
);
create index host_authority_events_release_time on clinical_telehealth.host_authority_events(release_id,occurred_at);
create index zoom_host_release_head on clinical_telehealth.zoom_host_releases(organization_id,practitioner_person_id,revision desc);
alter table clinical_telehealth.zoom_host_releases enable row level security;
alter table clinical_telehealth.zoom_host_releases force row level security;
alter table clinical_telehealth.zoom_host_revocations enable row level security;
alter table clinical_telehealth.zoom_host_revocations force row level security;
alter table clinical_telehealth.zoom_visit_host_bindings enable row level security;
alter table clinical_telehealth.zoom_visit_host_bindings force row level security;
alter table clinical_telehealth.host_authority_events enable row level security;
alter table clinical_telehealth.host_authority_events force row level security;
revoke all on all tables in schema clinical_telehealth from public,clinical_core_api;

create function clinical_telehealth.active_workforce(org uuid,person uuid,roles text[]) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from clinical_core.persons p join clinical_core.identities i on i.person_id=p.id
  join clinical_core.organization_memberships m on m.person_id=p.id
  where p.id=person and p.status='active' and p.contains_phi and i.identity_pool='workforce'
   and i.status='active' and i.production_bound and m.organization_id=org and m.status='active' and m.role=any(roles))
$$;
revoke all on function clinical_telehealth.active_workforce(uuid,uuid,text[]) from public,clinical_core_api;

create function clinical_telehealth.guard_host_release() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'INSERT' then raise exception 'zoom_host_release_immutable'; end if;
 perform pg_advisory_xact_lock(hashtextextended('zoom-host:'||new.organization_id::text||':'||new.practitioner_person_id::text,0));
 if new.reviewed_at>clock_timestamp() or new.expires_at<=clock_timestamp()
  or not clinical_telehealth.active_workforce(new.organization_id,new.reviewed_by_person_id,array['owner','admin'])
  or not clinical_telehealth.active_workforce(new.organization_id,new.practitioner_person_id,array['owner','admin','practitioner'])
  or new.revision<>coalesce((select max(revision)+1 from clinical_telehealth.zoom_host_releases
   where organization_id=new.organization_id and practitioner_person_id=new.practitioner_person_id),1) then
  raise exception 'zoom_host_review_required'; end if;
 return new;
end $$;
revoke all on function clinical_telehealth.guard_host_release() from public,clinical_core_api;
create trigger zoom_host_release_guard before insert or update or delete on clinical_telehealth.zoom_host_releases
 for each row execute function clinical_telehealth.guard_host_release();

create function clinical_telehealth.guard_host_revocation() returns trigger
language plpgsql security definer set search_path='' as $$
declare r clinical_telehealth.zoom_host_releases;
begin
 if tg_op<>'INSERT' then raise exception 'zoom_host_revocation_immutable'; end if;
 select * into strict r from clinical_telehealth.zoom_host_releases where id=new.release_id;
 perform pg_advisory_xact_lock(hashtextextended('zoom-host:'||r.organization_id::text||':'||r.practitioner_person_id::text,0));
 if new.revoked_at not between r.reviewed_at and clock_timestamp()
  or not clinical_telehealth.active_workforce(r.organization_id,new.revoked_by_person_id,array['owner','admin'])
  then raise exception 'zoom_host_review_required'; end if;
 return new;
end $$;
revoke all on function clinical_telehealth.guard_host_revocation() from public,clinical_core_api;
create trigger zoom_host_revocation_guard before insert or update or delete on clinical_telehealth.zoom_host_revocations
 for each row execute function clinical_telehealth.guard_host_revocation();
create trigger zoom_visit_host_binding_immutable before update or delete on clinical_telehealth.zoom_visit_host_bindings
 for each row execute function clinical_private.block_update_delete();
create trigger zoom_host_authority_event_immutable before update or delete on clinical_telehealth.host_authority_events
 for each row execute function clinical_private.block_update_delete();

create function clinical_telehealth.audit_host_release() returns trigger
language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 if tg_table_name='zoom_host_releases' then
  insert into clinical_telehealth.host_authority_events(organization_id,release_id,actor_person_id,action)
   values(new.organization_id,new.id,new.reviewed_by_person_id,'release_registered');
 else
  select organization_id into strict org from clinical_telehealth.zoom_host_releases where id=new.release_id;
  insert into clinical_telehealth.host_authority_events(organization_id,release_id,actor_person_id,action)
   values(org,new.release_id,new.revoked_by_person_id,'release_revoked');
 end if;
 return new;
end $$;
revoke all on function clinical_telehealth.audit_host_release() from public,clinical_core_api;
create trigger audit_zoom_host_release after insert on clinical_telehealth.zoom_host_releases
 for each row execute function clinical_telehealth.audit_host_release();
create trigger audit_zoom_host_revocation after insert on clinical_telehealth.zoom_host_revocations
 for each row execute function clinical_telehealth.audit_host_release();

create function clinical_telehealth.require_actor() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=clinical_private.actor_person_id(); org uuid:=clinical_private.organization_id();
begin
 if actor is null or org is null or clinical_private.claim('identity_pool') is distinct from 'workforce'
  or clinical_private.claim('environment') is distinct from 'production-clinical'
  or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
  or clinical_private.claim('purpose') is distinct from 'clinical_data'
  or not clinical_telehealth.active_workforce(org,actor,array['owner','admin','practitioner'])
  or not exists(select 1 from clinical_core.identities i where i.person_id=actor and i.identity_pool='workforce'
   and i.identity_subject=clinical_private.claim('identity_subject') and i.status='active' and i.production_bound)
  then raise exception 'zoom_host_actor_refused'; end if;
 return actor;
end $$;
revoke all on function clinical_telehealth.require_actor() from public,clinical_core_api;

create function clinical_telehealth.current_host_release(org uuid,person uuid) returns clinical_telehealth.zoom_host_releases
language plpgsql security definer set search_path='' as $$
declare r clinical_telehealth.zoom_host_releases;
begin
 perform pg_advisory_xact_lock(hashtextextended('zoom-host:'||org::text||':'||person::text,0));
 -- Choose the newest row BEFORE checking revocation/expiry. No older fallback.
 select * into r from clinical_telehealth.zoom_host_releases where organization_id=org
  and practitioner_person_id=person order by revision desc limit 1;
 if r.id is null or r.expires_at<=clock_timestamp() or exists(select 1 from clinical_telehealth.zoom_host_revocations where release_id=r.id)
  or not clinical_telehealth.active_workforce(org,r.reviewed_by_person_id,array['owner','admin'])
  or not clinical_telehealth.active_workforce(org,person,array['owner','admin','practitioner'])
  then raise exception 'zoom_host_current_release_required'; end if;
 return r;
end $$;
revoke all on function clinical_telehealth.current_host_release(uuid,uuid) from public,clinical_core_api;

create function clinical_telehealth.binding_metadata(b clinical_telehealth.zoom_visit_host_bindings,r clinical_telehealth.zoom_host_releases) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('bindingId',b.id,'organizationId',b.organization_id,'appointmentId',b.appointment_id,
  'patientRecordId',b.patient_record_id,'practitionerPersonId',b.practitioner_person_id,'appointmentVersion',b.appointment_version,
  'scheduledStart',b.scheduled_start,'scheduledEnd',b.scheduled_end,'intentId',b.intent_id,'releaseId',r.id,
  'releaseRevision',r.revision,'configurationSha256',r.configuration_sha256,'configuration',r.configuration,'providerActionAuthorized',false)
$$;
revoke all on function clinical_telehealth.binding_metadata(clinical_telehealth.zoom_visit_host_bindings,clinical_telehealth.zoom_host_releases) from public,clinical_core_api;

create function clinical_telehealth.bind_visit_host(appointment uuid,intent uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=clinical_telehealth.require_actor(); org uuid:=clinical_private.organization_id();
 a clinical_core.appointments; r clinical_telehealth.zoom_host_releases; b clinical_telehealth.zoom_visit_host_bindings;
begin
 if appointment is null or intent is null then raise exception 'zoom_host_binding_invalid'; end if;
 select * into a from clinical_core.appointments where id=appointment and organization_id=org for update;
 if a.id is null or a.practitioner_person_id<>actor or a.patient_record_id is null or a.deleted_at is not null
  or a.appointment_type<>'telehealth' or a.status not in ('scheduled','confirmed','arrived','in_encounter')
  or not exists(select 1 from clinical_core.patient_records p where p.id=a.patient_record_id and p.organization_id=org and p.status='active')
  then raise exception 'zoom_host_appointment_refused'; end if;
 r:=clinical_telehealth.current_host_release(org,actor);
 select * into b from clinical_telehealth.zoom_visit_host_bindings where organization_id=org and appointment_id=appointment;
 if b.id is not null then
  if b.intent_id<>intent or b.release_id<>r.id or b.patient_record_id<>a.patient_record_id
   or b.practitioner_person_id<>a.practitioner_person_id or b.appointment_version<>a.version
   or b.scheduled_start<>a.starts_at or b.scheduled_end<>a.ends_at then raise exception 'zoom_host_binding_conflict'; end if;
  return clinical_telehealth.binding_metadata(b,r);
 end if;
 insert into clinical_telehealth.zoom_visit_host_bindings(organization_id,appointment_id,patient_record_id,practitioner_person_id,
  appointment_version,scheduled_start,scheduled_end,release_id,intent_id,admitted_by_person_id)
 values(org,appointment,a.patient_record_id,actor,a.version,a.starts_at,a.ends_at,r.id,intent,actor) returning * into b;
 insert into clinical_telehealth.host_authority_events(organization_id,release_id,binding_id,actor_person_id,action)
  values(org,r.id,b.id,actor,'binding_admitted');
 return clinical_telehealth.binding_metadata(b,r);
end $$;
revoke all on function clinical_telehealth.bind_visit_host(uuid,uuid) from public,clinical_core_api;
grant execute on function clinical_telehealth.bind_visit_host(uuid,uuid) to clinical_core_api;

create function clinical_telehealth.read_visit_host_binding(appointment uuid,purpose text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=clinical_telehealth.require_actor(); org uuid:=clinical_private.organization_id();
 b clinical_telehealth.zoom_visit_host_bindings; r clinical_telehealth.zoom_host_releases; current_release clinical_telehealth.zoom_host_releases;
 a clinical_core.appointments;
begin
 if purpose is null or purpose not in ('new_processing','cleanup_metadata') then raise exception 'zoom_host_binding_invalid'; end if;
 select * into b from clinical_telehealth.zoom_visit_host_bindings where organization_id=org and appointment_id=appointment;
 if b.id is null then raise exception 'zoom_host_binding_refused'; end if;
 select * into strict r from clinical_telehealth.zoom_host_releases where id=b.release_id;
 if purpose='new_processing' then
  select * into a from clinical_core.appointments where id=appointment and organization_id=org for share;
  if actor<>b.practitioner_person_id or a.id is null or a.deleted_at is not null or a.patient_record_id is distinct from b.patient_record_id
   or a.practitioner_person_id<>b.practitioner_person_id or a.version<>b.appointment_version or a.starts_at<>b.scheduled_start
   or a.ends_at<>b.scheduled_end or a.appointment_type<>'telehealth' or a.status not in ('scheduled','confirmed','arrived','in_encounter')
   or not exists(select 1 from clinical_core.patient_records p where p.id=b.patient_record_id and p.organization_id=org and p.status='active')
   then raise exception 'zoom_host_appointment_refused'; end if;
  current_release:=clinical_telehealth.current_host_release(org,b.practitioner_person_id);
  if r.id<>current_release.id then raise exception 'zoom_host_binding_conflict'; end if;
 else
  if actor<>b.practitioner_person_id and not clinical_telehealth.active_workforce(org,actor,array['owner','admin'])
   then raise exception 'zoom_host_actor_refused'; end if;
  -- Retained metadata is NOT permission to fetch a secret, renew consent,
  -- start a meeting, issue SDK authority, end/delete, or certify erasure.
 end if;
 insert into clinical_telehealth.host_authority_events(organization_id,release_id,binding_id,actor_person_id,action)
  values(org,r.id,b.id,actor,case purpose when 'new_processing' then 'new_processing_read' else 'cleanup_metadata_read' end);
 return clinical_telehealth.binding_metadata(b,r)||jsonb_build_object('purpose',purpose,'providerActionAuthorized',false);
end $$;
revoke all on function clinical_telehealth.read_visit_host_binding(uuid,text) from public,clinical_core_api;
grant execute on function clinical_telehealth.read_visit_host_binding(uuid,text) to clinical_core_api;
