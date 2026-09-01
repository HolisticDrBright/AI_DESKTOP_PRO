-- Synthetic patient approval and recipient claim for read-only family access.
-- No relationship, identity, consent, or clinical row is seeded.

create table clinical_core.patient_relationships(
  id uuid primary key default public.gen_random_uuid(), organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id), recipient_person_id uuid references clinical_core.persons(id),
  display_name text not null check(char_length(display_name) between 1 and 120), masked_email text not null,
  recipient_email_sha256 text not null check(recipient_email_sha256~'^[0-9a-f]{64}$'),
  relationship_type text not null check(relationship_type in ('parent','adult_child','spouse_partner','sibling','family_caregiver','other')),
  requested_scopes text[] not null, granted_scopes text[] not null default '{}',
  status text not null default 'pending_patient_approval' check(status in ('pending_patient_approval','pending_recipient_claim','active','revoked','expired')),
  invitation_code_sha256 text not null unique, invitation_expires_at timestamptz not null,
  access_duration_days integer not null check(access_duration_days in(30,90,365)), access_expires_at timestamptz,
  invited_by_person_id uuid not null references clinical_core.persons(id), patient_approved_at timestamptz,
  recipient_claimed_at timestamptz, revoked_at timestamptz, revoked_by_person_id uuid references clinical_core.persons(id),
  version integer not null default 1 check(version>0), created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(), unique(id,organization_id),
  foreign key(patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id),
  check(cardinality(requested_scopes) between 1 and 3), check(granted_scopes<@requested_scopes),
  check(requested_scopes<@array['protocols_supplements','laboratory_results','medical_records']::text[]),
  check((status='active')=(patient_approved_at is not null and recipient_claimed_at is not null and recipient_person_id is not null and access_expires_at is not null and revoked_at is null)));
create index patient_relationships_patient_idx on clinical_core.patient_relationships(organization_id,patient_record_id,created_at desc);
create index patient_relationships_recipient_idx on clinical_core.patient_relationships(recipient_person_id,status) where recipient_person_id is not null;
alter table clinical_core.patient_relationships enable row level security;
revoke all on clinical_core.patient_relationships from public,clinical_core_api;

create table clinical_audit.patient_relationship_events(
  id uuid primary key default public.gen_random_uuid(), relationship_id uuid not null references clinical_core.patient_relationships(id),
  actor_person_id uuid not null references clinical_core.persons(id), action text not null check(action in ('invited','patient_approved','recipient_claimed','accessed','revoked')),
  safe_metadata jsonb not null default '{}', occurred_at timestamptz not null default clock_timestamp(),
  check(jsonb_typeof(safe_metadata)='object'), check(not(safe_metadata ?| array['email','name','token','code','reason','medical_record','protocol'])));
alter table clinical_audit.patient_relationship_events enable row level security;
revoke all on clinical_audit.patient_relationship_events from public,clinical_core_api;

create or replace function clinical_private.require_relationship_patient(_organization_id uuid,_patient_id uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$ declare _actor uuid:=clinical_private.actor_person_id(); begin
  if clinical_private.organization_id()<>_organization_id or clinical_private.claim('identity_pool')<>'consumer'
    or clinical_private.claim('purpose') not in ('clinical_data','consent_management')
    or not exists(select 1 from clinical_core.patient_connections where organization_id=_organization_id and patient_record_id=_patient_id
      and consumer_person_id=_actor and state in ('verified','paused')) then raise exception using errcode='42501',message='relationship_patient_refused'; end if;
  return _actor; end $$;
revoke all on function clinical_private.require_relationship_patient(uuid,uuid) from public;

create or replace function clinical_core.list_my_patient_relationship_requests() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _rows jsonb; begin
  perform clinical_private.assert_synthetic_context(clinical_private.organization_id(),clinical_private.claim('purpose'),'consumer');
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'displayName',r.display_name,'maskedEmail',r.masked_email,
    'relationshipType',r.relationship_type,'status',case when r.invitation_expires_at<=clock_timestamp() and r.status<>'active' then 'expired' else r.status end,
    'requestedScopes',to_jsonb(r.requested_scopes),'grantedScopes',to_jsonb(r.granted_scopes),'recipientClaimed',r.recipient_claimed_at is not null,
    'expiresAt',coalesce(r.access_expires_at,r.invitation_expires_at),'version',r.version,'createdAt',r.created_at) order by r.created_at desc),'[]'::jsonb) into _rows
  from clinical_core.patient_relationships r join clinical_core.patient_connections c on c.patient_record_id=r.patient_record_id and c.organization_id=r.organization_id
  where c.consumer_person_id=_actor and c.state in ('verified','paused');
  return jsonb_build_object('relationships',_rows,'generatedAt',clock_timestamp()); end $$;

create or replace function clinical_core.approve_patient_relationship(_relationship_id uuid,_expected_version integer,_scopes text[],_consent_version text)
returns jsonb language plpgsql security definer set search_path='' as $$ declare _r clinical_core.patient_relationships%rowtype; _actor uuid; begin
  select * into _r from clinical_core.patient_relationships where id=_relationship_id for update;
  if not found then raise exception using errcode='P0002',message='relationship_not_found'; end if;
  _actor:=clinical_private.require_relationship_patient(_r.organization_id,_r.patient_record_id);
  if _r.version<>_expected_version or _r.status in ('active','revoked','expired') or _r.invitation_expires_at<=clock_timestamp()
    or cardinality(_scopes) not between 1 and 3 or not(_scopes<@_r.requested_scopes) or char_length(_consent_version) not between 3 and 100
    then raise exception using errcode='40001',message='relationship_version_conflict'; end if;
  update clinical_core.patient_relationships set granted_scopes=_scopes,patient_approved_at=clock_timestamp(),
    status=case when recipient_claimed_at is null then 'pending_recipient_claim' else 'active' end,
    access_expires_at=case when recipient_claimed_at is null then null else clock_timestamp()+make_interval(days=>access_duration_days) end,
    version=version+1,updated_at=clock_timestamp() where id=_relationship_id returning * into _r;
  insert into clinical_audit.patient_relationship_events(relationship_id,actor_person_id,action,safe_metadata)
    values(_r.id,_actor,'patient_approved',jsonb_build_object('scopes',_scopes,'consent_version',_consent_version));
  return jsonb_build_object('relationshipId',_r.id,'status',_r.status,'version',_r.version); end $$;

create or replace function clinical_core.claim_patient_relationship_invitation(_code text,_verified_email_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$ declare _r clinical_core.patient_relationships%rowtype; _actor uuid:=clinical_private.actor_person_id(); begin
  perform clinical_private.assert_synthetic_context(clinical_private.organization_id(),clinical_private.claim('purpose'),'consumer');
  if _verified_email_sha256!~'^[0-9a-f]{64}$' then raise exception using errcode='22023',message='relationship_invitation_invalid'; end if;
  select * into _r from clinical_core.patient_relationships where invitation_code_sha256=encode(public.digest(lower(_code),'sha256'),'hex') for update;
  if not found or _r.recipient_email_sha256<>_verified_email_sha256 or _r.invitation_expires_at<=clock_timestamp() or _r.status in ('active','revoked','expired')
    then raise exception using errcode='P0002',message='relationship_invitation_invalid'; end if;
  update clinical_core.patient_relationships set recipient_person_id=_actor,recipient_claimed_at=clock_timestamp(),
    status=case when patient_approved_at is null then 'pending_patient_approval' else 'active' end,
    access_expires_at=case when patient_approved_at is null then null else clock_timestamp()+make_interval(days=>access_duration_days) end,
    version=version+1,updated_at=clock_timestamp() where id=_r.id returning * into _r;
  insert into clinical_audit.patient_relationship_events(relationship_id,actor_person_id,action) values(_r.id,_actor,'recipient_claimed');
  return jsonb_build_object('relationshipId',_r.id,'status',_r.status,'version',_r.version); end $$;

create or replace function clinical_core.list_my_delegated_patient_access() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _rows jsonb; begin
  perform clinical_private.assert_synthetic_context(clinical_private.organization_id(),clinical_private.claim('purpose'),'consumer');
  select coalesce(jsonb_agg(jsonb_build_object('relationshipId',id,'patientDisplayName',display_name,'relationshipType',relationship_type,
    'grantedScopes',to_jsonb(granted_scopes),'expiresAt',access_expires_at,'version',version) order by updated_at desc),'[]'::jsonb) into _rows
  from clinical_core.patient_relationships where recipient_person_id=_actor and status='active' and revoked_at is null and access_expires_at>clock_timestamp();
  return jsonb_build_object('relationships',_rows,'generatedAt',clock_timestamp()); end $$;

create or replace function clinical_core.get_delegated_patient_records(_relationship_id uuid,_scope text) returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_core.patient_relationships%rowtype; _items jsonb:='[]'::jsonb; _actor uuid:=clinical_private.actor_person_id(); begin
  perform clinical_private.assert_synthetic_context(clinical_private.organization_id(),clinical_private.claim('purpose'),'consumer');
  select * into _r from clinical_core.patient_relationships where id=_relationship_id and recipient_person_id=_actor and status='active'
    and revoked_at is null and access_expires_at>clock_timestamp() and _scope=any(granted_scopes);
  if not found then raise exception using errcode='42501',message='relationship_access_refused'; end if;
  if _scope='laboratory_results' then select coalesce(jsonb_agg(jsonb_build_object('id',id,'markerName',marker_name,'value',value_numeric,
    'unit',unit,'observedAt',observed_at,'reviewStatus',review_status) order by observed_at desc),'[]'::jsonb) into _items
    from clinical_core.lab_observations where organization_id=_r.organization_id and patient_record_id=_r.patient_record_id and review_status='reviewed';
  elsif _scope='protocols_supplements' then select coalesce(jsonb_agg(payload order by received_at desc),'[]'::jsonb) into _items
    from (select distinct on(record_key) payload,received_at,deleted from clinical_core.consumer_clinical_record_versions
      where patient_record_id=_r.patient_record_id and collection='protocols' order by record_key,received_at desc,id desc) current where not deleted;
  elsif _scope<>'medical_records' then raise exception using errcode='22023',message='relationship_scope_invalid'; end if;
  insert into clinical_audit.patient_relationship_events(relationship_id,actor_person_id,action,safe_metadata)
    values(_r.id,_actor,'accessed',jsonb_build_object('scope',_scope,'item_count',jsonb_array_length(_items)));
  return jsonb_build_object('relationshipId',_r.id,'patientDisplayName',_r.display_name,'scope',_scope,'readOnly',true,
    'items',_items,'generatedAt',clock_timestamp()); end $$;

create or replace function clinical_core.revoke_my_patient_relationship(_relationship_id uuid,_expected_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$ declare _r clinical_core.patient_relationships%rowtype; _actor uuid:=clinical_private.actor_person_id(); begin
  select * into _r from clinical_core.patient_relationships where id=_relationship_id for update;
  if not found or _r.version<>_expected_version or _r.status in ('revoked','expired') or not(_r.recipient_person_id=_actor or exists(
    select 1 from clinical_core.patient_connections where patient_record_id=_r.patient_record_id and consumer_person_id=_actor and state in('verified','paused')))
    then raise exception using errcode='42501',message='relationship_revocation_refused'; end if;
  update clinical_core.patient_relationships set status='revoked',revoked_at=clock_timestamp(),revoked_by_person_id=_actor,
    granted_scopes='{}',version=version+1,updated_at=clock_timestamp() where id=_relationship_id returning * into _r;
  insert into clinical_audit.patient_relationship_events(relationship_id,actor_person_id,action) values(_r.id,_actor,'revoked');
  return jsonb_build_object('relationshipId',_r.id,'status','revoked','version',_r.version); end $$;

revoke all on function clinical_core.list_my_patient_relationship_requests() from public;
revoke all on function clinical_core.approve_patient_relationship(uuid,integer,text[],text) from public;
revoke all on function clinical_core.claim_patient_relationship_invitation(text,text) from public;
revoke all on function clinical_core.list_my_delegated_patient_access() from public;
revoke all on function clinical_core.get_delegated_patient_records(uuid,text) from public;
revoke all on function clinical_core.revoke_my_patient_relationship(uuid,integer) from public;
grant execute on function clinical_core.list_my_patient_relationship_requests() to clinical_core_api;
grant execute on function clinical_core.approve_patient_relationship(uuid,integer,text[],text) to clinical_core_api;
grant execute on function clinical_core.claim_patient_relationship_invitation(text,text) to clinical_core_api;
grant execute on function clinical_core.list_my_delegated_patient_access() to clinical_core_api;
grant execute on function clinical_core.get_delegated_patient_records(uuid,text) to clinical_core_api;
grant execute on function clinical_core.revoke_my_patient_relationship(uuid,integer) to clinical_core_api;
