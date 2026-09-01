-- Patient-authorized family/caregiver access control plane.
-- No relationship, identity, consent, or clinical row is seeded. The Desktop
-- can initiate and revoke requests; patient approval and recipient claim must
-- be completed through a separately authenticated consumer workflow.

create table clinical_core.patient_relationships (
  id uuid primary key default public.gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  recipient_person_id uuid references clinical_core.persons(id),
  display_name text not null check (char_length(display_name) between 1 and 120),
  masked_email text not null check (char_length(masked_email) between 5 and 320),
  recipient_email_sha256 text not null check (recipient_email_sha256 ~ '^[0-9a-f]{64}$'),
  relationship_type text not null check (relationship_type in
    ('parent','adult_child','spouse_partner','sibling','family_caregiver','other')),
  authority_basis text not null default 'patient_authorized' check (authority_basis='patient_authorized'),
  requested_scopes text[] not null,
  granted_scopes text[] not null default '{}',
  status text not null default 'pending_patient_approval' check (status in
    ('pending_patient_approval','pending_recipient_claim','active','revoked','expired')),
  invitation_code_sha256 text not null unique check (invitation_code_sha256 ~ '^[0-9a-f]{64}$'),
  invitation_expires_at timestamptz not null,
  access_duration_days integer not null check (access_duration_days in (30,90,365)),
  access_expires_at timestamptz,
  invited_by_person_id uuid not null references clinical_core.persons(id),
  patient_approved_at timestamptz,
  recipient_claimed_at timestamptz,
  revoked_at timestamptz,
  revoked_by_person_id uuid references clinical_core.persons(id),
  revocation_reason_present boolean not null default false,
  version integer not null default 1 check (version>0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(id,organization_id),
  foreign key(patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id),
  check(cardinality(requested_scopes) between 1 and 3),
  check(granted_scopes <@ requested_scopes),
  check(requested_scopes <@ array['protocols_supplements','laboratory_results','medical_records']::text[]),
  check(granted_scopes <@ array['protocols_supplements','laboratory_results','medical_records']::text[]),
  check((status='active')=(patient_approved_at is not null and recipient_claimed_at is not null
    and recipient_person_id is not null and access_expires_at is not null and revoked_at is null))
);
create index patient_relationships_patient_idx on clinical_core.patient_relationships(
  organization_id,patient_record_id,created_at desc);
create index patient_relationships_recipient_idx on clinical_core.patient_relationships(
  recipient_person_id,status) where recipient_person_id is not null;
create unique index patient_relationships_open_email_uniq on clinical_core.patient_relationships(
  patient_record_id,recipient_email_sha256)
  where status in ('pending_patient_approval','pending_recipient_claim','active');

create table clinical_audit.patient_relationship_events (
  id uuid primary key default public.gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  relationship_id uuid not null references clinical_core.patient_relationships(id),
  actor_person_id uuid not null references clinical_core.persons(id),
  action text not null check(action in
    ('invited','patient_approved','recipient_claimed','accessed','revoked','expired')),
  safe_metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  check(jsonb_typeof(safe_metadata)='object'),
  check(not(safe_metadata ?| array['email','name','token','code','reason','medical_record','protocol']))
);
create index patient_relationship_events_patient_idx on clinical_audit.patient_relationship_events(
  organization_id,patient_record_id,occurred_at desc);

alter table clinical_core.patient_relationships enable row level security;
alter table clinical_audit.patient_relationship_events enable row level security;
revoke all on clinical_core.patient_relationships from public,clinical_core_api;
revoke all on clinical_audit.patient_relationship_events from public,clinical_core_api;
create trigger patient_relationship_events_append_only before update or delete
  on clinical_audit.patient_relationship_events for each row
  execute function clinical_reference.reject_immutable_catalog_history();

create or replace function clinical_private.patient_relationship_scope_allowed(
  _organization_id uuid,_patient_id uuid,_scope text
) returns boolean language sql stable security definer set search_path='' as $$
  select clinical_private.claim('identity_pool')='consumer' and exists(
    select 1 from clinical_core.patient_relationships relationship
    where relationship.organization_id=_organization_id and relationship.patient_record_id=_patient_id
      and relationship.recipient_person_id=clinical_private.actor_person_id()
      and relationship.status='active' and relationship.revoked_at is null
      and relationship.access_expires_at>now()
      and _scope=any(relationship.granted_scopes));
$$;
revoke all on function clinical_private.patient_relationship_scope_allowed(uuid,uuid,text) from public;
grant execute on function clinical_private.patient_relationship_scope_allowed(uuid,uuid,text) to clinical_core_api;

create or replace function clinical_core.get_patient_relationships(_organization_id uuid,_patient_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _rows jsonb;
begin
  perform clinical_private.require_clinical_patient(_organization_id,_patient_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',relationship.id,'displayName',relationship.display_name,'maskedEmail',relationship.masked_email,
    'relationshipType',relationship.relationship_type,'authorityBasis',relationship.authority_basis,
    'status',case when relationship.status not in ('revoked','expired') and
      coalesce(relationship.access_expires_at,relationship.invitation_expires_at)<=clock_timestamp()
      then 'expired' else relationship.status end,
    'requestedScopes',to_jsonb(relationship.requested_scopes),'grantedScopes',to_jsonb(relationship.granted_scopes),
    'patientApprovedAt',relationship.patient_approved_at,'recipientClaimedAt',relationship.recipient_claimed_at,
    'expiresAt',coalesce(relationship.access_expires_at,relationship.invitation_expires_at),
    'revokedAt',relationship.revoked_at,'createdAt',relationship.created_at,'version',relationship.version)
    order by relationship.created_at desc),'[]'::jsonb) into _rows
  from clinical_core.patient_relationships relationship
  where relationship.organization_id=_organization_id and relationship.patient_record_id=_patient_id;
  return jsonb_build_object('patientId',_patient_id,'relationships',_rows,'generatedAt',clock_timestamp());
end $$;

create or replace function clinical_core.create_patient_relationship_invitation(
  _organization_id uuid,_patient_id uuid,_display_name text,_email text,
  _relationship_type text,_requested_scopes text[],_expires_in_days integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid; _email_normalized text:=lower(btrim(coalesce(_email,''))); _email_hash text;
  _code text; _row clinical_core.patient_relationships%rowtype; _local text; _domain text;
begin
  _actor:=clinical_private.require_clinical_patient(_organization_id,_patient_id);
  if btrim(coalesce(_display_name,''))='' or char_length(_display_name)>120
    or _email_normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(_email_normalized)>320
    or _relationship_type not in ('parent','adult_child','spouse_partner','sibling','family_caregiver','other')
    or _expires_in_days not in (30,90,365)
    or cardinality(_requested_scopes) not between 1 and 3
    or not(_requested_scopes <@ array['protocols_supplements','laboratory_results','medical_records']::text[])
    or cardinality(_requested_scopes)<>cardinality(array(select distinct unnest(_requested_scopes))) then
    raise exception using errcode='22023',message='relationship_invitation_invalid'; end if;
  _email_hash:=encode(public.digest(_email_normalized,'sha256'),'hex');
  if exists(select 1 from clinical_core.patient_relationships where patient_record_id=_patient_id
    and recipient_email_sha256=_email_hash and status in
      ('pending_patient_approval','pending_recipient_claim','active')) then
    raise exception using errcode='23505',message='relationship_already_exists'; end if;
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    1+(get_byte(public.gen_random_bytes(1),0)%32),1),'') into _code from generate_series(1,10);
  _local:=split_part(_email_normalized,'@',1); _domain:=split_part(_email_normalized,'@',2);
  insert into clinical_core.patient_relationships(organization_id,patient_record_id,display_name,
    masked_email,recipient_email_sha256,relationship_type,requested_scopes,invitation_code_sha256,
    invitation_expires_at,access_duration_days,invited_by_person_id)
  values(_organization_id,_patient_id,btrim(_display_name),left(_local,1)||'***@'||_domain,
    _email_hash,_relationship_type,_requested_scopes,encode(public.digest(lower(_code),'sha256'),'hex'),
    clock_timestamp()+interval '7 days',_expires_in_days,_actor) returning * into _row;
  insert into clinical_audit.patient_relationship_events(organization_id,patient_record_id,
    relationship_id,actor_person_id,action,safe_metadata) values(_organization_id,_patient_id,
    _row.id,_actor,'invited',jsonb_build_object('relationship_type',_relationship_type,
      'requested_scopes',_requested_scopes,'access_duration_days',_expires_in_days));
  return jsonb_build_object('relationship',jsonb_build_object(
      'id',_row.id,'displayName',_row.display_name,'maskedEmail',_row.masked_email,
      'relationshipType',_row.relationship_type,'authorityBasis',_row.authority_basis,
      'status',_row.status,'requestedScopes',to_jsonb(_row.requested_scopes),
      'grantedScopes',to_jsonb(_row.granted_scopes),'patientApprovedAt',_row.patient_approved_at,
      'recipientClaimedAt',_row.recipient_claimed_at,'expiresAt',_row.invitation_expires_at,
      'revokedAt',_row.revoked_at,'createdAt',_row.created_at,'version',_row.version),
    'invitationCode',_code,'deliveryState','manual_secure_delivery_required');
end $$;

create or replace function clinical_core.revoke_patient_relationship(
  _relationship_id uuid,_expected_version integer,_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _row clinical_core.patient_relationships%rowtype;
begin
  select * into _row from clinical_core.patient_relationships where id=_relationship_id for update;
  if not found then raise exception using errcode='P0002',message='relationship_not_found'; end if;
  perform clinical_private.require_clinical_patient(_row.organization_id,_row.patient_record_id);
  if _row.version<>_expected_version or _row.status in ('revoked','expired') then
    raise exception using errcode='40001',message='relationship_version_conflict'; end if;
  if char_length(btrim(coalesce(_reason,''))) not between 3 and 500 then
    raise exception using errcode='22023',message='relationship_revocation_reason_required'; end if;
  update clinical_core.patient_relationships set status='revoked',revoked_at=clock_timestamp(),
    revoked_by_person_id=_actor,revocation_reason_present=true,granted_scopes='{}',
    version=version+1,updated_at=clock_timestamp() where id=_relationship_id returning * into _row;
  insert into clinical_audit.patient_relationship_events(organization_id,patient_record_id,
    relationship_id,actor_person_id,action,safe_metadata) values(_row.organization_id,
    _row.patient_record_id,_row.id,_actor,'revoked',jsonb_build_object('reason_present',true));
  return jsonb_build_object('relationshipId',_row.id,'status','revoked','version',_row.version);
end $$;

revoke all on function clinical_core.get_patient_relationships(uuid,uuid) from public;
revoke all on function clinical_core.create_patient_relationship_invitation(uuid,uuid,text,text,text,text[],integer) from public;
revoke all on function clinical_core.revoke_patient_relationship(uuid,integer,text) from public;
grant execute on function clinical_core.get_patient_relationships(uuid,uuid) to clinical_core_api;
grant execute on function clinical_core.create_patient_relationship_invitation(uuid,uuid,text,text,text,text[],integer) to clinical_core_api;
grant execute on function clinical_core.revoke_patient_relationship(uuid,integer,text) to clinical_core_api;
