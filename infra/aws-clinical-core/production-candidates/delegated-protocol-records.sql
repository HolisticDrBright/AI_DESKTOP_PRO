-- delegated-protocol-records/2 — unreleased, preserving source candidate.
-- No historical migration or release row is changed. Do not apply until its
-- parent artifact, rollback, reduced-role tests and caregiver policy are reviewed.
-- A caregiver receives only an active, practitioner-approved clinic protocol's
-- individually reviewed, governed non-peptide supplement instructions. The
-- owned/AI lab-derived plan is a different record family and is never queried.
-- Held items are counted, never serialized (including title/summary/free text).
create or replace function clinical_core.get_delegated_patient_records(
  _relationship_id uuid, _scope text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  _actor uuid := clinical_private.actor_person_id();
  _row clinical_core.patient_relationships%rowtype;
  _patient clinical_core.patient_records%rowtype;
  _items jsonb := '[]'::jsonb;
  _protocol_id uuid;
begin
  if clinical_private.claim('identity_pool') <> 'consumer'
    or clinical_private.claim('purpose') <> 'clinical_data'
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
        'kind','active_protocol','id',version.id,
        'title','Practitioner-approved supplement instructions',
        'summary',null,'approvalSource','clinic_practitioner',
        'approvedAt',version.approved_at,'activatedAt',version.activated_at,
        'heldItems',(select count(*) from clinical_core.patient_protocol_items all_items
          where all_items.protocol_version_id=version.id) -
          (select count(*) from clinical_core.patient_protocol_items safe_item
            join clinical_reference.catalog_products product
              on product.stable_id=safe_item.catalog_product_stable_id
            join clinical_reference.catalog_product_versions catalog_version
              on catalog_version.product_stable_id=product.stable_id
                and catalog_version.version=safe_item.catalog_product_version
            where safe_item.protocol_version_id=version.id and safe_item.kind='product'
              and safe_item.interaction_review_state='reviewed_by_practitioner'
              and safe_item.verification_status in ('label_verified','structured_verified')
              and product.review_status='approved' and product.active_version=catalog_version.version
              and catalog_version.review_status='approved'
              and catalog_version.product_type='supplement'
              and catalog_version.access_tier in ('open','practitioner_gated')
              and not catalog_version.declared_restricted
              and exists (select 1 from clinical_reference.product_label_verifications verification
                where verification.product_version_id=catalog_version.id)),
        'items',coalesce((select jsonb_agg(jsonb_build_object(
          'id',item.id,'kind','product',
          'label',regexp_replace(item.label,'(https?://|www[.])[^[:space:]]+','[link not shown]','gi'),
          'instructions',regexp_replace(item.instructions,'(https?://|www[.])[^[:space:]]+','[link not shown]','gi'),
          'dosageText',regexp_replace(item.dosage_text,'(https?://|www[.])[^[:space:]]+','[link not shown]','gi'),
          'timingText',regexp_replace(item.timing_text,'(https?://|www[.])[^[:space:]]+','[link not shown]','gi'),
          'verificationStatus',item.verification_status,
          'sourceProductType','supplement','practitionerApproved',true) order by item.position,item.id)
          from clinical_core.patient_protocol_items item
          join clinical_reference.catalog_products product
            on product.stable_id=item.catalog_product_stable_id
          join clinical_reference.catalog_product_versions catalog_version
            on catalog_version.product_stable_id=product.stable_id
              and catalog_version.version=item.catalog_product_version
          where item.protocol_version_id=version.id and item.kind='product'
            and item.interaction_review_state='reviewed_by_practitioner'
            and item.verification_status in ('label_verified','structured_verified')
            and product.review_status='approved' and product.active_version=catalog_version.version
            and catalog_version.review_status='approved'
            and catalog_version.product_type='supplement'
            and catalog_version.access_tier in ('open','practitioner_gated')
            and not catalog_version.declared_restricted
            and exists (select 1 from clinical_reference.product_label_verifications verification
              where verification.product_version_id=catalog_version.id)),'[]'::jsonb)))
        into _items from clinical_core.patient_protocol_versions version
        where version.id=_protocol_id and version.protocol_id in (
          select protocol.id from clinical_core.patient_protocols protocol
            where protocol.organization_id=_row.organization_id
              and protocol.patient_record_id=_row.patient_record_id
              and protocol.active_version_id=version.id and protocol.status='active'
              and protocol.deleted_at is null)
          and version.status='active' and version.approved_by_person_id is not null
          and version.approved_at is not null and version.activated_by_person_id is not null
          and version.activated_at is not null;
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

revoke all on function clinical_core.get_delegated_patient_records(uuid,text) from public;
grant execute on function clinical_core.get_delegated_patient_records(uuid,text) to clinical_core_api;
