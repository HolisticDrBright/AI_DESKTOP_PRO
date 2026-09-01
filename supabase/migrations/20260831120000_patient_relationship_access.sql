-- Patient-authorized family/caregiver access.
-- Staff may initiate a request, but no clinical access becomes active until
-- the patient approves exact scopes and the recipient claims the short-lived
-- invitation with the same verified email. Direct table writes remain closed.

create table public.patient_relationships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  recipient_user_id uuid references auth.users(id) on delete set null,
  display_name text not null check (char_length(display_name) between 1 and 120),
  masked_email text not null check (char_length(masked_email) between 5 and 320),
  recipient_email_sha256 text not null check (recipient_email_sha256 ~ '^[0-9a-f]{64}$'),
  relationship_type text not null check (relationship_type in
    ('parent','adult_child','spouse_partner','sibling','family_caregiver','other')),
  authority_basis text not null default 'patient_authorized'
    check (authority_basis = 'patient_authorized'),
  requested_scopes text[] not null,
  granted_scopes text[] not null default '{}',
  status text not null default 'pending_patient_approval' check (status in
    ('pending_patient_approval','pending_recipient_claim','active','revoked','expired')),
  invitation_code_sha256 text not null unique check (invitation_code_sha256 ~ '^[0-9a-f]{64}$'),
  invitation_expires_at timestamptz not null,
  access_duration_days integer not null check (access_duration_days in (30,90,365)),
  access_expires_at timestamptz,
  invited_by uuid not null references auth.users(id),
  patient_approved_at timestamptz,
  recipient_claimed_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  revocation_reason_present boolean not null default false,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(requested_scopes) between 1 and 3),
  check (granted_scopes <@ requested_scopes),
  check (requested_scopes <@ array['protocols_supplements','laboratory_results','medical_records']::text[]),
  check (granted_scopes <@ array['protocols_supplements','laboratory_results','medical_records']::text[]),
  check ((status='active') = (patient_approved_at is not null and recipient_claimed_at is not null
    and recipient_user_id is not null and access_expires_at is not null and revoked_at is null))
);

create index patient_relationships_patient_idx
  on public.patient_relationships(organization_id,patient_id,created_at desc);
create index patient_relationships_recipient_idx
  on public.patient_relationships(recipient_user_id,status)
  where recipient_user_id is not null;
create unique index patient_relationships_open_email_uniq
  on public.patient_relationships(patient_id,recipient_email_sha256)
  where status in ('pending_patient_approval','pending_recipient_claim','active');
create trigger patient_relationships_set_updated_at before update on public.patient_relationships
  for each row execute function public.set_updated_at();

alter table public.patient_relationships enable row level security;
create policy patient_relationships_select on public.patient_relationships for select using (
  private.can_access_patient(patient_id) or recipient_user_id=auth.uid()
);
revoke all on table public.patient_relationships from public,authenticated;

create or replace function private.patient_relationship_scope_allowed(_patient_id uuid,_scope text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.patient_relationships relationship
    where relationship.patient_id=_patient_id and relationship.recipient_user_id=auth.uid()
      and relationship.status='active' and relationship.revoked_at is null
      and relationship.access_expires_at>now() and _scope=any(relationship.granted_scopes));
$$;
revoke all on function private.patient_relationship_scope_allowed(uuid,text) from public;
grant execute on function private.patient_relationship_scope_allowed(uuid,text) to authenticated,service_role;

create or replace function public.get_patient_relationships(_organization_id uuid,_patient_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _rows jsonb;
begin
  if not private.can_access_patient(_patient_id) or not exists(select 1 from public.patient_profiles
    where id=_patient_id and organization_id=_organization_id and deleted_at is null) then
    raise exception using errcode='42501',message='patient_access_refused';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',relationship.id,'displayName',relationship.display_name,'maskedEmail',relationship.masked_email,
    'relationshipType',relationship.relationship_type,'authorityBasis',relationship.authority_basis,
    'status',case when relationship.status not in ('revoked','expired') and
      coalesce(relationship.access_expires_at,relationship.invitation_expires_at)<=now() then 'expired'
      else relationship.status end,
    'requestedScopes',to_jsonb(relationship.requested_scopes),'grantedScopes',to_jsonb(relationship.granted_scopes),
    'patientApprovedAt',relationship.patient_approved_at,'recipientClaimedAt',relationship.recipient_claimed_at,
    'expiresAt',coalesce(relationship.access_expires_at,relationship.invitation_expires_at),
    'revokedAt',relationship.revoked_at,'createdAt',relationship.created_at,'version',relationship.version)
    order by relationship.created_at desc),'[]'::jsonb) into _rows
  from public.patient_relationships relationship
  where relationship.organization_id=_organization_id and relationship.patient_id=_patient_id;
  return jsonb_build_object('patientId',_patient_id,'relationships',_rows,'generatedAt',clock_timestamp());
end $$;

create or replace function public.create_patient_relationship_invitation(
  _organization_id uuid,_patient_id uuid,_display_name text,_email text,
  _relationship_type text,_requested_scopes text[],_expires_in_days integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _uid uuid:=auth.uid(); _email_normalized text:=lower(btrim(coalesce(_email,'')));
  _email_hash text; _code text; _row public.patient_relationships%rowtype; _local text; _domain text;
begin
  if _uid is null then raise exception using errcode='28000',message='authentication_required'; end if;
  if not (private.is_org_admin(_organization_id) or private.has_org_role(_organization_id,'practitioner'))
    or not exists(select 1 from public.patient_profiles where id=_patient_id
      and organization_id=_organization_id and deleted_at is null) then
    raise exception using errcode='42501',message='patient_access_refused';
  end if;
  if btrim(coalesce(_display_name,''))='' or char_length(_display_name)>120
    or _email_normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(_email_normalized)>320
    or _relationship_type not in ('parent','adult_child','spouse_partner','sibling','family_caregiver','other')
    or _expires_in_days not in (30,90,365)
    or cardinality(_requested_scopes) not between 1 and 3
    or not (_requested_scopes <@ array['protocols_supplements','laboratory_results','medical_records']::text[])
    or cardinality(_requested_scopes)<>cardinality(array(select distinct unnest(_requested_scopes))) then
    raise exception using errcode='22023',message='relationship_invitation_invalid';
  end if;
  _email_hash:=encode(extensions.digest(_email_normalized,'sha256'),'hex');
  if exists(select 1 from public.patient_relationships where patient_id=_patient_id
    and recipient_email_sha256=_email_hash and status in ('pending_patient_approval','pending_recipient_claim','active')) then
    raise exception using errcode='23505',message='relationship_already_exists';
  end if;
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    1+(get_byte(extensions.gen_random_bytes(1),0)%32),1),'') into _code from generate_series(1,10);
  _local:=split_part(_email_normalized,'@',1); _domain:=split_part(_email_normalized,'@',2);
  insert into public.patient_relationships(organization_id,patient_id,display_name,masked_email,
    recipient_email_sha256,relationship_type,requested_scopes,invitation_code_sha256,
    invitation_expires_at,access_duration_days,invited_by)
  values(_organization_id,_patient_id,btrim(_display_name),left(_local,1)||'***@'||_domain,
    _email_hash,_relationship_type,_requested_scopes,
    encode(extensions.digest(lower(_code),'sha256'),'hex'),now()+interval '7 days',_expires_in_days,_uid)
  returning * into _row;
  insert into public.audit_events(organization_id,patient_id,actor_user_id,action,resource_type,
    resource_id,safe_message,metadata) values(_organization_id,_patient_id,_uid,'relationship.invited',
    'patient_relationship',_row.id::text,'Family access approval requested',jsonb_build_object(
      'relationship_type',_relationship_type,'requested_scopes',_requested_scopes,
      'access_duration_days',_expires_in_days));
  return jsonb_build_object('relationship',jsonb_build_object(
      'id',_row.id,'displayName',_row.display_name,'maskedEmail',_row.masked_email,
      'relationshipType',_row.relationship_type,'authorityBasis',_row.authority_basis,
      'status',_row.status,'requestedScopes',to_jsonb(_row.requested_scopes),
      'grantedScopes',to_jsonb(_row.granted_scopes),'patientApprovedAt',_row.patient_approved_at,
      'recipientClaimedAt',_row.recipient_claimed_at,'expiresAt',_row.invitation_expires_at,
      'revokedAt',_row.revoked_at,'createdAt',_row.created_at,'version',_row.version),
    'invitationCode',_code,'deliveryState','manual_secure_delivery_required');
end $$;

-- Patient app/portal operation: patient approves a subset of the request.
create or replace function public.approve_patient_relationship(_relationship_id uuid,_approved_scopes text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare _uid uuid:=auth.uid(); _row public.patient_relationships%rowtype;
begin
  select relationship.* into _row from public.patient_relationships relationship
    join public.patient_profiles patient on patient.id=relationship.patient_id
    where relationship.id=_relationship_id and patient.user_id=_uid for update;
  if not found or _row.status<>'pending_patient_approval' or _row.invitation_expires_at<=now() then
    raise exception using errcode='42501',message='relationship_approval_refused'; end if;
  if cardinality(_approved_scopes)<1 or not (_approved_scopes <@ _row.requested_scopes)
    or cardinality(_approved_scopes)<>cardinality(array(select distinct unnest(_approved_scopes))) then
    raise exception using errcode='22023',message='relationship_scope_invalid'; end if;
  update public.patient_relationships set granted_scopes=_approved_scopes,patient_approved_at=now(),
    access_expires_at=now()+make_interval(days=>access_duration_days),
    status=case when recipient_user_id is null then 'pending_recipient_claim' else 'active' end,
    version=version+1 where id=_relationship_id returning * into _row;
  insert into public.audit_events(organization_id,patient_id,actor_user_id,action,resource_type,
    resource_id,safe_message,metadata) values(_row.organization_id,_row.patient_id,_uid,
    'relationship.patient_approved','patient_relationship',_row.id::text,
    'Patient approved family access',jsonb_build_object('granted_scopes',_approved_scopes));
  return jsonb_build_object('relationshipId',_row.id,'status',_row.status,'version',_row.version);
end $$;

-- Recipient operation: invitation possession and matching verified email are both required.
create or replace function public.claim_patient_relationship(_invitation_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _uid uuid:=auth.uid(); _email text:=lower(coalesce(auth.jwt()->>'email',''));
  _row public.patient_relationships%rowtype;
begin
  if _uid is null or _email='' then raise exception using errcode='28000',message='verified_email_required'; end if;
  if not exists(select 1 from auth.users where id=_uid and lower(email)=_email
    and email_confirmed_at is not null) then
    raise exception using errcode='28000',message='verified_email_required'; end if;
  select * into _row from public.patient_relationships where invitation_code_sha256=
    encode(extensions.digest(lower(btrim(_invitation_code)),'sha256'),'hex') for update;
  if not found or _row.invitation_expires_at<=now()
    or _row.recipient_email_sha256<>encode(extensions.digest(_email,'sha256'),'hex')
    or _row.status not in ('pending_patient_approval','pending_recipient_claim') then
    raise exception using errcode='42501',message='relationship_claim_refused'; end if;
  update public.patient_relationships set recipient_user_id=_uid,recipient_claimed_at=now(),
    status=case when patient_approved_at is null then 'pending_patient_approval' else 'active' end,
    version=version+1 where id=_row.id returning * into _row;
  insert into public.audit_events(organization_id,patient_id,actor_user_id,action,resource_type,
    resource_id,safe_message,metadata) values(_row.organization_id,_row.patient_id,_uid,
    'relationship.recipient_claimed','patient_relationship',_row.id::text,
    'Family access invitation claimed',jsonb_build_object('matched_verified_email',true));
  return jsonb_build_object('relationshipId',_row.id,'status',_row.status,'version',_row.version);
end $$;

create or replace function public.revoke_patient_relationship(_relationship_id uuid,_expected_version integer,_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _uid uuid:=auth.uid(); _row public.patient_relationships%rowtype; _patient_user uuid;
begin
  select * into _row from public.patient_relationships where id=_relationship_id for update;
  if found then select user_id into _patient_user from public.patient_profiles where id=_row.patient_id; end if;
  if _row.id is null or _uid is null or not (_uid=_patient_user or _uid=_row.recipient_user_id
    or private.is_org_admin(_row.organization_id) or private.has_org_role(_row.organization_id,'practitioner')) then
    raise exception using errcode='42501',message='relationship_revoke_refused'; end if;
  if _row.version<>_expected_version or _row.status in ('revoked','expired') then
    raise exception using errcode='40001',message='relationship_version_conflict'; end if;
  if char_length(btrim(coalesce(_reason,''))) not between 3 and 500 then
    raise exception using errcode='22023',message='relationship_revocation_reason_required'; end if;
  update public.patient_relationships set status='revoked',revoked_at=now(),revoked_by=_uid,
    revocation_reason_present=true,granted_scopes='{}',version=version+1
    where id=_relationship_id returning * into _row;
  insert into public.audit_events(organization_id,patient_id,actor_user_id,action,resource_type,
    resource_id,safe_message,metadata) values(_row.organization_id,_row.patient_id,_uid,
    'relationship.revoked','patient_relationship',_row.id::text,'Family access revoked',
    jsonb_build_object('reason_present',true));
  return jsonb_build_object('relationshipId',_row.id,'status','revoked','version',_row.version);
end $$;

revoke all on function public.get_patient_relationships(uuid,uuid) from public;
revoke all on function public.create_patient_relationship_invitation(uuid,uuid,text,text,text,text[],integer) from public;
revoke all on function public.approve_patient_relationship(uuid,text[]) from public;
revoke all on function public.claim_patient_relationship(text) from public;
revoke all on function public.revoke_patient_relationship(uuid,integer,text) from public;
grant execute on function public.get_patient_relationships(uuid,uuid) to authenticated,service_role;
grant execute on function public.create_patient_relationship_invitation(uuid,uuid,text,text,text,text[],integer) to authenticated,service_role;
grant execute on function public.approve_patient_relationship(uuid,text[]) to authenticated,service_role;
grant execute on function public.claim_patient_relationship(text) to authenticated,service_role;
grant execute on function public.revoke_patient_relationship(uuid,integer,text) to authenticated,service_role;
