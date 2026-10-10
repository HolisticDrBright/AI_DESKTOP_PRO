-- UNRELEASED. Requires canonical106, fullscript-draft-ledger.sql and
-- canonical-protocol-carts.sql. No approval, consent or identity is seeded.
-- Worker-only functions; there is no API route or production activation here.
create table fullscript_delivery.authority_releases (
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 kind text not null check(kind in ('provider','recipient','practitioner','mapping','consent')),
 subject_id uuid not null,
 revision integer not null check(revision>0),
 content jsonb not null check(jsonb_typeof(content)='object' and octet_length(content::text)<=131072),
 content_sha256 text not null check(content_sha256~'^[a-f0-9]{64}$' and content_sha256<>repeat('0',64)),
 approved_by_person_id uuid not null references clinical_core.persons(id),
 approved_at timestamptz not null,
 retired_at timestamptz,
 unique(organization_id,kind,subject_id,revision), unique(id,organization_id),
 check(content_sha256=encode(public.digest(convert_to(content::text,'UTF8'),'sha256'),'hex'))
);
create table fullscript_delivery.external_consents (
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null,
 connection_id uuid not null,
 patient_record_id uuid not null,
 consumer_person_id uuid not null references clinical_core.persons(id),
 release_id uuid not null,
 revision integer not null check(revision>0),
 status text not null check(status in ('granted','withdrawn')),
 recorded_at timestamptz not null default clock_timestamp(),
 foreign key(connection_id,organization_id,patient_record_id) references clinical_core.patient_connections(id,organization_id,patient_record_id),
 foreign key(release_id,organization_id) references fullscript_delivery.authority_releases(id,organization_id),
 unique(connection_id,revision)
);
create table fullscript_delivery.recipient_holds (
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null,
 patient_record_id uuid not null,
 reason text not null check(reason in ('clinical_safety','privacy_request','security_investigation')),
 placed_by_person_id uuid not null references clinical_core.persons(id),
 placed_at timestamptz not null default clock_timestamp(),
 released_at timestamptz,
 released_by_person_id uuid references clinical_core.persons(id),
 check((released_at is null)=(released_by_person_id is null)),
 foreign key(patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id)
);
create index recipient_holds_active on fullscript_delivery.recipient_holds(organization_id,patient_record_id) where released_at is null;
revoke all on fullscript_delivery.authority_releases,fullscript_delivery.external_consents,
 fullscript_delivery.recipient_holds from public,clinical_core_api,fullscript_draft_worker;
alter table fullscript_delivery.authority_releases enable row level security;
alter table fullscript_delivery.authority_releases force row level security;
alter table fullscript_delivery.external_consents enable row level security;
alter table fullscript_delivery.external_consents force row level security;
alter table fullscript_delivery.recipient_holds enable row level security;
alter table fullscript_delivery.recipient_holds force row level security;

create function fullscript_delivery.active_reviewer(_org uuid,_person uuid,_kind text) returns boolean
 language sql stable security definer set search_path='' as $$
 select exists(select 1 from clinical_core.persons p join clinical_core.identities i on i.person_id=p.id
  join clinical_core.organization_memberships m on m.person_id=p.id
  where p.id=_person and p.status='active' and i.identity_pool='workforce' and i.status='active' and i.production_bound
   and m.organization_id=_org and m.status='active' and
   (m.role in ('owner','admin') or (_kind not in ('provider','consent') and m.role='practitioner')))
$$;
revoke all on function fullscript_delivery.active_reviewer(uuid,uuid,text) from public,clinical_core_api,fullscript_draft_worker;
create function fullscript_delivery.guard_authority_release() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
  perform pg_advisory_xact_lock(hashtextextended('fullscript-release:'||new.organization_id::text||':'||new.kind||':'||new.subject_id::text,0));
  if new.approved_at>clock_timestamp() or new.retired_at is not null
   or not fullscript_delivery.active_reviewer(new.organization_id,new.approved_by_person_id,new.kind)
   or new.revision<>coalesce((select max(revision)+1 from fullscript_delivery.authority_releases
      where organization_id=new.organization_id and kind=new.kind and subject_id=new.subject_id),1) then
   raise exception 'fullscript_review_required'; end if;
  return new;
 end if;
 if tg_op='UPDATE' and old.retired_at is null and new.retired_at is not null
  and new.retired_at<=clock_timestamp() and (to_jsonb(new)-'retired_at')=(to_jsonb(old)-'retired_at') then
  perform pg_advisory_xact_lock(hashtextextended('fullscript-release:'||new.organization_id::text||':'||new.kind||':'||new.subject_id::text,0));
  return new;
 end if;
 raise exception 'fullscript_authority_immutable';
end $$;
revoke all on function fullscript_delivery.guard_authority_release() from public;
create trigger guard_authority_release before insert or update or delete on fullscript_delivery.authority_releases
 for each row execute function fullscript_delivery.guard_authority_release();
create trigger external_consents_immutable before update or delete on fullscript_delivery.external_consents
 for each row execute function clinical_private.block_update_delete();

create function fullscript_delivery.guard_recipient_hold() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'fullscript_hold_immutable'; end if;
 -- Use the same connection lock as dispatch and withdrawal; no new hold may
 -- sneak between authority inspection and writer admission in that transaction.
 perform 1 from clinical_core.patient_connections where organization_id=new.organization_id
  and patient_record_id=new.patient_record_id order by id for update;
 if tg_op='INSERT' and new.released_at is null and new.placed_at<=clock_timestamp()
  and fullscript_delivery.active_reviewer(new.organization_id,new.placed_by_person_id,'provider') then return new; end if;
 if tg_op='UPDATE' and old.released_at is null and new.released_at is not null
  and new.released_at between old.placed_at and clock_timestamp()
  and fullscript_delivery.active_reviewer(new.organization_id,new.released_by_person_id,'provider')
  and (to_jsonb(new)-array['released_at','released_by_person_id'])=(to_jsonb(old)-array['released_at','released_by_person_id'])
  then return new; end if;
 raise exception 'fullscript_hold_immutable';
end $$;
revoke all on function fullscript_delivery.guard_recipient_hold() from public,clinical_core_api,fullscript_draft_worker;
create trigger guard_recipient_hold before insert or update or delete on fullscript_delivery.recipient_holds
 for each row execute function fullscript_delivery.guard_recipient_hold();

create table clinical_audit.fullscript_consent_events (
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 consent_id uuid not null references fullscript_delivery.external_consents(id),
 actor_person_id uuid not null references clinical_core.persons(id),
 action text not null check(action in ('granted','withdrawn')),
 occurred_at timestamptz not null default clock_timestamp(), unique(consent_id)
);
revoke all on clinical_audit.fullscript_consent_events from public,clinical_core_api,fullscript_draft_worker;
alter table clinical_audit.fullscript_consent_events enable row level security;
alter table clinical_audit.fullscript_consent_events force row level security;
create trigger fullscript_consent_events_immutable before update or delete on clinical_audit.fullscript_consent_events
 for each row execute function clinical_private.block_update_delete();
create function fullscript_delivery.audit_external_consent() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 insert into clinical_audit.fullscript_consent_events(organization_id,consent_id,actor_person_id,action)
  values(new.organization_id,new.id,new.consumer_person_id,new.status);
 return new;
end $$;
revoke all on function fullscript_delivery.audit_external_consent() from public,clinical_core_api,fullscript_draft_worker;
create trigger audit_external_consent after insert on fullscript_delivery.external_consents
 for each row execute function fullscript_delivery.audit_external_consent();

create function fullscript_delivery.current_release(_org uuid,_kind text,_subject uuid)
 returns fullscript_delivery.authority_releases language plpgsql security definer set search_path='' as $$
declare r fullscript_delivery.authority_releases;
begin
 perform pg_advisory_xact_lock(hashtextextended('fullscript-release:'||_org::text||':'||_kind||':'||_subject::text,0));
 -- Select the latest revision before testing retirement. Never resurrect an older release.
 select * into r from fullscript_delivery.authority_releases where organization_id=_org and kind=_kind
  and subject_id=_subject order by revision desc limit 1 for share;
 if r.id is null or r.retired_at is not null or r.approved_at>clock_timestamp()
  or not fullscript_delivery.active_reviewer(_org,r.approved_by_person_id,_kind) then
  raise exception 'fullscript_current_release_required'; end if;
 return r;
end $$;
revoke all on function fullscript_delivery.current_release(uuid,text,uuid) from public,clinical_core_api,fullscript_draft_worker;

create function fullscript_delivery.set_actor(_actor jsonb) returns uuid
 language plpgsql security definer set search_path='' as $$
declare person uuid:=(_actor->>'personId')::uuid; org uuid:=(_actor->>'organizationId')::uuid;
begin
 if _actor->>'environment' is distinct from 'synthetic-staging' or _actor->'phiAllowed' is distinct from 'false'::jsonb
  or coalesce(_actor->>'identityPool','') not in ('workforce','consumer') then raise exception 'fullscript_actor_refused'; end if;
 perform clinical_private.set_request_context(person,org,_actor->>'identityPool',_actor->>'identitySubject',
  'clinical_data','production-clinical','clinical_phi');
 return clinical_private.care_connection_actor(_actor->>'identityPool','clinical_data');
end $$;
revoke all on function fullscript_delivery.set_actor(jsonb) from public,clinical_core_api,fullscript_draft_worker;

-- Access to a withheld historical receipt is separate from current permission
-- to dispatch. A replacement link does not grant its new owner an old receipt.
create function fullscript_delivery.actor_access(_actor jsonb,_binding jsonb) returns boolean
 language plpgsql security definer set search_path='' as $$
declare person uuid; org uuid:=(_binding->>'organizationId')::uuid;
begin
 if current_setting('role',true) is distinct from 'fullscript_draft_worker' then return false; end if;
 person:=fullscript_delivery.set_actor(_actor);
 if org is distinct from (_actor->>'organizationId')::uuid or not exists(select 1 from clinical_core.patient_records
  where id=(_binding->>'patientRecordId')::uuid and organization_id=org) then return false; end if;
 if _actor->>'identityPool'='workforce' then return true; end if;
 return person=(_binding->>'consumerPersonId')::uuid and exists(select 1 from fullscript_delivery.authority_releases
  where organization_id=org and kind='recipient' and subject_id=(_binding->>'patientRecordId')::uuid
   and content->>'consumerPersonId'=person::text and content->>'connectionId'=_binding->>'connectionId');
exception when others then return false;
end $$;
revoke all on function fullscript_delivery.actor_access(jsonb,jsonb) from public,clinical_core_api;
grant execute on function fullscript_delivery.actor_access(jsonb,jsonb) to fullscript_draft_worker;

-- NULL is an expected denial, not a transaction-aborting SQL error. This is
-- important when settlement must preserve a late receipt but withhold it.
create function fullscript_delivery.authority_source(_actor jsonb,_manifest uuid,_patient uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare org uuid:=(_actor->>'organizationId')::uuid; person uuid; manifest jsonb;
 connection clinical_core.patient_connections; enrollment clinical_core.program_enrollments; consent clinical_core.consent_grants;
 artifact clinical_core.consent_artifacts; scopes jsonb:='[]'::jsonb; _scope text;
 provider fullscript_delivery.authority_releases; recipient fullscript_delivery.authority_releases;
 practitioner fullscript_delivery.authority_releases; mapping fullscript_delivery.authority_releases;
 external_release fullscript_delivery.authority_releases; external_grant fullscript_delivery.external_consents;
begin
 if current_setting('role',true) is distinct from 'fullscript_draft_worker' or _actor->>'identityPool'<>'workforce' then return null; end if;
 person:=fullscript_delivery.set_actor(_actor);
 perform 1 from clinical_core.patient_records where id=_patient and organization_id=org and status='active' and deleted_at is null for share;
 if not found then return null; end if;
 select * into connection from clinical_core.patient_connections where organization_id=org and patient_record_id=_patient
  and state='verified' for update;
 if connection.id is null or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where p.id=connection.consumer_person_id and p.status='active' and i.status='active' and i.identity_pool='consumer' and i.production_bound)
  then return null; end if;
 perform clinical_private.assert_owned_storage_writable(connection.consumer_person_id);
 if exists(select 1 from fullscript_delivery.recipient_holds where organization_id=org and patient_record_id=_patient and released_at is null)
  then return null; end if;
 foreach _scope in array array['programs','protocols_supplements'] loop
  artifact:=clinical_private.care_connection_artifact(_scope);
  if not fullscript_delivery.active_reviewer(org,artifact.approved_by_person_id,'mapping') then return null; end if;
  select g.* into consent from clinical_core.consent_grants g where g.organization_id=org and g.connection_id=connection.id
   and g.scope=_scope order by g.version desc limit 1;
  if consent.id is null or consent.status<>'granted' or consent.artifact_id<>artifact.id
   or consent.recorded_by_person_id<>connection.consumer_person_id or consent.method<>'patient_app'
   or consent.representative_authority<>'self' then return null; end if;
  scopes:=scopes||jsonb_build_object('scope',_scope,'grantId',consent.id,'version',consent.version,'artifactId',artifact.id);
 end loop;
 manifest:=clinical_core.canonical_protocol_cart_workforce(jsonb_build_object('action','read','manifestId',_manifest));
 if manifest->>'status'<>'compiled' or (manifest->>'includedCount')::integer<1 then return null; end if;
 select e.* into enrollment from clinical_core.program_enrollments e where e.organization_id=org and e.patient_record_id=_patient
  and e.program_version_id=(manifest->>'programVersionId')::uuid and e.status='active'
  and (e.access_expires_at is null or e.access_expires_at>clock_timestamp()) order by e.enrolled_at desc,e.id limit 1 for share;
 if enrollment.id is null then return null; end if;
 provider:=fullscript_delivery.current_release(org,'provider',org);
 recipient:=fullscript_delivery.current_release(org,'recipient',_patient);
 practitioner:=fullscript_delivery.current_release(org,'practitioner',person);
 mapping:=fullscript_delivery.current_release(org,'mapping',_manifest);
 external_release:=fullscript_delivery.current_release(org,'consent',provider.id);
 select * into external_grant from fullscript_delivery.external_consents where organization_id=org and connection_id=connection.id
  order by revision desc limit 1;
 if external_grant.id is null or external_grant.status<>'granted' or external_grant.release_id<>external_release.id
  or external_grant.consumer_person_id<>connection.consumer_person_id then return null; end if;
 return jsonb_build_object('organizationId',org,'consumerPersonId',connection.consumer_person_id,'patientRecordId',_patient,
  'connectionId',connection.id,'connectionVersion',connection.version,'practitionerPersonId',person,
  'enrollmentId',enrollment.id,'enrollmentVersion',enrollment.version,'manifest',manifest,'scopeGrants',scopes,
  'catalogSourceSha256',(select catalog_source_sha256 from fullscript_delivery.protocol_manifests where id=_manifest),
  'provider',jsonb_build_object('id',provider.id,'sha256',provider.content_sha256,'content',provider.content),
  'recipient',jsonb_build_object('id',recipient.id,'sha256',recipient.content_sha256,'content',recipient.content),
  'practitioner',jsonb_build_object('id',practitioner.id,'sha256',practitioner.content_sha256,'content',practitioner.content),
  'mapping',jsonb_build_object('id',mapping.id,'sha256',mapping.content_sha256,'content',mapping.content),
  'externalConsent',jsonb_build_object('id',external_release.id,'sha256',external_release.content_sha256,'content',external_release.content),
  'externalGrantId',external_grant.id,'externalGrantRevision',external_grant.revision);
exception when others then return null;
end $$;
revoke all on function fullscript_delivery.authority_source(jsonb,uuid,uuid) from public,clinical_core_api;
grant execute on function fullscript_delivery.authority_source(jsonb,uuid,uuid) to fullscript_draft_worker;

create function fullscript_delivery.current_authority_source(_binding jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare identity text;
begin
 if current_setting('role',true) is distinct from 'fullscript_draft_worker' then return null; end if;
 select identity_subject into identity from clinical_core.identities where person_id=(_binding->>'practitionerPersonId')::uuid
  and identity_pool='workforce' and status='active' and production_bound order by id limit 1;
 if identity is null then return null; end if;
 return fullscript_delivery.authority_source(jsonb_build_object('organizationId',_binding->>'organizationId',
  'personId',_binding->>'practitionerPersonId','identitySubject',identity,'identityPool','workforce',
  'environment','synthetic-staging','phiAllowed',false),(_binding->>'manifestId')::uuid,(_binding->>'patientRecordId')::uuid);
exception when others then return null;
end $$;
revoke all on function fullscript_delivery.current_authority_source(jsonb) from public,clinical_core_api;
grant execute on function fullscript_delivery.current_authority_source(jsonb) to fullscript_draft_worker;

create function fullscript_delivery.external_consent_request(_actor jsonb,_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare org uuid:=(_actor->>'organizationId')::uuid; person uuid; c clinical_core.patient_connections;
 provider fullscript_delivery.authority_releases; release fullscript_delivery.authority_releases; g fullscript_delivery.external_consents;
 action text:=_request->>'action'; expected integer;
begin
 if current_setting('role',true) is distinct from 'fullscript_draft_worker' or _actor->>'identityPool'<>'consumer'
  or jsonb_typeof(_request) is distinct from 'object' or coalesce(action,'') not in ('read','grant','withdraw')
  or jsonb_typeof(_request->'connectionId') is distinct from 'string' then raise exception 'fullscript_consent_refused'; end if;
 if (action='read' and _request-array['action','connectionId']<>'{}'::jsonb)
  or (action='withdraw' and _request-array['action','connectionId','expectedRevision']<>'{}'::jsonb)
  or (action='grant' and _request-array['action','connectionId','expectedRevision','releaseId','contentSha256']<>'{}'::jsonb)
  then raise exception 'fullscript_consent_refused'; end if;
 person:=fullscript_delivery.set_actor(_actor);
 select * into c from clinical_core.patient_connections where id=(_request->>'connectionId')::uuid and organization_id=org
  and consumer_person_id=person for update;
 if c.id is null then raise exception 'fullscript_consent_refused'; end if;
 select * into g from fullscript_delivery.external_consents where connection_id=c.id order by revision desc limit 1;
 if action<>'read' then
  if jsonb_typeof(_request->'expectedRevision') is distinct from 'number' or _request->>'expectedRevision'!~'^(0|[1-9][0-9]{0,8})$'
   then raise exception 'fullscript_consent_refused'; end if;
  expected:=(_request->>'expectedRevision')::integer;
 end if;
 if action='withdraw' then
  if g.status='withdrawn' and g.revision in(expected,expected+1) then return jsonb_build_object('status','withdrawn','revision',g.revision); end if;
  if g.status is distinct from 'granted' or g.revision<>expected then raise exception 'fullscript_consent_conflict'; end if;
  insert into fullscript_delivery.external_consents(organization_id,connection_id,patient_record_id,consumer_person_id,release_id,revision,status)
   values(org,c.id,c.patient_record_id,person,g.release_id,g.revision+1,'withdrawn') returning * into g;
  return jsonb_build_object('status',g.status,'revision',g.revision);
 end if;
 begin
  provider:=fullscript_delivery.current_release(org,'provider',org);
  release:=fullscript_delivery.current_release(org,'consent',provider.id);
  -- A reviewed clinic-sharing copy is not an external-provider consent. Keep
  -- the displayed copy, its own UTF-8 digest and provider release explicit.
  if release.content-array['contract','providerReleaseId','content','contentSha256','jurisdiction']<>'{}'::jsonb
   or release.content->>'contract' is distinct from 'fullscript-external-consent/1'
   or release.content->>'providerReleaseId' is distinct from provider.id::text
   or jsonb_typeof(release.content->'content') is distinct from 'string'
   or length(btrim(release.content->>'content'))=0 or length(release.content->>'content')>16000
   or release.content->>'contentSha256' is distinct from encode(public.digest(convert_to(release.content->>'content','UTF8'),'sha256'),'hex')
   or jsonb_typeof(release.content->'jurisdiction') is distinct from 'string'
   or length(btrim(release.content->>'jurisdiction'))=0 then raise exception 'fullscript_consent_refused'; end if;
 exception when others then release:=null; end;
 if action='read' then return jsonb_build_object('status',coalesce(g.status,'not_granted'),'revision',coalesce(g.revision,0),
  'currentGrant',coalesce(c.state='verified' and g.status='granted' and g.release_id=release.id,false),
  'release',case when release.id is null then null else jsonb_build_object('id',release.id,'sha256',release.content_sha256,'content',release.content) end); end if;
 if c.state<>'verified' or release.id is null or _request->>'releaseId' is distinct from release.id::text
  or _request->>'contentSha256' is distinct from release.content_sha256 then raise exception 'fullscript_consent_refused'; end if;
 perform clinical_private.assert_owned_storage_writable(person);
 if g.status='granted' and g.release_id=release.id and g.revision in(expected,expected+1) then
  return jsonb_build_object('status',g.status,'revision',g.revision); end if;
 if coalesce(g.revision,0)<>expected then raise exception 'fullscript_consent_conflict'; end if;
 insert into fullscript_delivery.external_consents(organization_id,connection_id,patient_record_id,consumer_person_id,release_id,revision,status)
  values(org,c.id,c.patient_record_id,person,release.id,expected+1,'granted') returning * into g;
 return jsonb_build_object('status',g.status,'revision',g.revision);
end $$;
revoke all on function fullscript_delivery.external_consent_request(jsonb,jsonb) from public,clinical_core_api;
grant execute on function fullscript_delivery.external_consent_request(jsonb,jsonb) to fullscript_draft_worker;
