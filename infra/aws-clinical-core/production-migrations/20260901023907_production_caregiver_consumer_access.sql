+-- Consumer completion of the patient-authorized family/caregiver workflow.
-- This migration creates no relationship, identity, consent, or clinical row.
-- Every read is scope-specific and is audited without clinical content.

create or replace function clinical_core.list_my_patient_relationship_requests()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _rows jsonb;
begin
  if clinical_private.claim('identity_pool')<>'consumer'
    or clinical_private.claim('purpose')<>'consent_management' then
    raise exception using errcode='42501',message='consumer_consent_context_required';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',relationship.id,'displayName',relationship.display_name,
    'maskedEmail',relationship.masked_email,'relationshipType',relationship.relationship_type,
    'status',case when relationship.status not in ('revoked','expired')
      and coalesce(relationship.access_expires_at,relationship.invitation_expires_at)<=clock_timestamp()
      then 'expired' else relationship.status end,
    'requestedScopes',to_jsonb(relationship.requested_scopes),
    'grantedScopes',to_jsonb(relationship.granted_scopes),
    'recipientClaimed',relationship.recipient_claimed_at is not null,
    'expiresAt',coalesce(relationship.access_expires_at,relationship.invitation_expires_at),
    'version',relationship.version,'createdAt',relationship.created_at)
    order by relationship.created_at desc),'[]'::jsonb) into _rows
  from clinical_core.patient_relationships relationship
  join clinical_core.patient_connections connection
    on connection.organization_id=relationship.organization_id
    and connection.patient_record_id=relationship.patient_record_id
    and connection.consumer_person_id=_actor and connection.state in ('verified','paused')
  where relationship.status not in ('revoked','expired');
  return jsonb_build_object('relationships',_rows,'generatedAt',clock_timestamp());
end $$;

create or replace function clinical_core.approve_patient_relationship(
  _relationship_id uuid,_expected_version integer,_granted_scopes text[],_consent_version text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _row clinical_core.patient_relationships%rowtype;
  _next_status text; _expires_at timestamptz;
begin
  if clinical_private.claim('identity_pool')<>'consumer'
    or clinical_private.claim('purpose')<>'consent_management' then
    raise exception using errcode='42501',message='consumer_consent_context_required';
  end if;
  select relationship.* into _row from clinical_core.patient_relationships relationship
  join clinical_core.patient_connections connection
    on connection.organization_id=relationship.organization_id
    and connection.patient_record_id=relationship.patient_record_id
    and connection.consumer_person_id=_actor and connection.state in ('verified','paused')
  where relationship.id=_relationship_id for update of relationship;
  if not found then raise exception using errcode='P0002',message='relationship_not_found'; end if;
  if _row.version<>_expected_version or _row.status<>'pending_patient_approval'
    or _row.invitation_expires_at<=clock_timestamp() then
    raise exception using errcode='40001',message='relationship_version_conflict'; end if;
  if cardinality(_granted_scopes) not between 1 and 3
    or not(_granted_scopes <@ _row.requested_scopes)
    or cardinality(_granted_scopes)<>cardinality(array(select distinct unnest(_granted_scopes)))
    or char_length(btrim(coalesce(_consent_version,''))) not between 1 and 100 then
    raise exception using errcode='22023',message='relationship_approval_invalid'; end if;
  _next_status:=case when _row.recipient_claimed_at is null then 'pending_recipient_claim' else 'active' end;
  _expires_at:=case when _next_status='active'
    then clock_timestamp()+make_interval(days=>_row.access_duration_days) else null end;
  update clinical_core.patient_relationships set granted_scopes=_granted_scopes,
    patient_approved_at=clock_timestamp(),status=_next_status,access_expires_at=_expires_at,
    version=version+1,updated_at=clock_timestamp()
    where id=_row.id returning * into _row;
  insert into clinical_audit.patient_relationship_events(organization_id,patient_record_id,
    relationship_id,actor_person_id,action,safe_metadata) values(_row.organization_id,
    _row.patient_record_id,_row.id,_actor,'patient_approved',
    jsonb_build_object('granted_scopes',_granted_scopes,'consent_version',_consent_version));
  return jsonb_build_object('relationshipId',_row.id,'status',_row.status,
    'grantedScopes',to_jsonb(_row.granted_scopes),'expiresAt',
    coalesce(_row.access_expires_at,_row.invitation_expires_at),'version',_row.version);
end $$;

create or replace function clinical_core.claim_patient_relationship_invitation(
  _code text,_verified_email_sha256 text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _row clinical_core.patient_relationships%rowtype;
  _code_hash text; _next_status text; _expires_at timestamptz;
begin
  if clinical_private.claim('identity_pool')<>'consumer'
    or clinical_private.claim('purpose')<>'identity_link'
    or _verified_email_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='42501',message='verified_consumer_identity_required';
  end if;
  if upper(btrim(coalesce(_code,''))) !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$' then
    raise exception using errcode='22023',message='relationship_invitation_invalid'; end if;
  _code_hash:=encode(public.digest(lower(upper(btrim(_code))),'sha256'),'hex');
  select * into _row from clinical_core.patient_relationships
    where invitation_code_sha256=_code_hash for update;
  if not found or _row.invitation_expires_at<=clock_timestamp()
    or _row.status in ('active','revoked','expired')
    or _row.recipient_email_sha256<>_verified_email_sha256 then
    raise exception using errcode='P0002',message='relationship_invitation_invalid'; end if;
  if exists(select 1 from clinical_core.patient_connections connection
    where connection.patient_record_id=_row.patient_record_id
      and connection.consumer_person_id=_actor and connection.state in ('verified','paused')) then
    raise exception using errcode='42501',message='relationship_self_claim_refused'; end if;
  _next_status:=case when _row.patient_approved_at is null then 'pending_patient_approval' else 'active' end;
  _expires_at:=case when _next_status='active'
    then clock_timestamp()+make_interval(days=>_row.access_duration_days) else null end;
  update clinical_core.patient_relationships set recipient_person_id=_actor,
    recipient_claimed_at=clock_timestamp(),status=_next_status,access_expires_at=_expires_at,
    version=version+1,updated_at=clock_timestamp()
    where id=_row.id returning * into _row;
  insert into clinical_audit.patient_relationship_events(organization_id,patient_record_id,
    relationship_id,actor_person_id,action,safe_metadata) values(_row.organization_id,
    _row.patient_record_id,_row.id,_actor,'recipient_claimed',
    jsonb_build_object('patient_approved',_row.patient_approved_at is not null));
  return jsonb_build_object('relationshipId',_row.id,'status',_row.status,
    'patientDisplayName',(select btrim(first_name||' '||last_name)
      from clinical_core.patient_records where id=_row.patient_record_id),
    'grantedScopes',to_jsonb(_row.granted_scopes),'expiresAt',
    coalesce(_row.access_expires_at,_row.invitation_expires_at),'version',_row.version);
end $$;

create or replace function clinical_core.list_my_delegated_patient_access()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _rows jsonb;
begin
  if clinical_private.claim('identity_pool')<>'consumer'
    or clinical_private.claim('purpose')<>'clinical_data' then
    raise exception using errcode='42501',message='consumer_clinical_context_required';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'relationshipId',relationship.id,'patientDisplayName',btrim(patient.first_name||' '||patient.last_name),
    'relationshipType',relationship.relationship_type,'grantedScopes',to_jsonb(relationship.granted_scopes),
    'expiresAt',relationship.access_expires_at,'version',relationship.version)
    order by patient.last_name,patient.first_name),'[]'::jsonb) into _rows
  from clinical_core.patient_relationships relationship
  join clinical_core.patient_records patient on patient.id=relationship.patient_record_id
    and patient.organization_id=relationship.organization_id and patient.deleted_at is null
  where relationship.recipient_person_id=_actor and relationship.status='active'
    and relationship.revoked_at is null and relationship.access_expires_at>clock_timestamp();
  return jsonb_build_object('relationships',_rows,'generatedAt',clock_timestamp());
end $$;

create or replace function clinical_core.get_delegated_patient_records(
  _relationship_id uuid,_scope text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _row clinical_core.patient_relationships%rowtype;
  _patient clinical_core.patient_records%rowtype; _items jsonb:='[]'::jsonb; _protocol_id uuid;
begin
  if clinical_private.claim('identity_pool')<>'consumer'
    or clinical_private.claim('purpose')<>'clinical_data'
    or _scope not in ('protocols_supplements','laboratory_results','medical_records') then
    raise exception using errcode='42501',message='delegated_access_refused';
  end if;
  select * into _row from clinical_core.patient_relationships
    where id=_relationship_id and recipient_person_id=_actor and status='active'
      and revoked_at is null and access_expires_at>clock_timestamp()
      and _scope=any(granted_scopes);
  if not found then raise exception using errcode='42501',message='delegated_access_refused'; end if;
  select * into _patient from clinical_core.patient_records
    where id=_row.patient_record_id and organization_id=_row.organization_id and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='patient_not_found'; end if;

  if _scope='protocols_supplements' then
    select protocol.active_version_id into _protocol_id from clinical_core.patient_protocols protocol
      where protocol.organization_id=_row.organization_id
        and protocol.patient_record_id=_row.patient_record_id
        and protocol.status='active' and protocol.deleted_at is null;
    if _protocol_id is not null then
      select jsonb_build_array(jsonb_build_object(
        'kind','active_protocol','id',version.id,'title',version.title,'summary',version.summary,
        'dietInstructions',version.diet_instructions,'lifestyleInstructions',version.lifestyle_instructions,
        'monitoringPlan',version.monitoring_plan,'followupPlan',version.followup_plan,
        'approvedAt',version.approved_at,'activatedAt',version.activated_at,
        'items',coalesce((select jsonb_agg(jsonb_build_object(
          'id',item.id,'kind',item.kind,'label',item.label,'instructions',item.instructions,
          'manufacturer',item.manufacturer,'dosageText',item.dosage_text,
          'timingText',item.timing_text,'route',item.route,
          'verificationStatus',item.verification_status)
          order by item.position,item.id) from clinical_core.patient_protocol_items item
          where item.protocol_version_id=version.id),'[]'::jsonb)))
        into _items from clinical_core.patient_protocol_versions version where version.id=_protocol_id;
    end if;
  elsif _scope='laboratory_results' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'kind','lab_result','id',observation.id,'markerName',observation.marker_name,
      'value',observation.value_numeric,'unit',observation.unit,
      'referenceMin',observation.reference_min,'referenceMax',observation.reference_max,
      'observedAt',observation.observed_at,'reviewStatus',observation.review_status,
      'provenance',observation.provenance)
      order by observation.observed_at desc,observation.created_at desc),'[]'::jsonb)
      into _items from (select * from clinical_core.lab_observations
        where organization_id=_row.organization_id and patient_record_id=_row.patient_record_id
          and review_status in ('accepted','flagged')
        order by observed_at desc,created_at desc limit 500) observation;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'kind','signed_clinical_note','id',note.id,'noteType',note.note_type,
      'encounterType',encounter.visit_type,'occurredAt',coalesce(encounter.started_at,encounter.created_at),
      'signedAt',note.signed_at,'content',version.content,
      'contentSha256',signature.content_sha256,
      'addenda',coalesce((select jsonb_agg(jsonb_build_object(
        'id',addendum.id,'reason',addendum.reason,'content',addendum.content,
        'createdAt',addendum.created_at) order by addendum.created_at)
        from clinical_core.note_addenda addendum where addendum.note_id=note.id),'[]'::jsonb))
      order by note.signed_at desc),'[]'::jsonb) into _items
    from clinical_core.clinical_notes note
    join clinical_core.encounters encounter on encounter.id=note.encounter_id
    join clinical_core.note_signatures signature on signature.note_id=note.id
    join clinical_core.clinical_note_versions version
      on version.note_id=note.id and version.version=signature.note_version
    where note.organization_id=_row.organization_id and note.patient_record_id=_row.patient_record_id
      and note.status in ('signed','amended') and note.deleted_at is null
      and encounter.deleted_at is null and encounter.status<>'entered_in_error';
  end if;

  insert into clinical_audit.patient_relationship_events(organization_id,patient_record_id,
    relationship_id,actor_person_id,action,safe_metadata) values(_row.organization_id,
    _row.patient_record_id,_row.id,_actor,'accessed',jsonb_build_object('scope',_scope));
  return jsonb_build_object('relationshipId',_row.id,'patientDisplayName',
    btrim(_patient.first_name||' '||_patient.last_name),'scope',_scope,'readOnly',true,
    'items',coalesce(_items,'[]'::jsonb),'generatedAt',clock_timestamp());
end $$;

create or replace function clinical_core.revoke_my_patient_relationship(
  _relationship_id uuid,_expected_version integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _row clinical_core.patient_relationships%rowtype;
begin
  if clinical_private.claim('identity_pool')<>'consumer'
    or clinical_private.claim('purpose')<>'consent_management' then
    raise exception using errcode='42501',message='consumer_consent_context_required';
  end if;
  select relationship.* into _row from clinical_core.patient_relationships relationship
  left join clinical_core.patient_connections connection
    on connection.organization_id=relationship.organization_id
    and connection.patient_record_id=relationship.patient_record_id
    and connection.consumer_person_id=_actor and connection.state in ('verified','paused')
  where relationship.id=_relationship_id
    and (relationship.recipient_person_id=_actor or connection.id is not null)
    for update of relationship;
  if not found then raise exception using errcode='P0002',message='relationship_not_found'; end if;
  if _row.version<>_expected_version or _row.status in ('revoked','expired') then
    raise exception using errcode='40001',message='relationship_version_conflict'; end if;
  update clinical_core.patient_relationships set status='revoked',revoked_at=clock_timestamp(),
    revoked_by_person_id=_actor,revocation_reason_present=true,granted_scopes='{}',
    version=version+1,updated_at=clock_timestamp() where id=_row.id returning * into _row;
  insert into clinical_audit.patient_relationship_events(organization_id,patient_record_id,
    relationship_id,actor_person_id,action,safe_metadata) values(_row.organization_id,
    _row.patient_record_id,_row.id,_actor,'revoked',jsonb_build_object('source','patient_app'));
  return jsonb_build_object('relationshipId',_row.id,'status','revoked','version',_row.version);
end $$;

revoke all on function clinical_core.list_my_patient_relationship_requests() from public;
revoke all on function clinical_core.approve_patient_relationship(uuid,integer,text[],text) from public;
revoke all on function clinical_core.claim_patient_relationship_invitation(text,text) from public;
revoke all on function clinical_core.list_my_delegated_patient_access() from public;
revoke all on function clinical_core.get_delegated_patient_records(uuid,text) from public;
revoke all on function clinical_core.revoke_my_patient_relationship(uuid,integer) from public;
grant execute on function clinical_core.list_my_patient_relationship_requests(),
  clinical_core.approve_patient_relationship(uuid,integer,text[],text),
  clinical_core.claim_patient_relationship_invitation(text,text),
  clinical_core.list_my_delegated_patient_access(),
  clinical_core.get_delegated_patient_records(uuid,text),
  clinical_core.revoke_my_patient_relationship(uuid,integer)
  to clinical_core_api;

