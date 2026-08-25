-- Repair the lab-summary projection to use the governed observation timestamp.
-- Additive overlay: no rows, providers, workers, or activation state are changed.

create or replace function clinical_private.build_sync_payload(
  _organization_id uuid,_patient_id uuid,_resource_type text,_resource_id uuid
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _payload jsonb;
begin
  perform clinical_private.require_clinical_patient(_organization_id,_patient_id);
  if _resource_type='protocol_version' then
    if not exists(select 1 from clinical_core.patient_protocol_versions v
      where v.id=_resource_id and v.organization_id=_organization_id and v.patient_record_id=_patient_id
        and v.status in ('approved','active')) then
      raise exception using errcode='55000',message='approved_protocol_version_required'; end if;
    if exists(select 1 from clinical_core.patient_protocol_items i
      where i.protocol_version_id=_resource_id and i.kind='product') then
      raise exception using errcode='55000',message='governed_product_review_required'; end if;
    _payload:=jsonb_build_object('contractVersion','patient-sync/1','resourceType',_resource_type,
      'resourceId',_resource_id,'record',clinical_private.patient_protocol_version_json(_resource_id));
  elsif _resource_type='appointment_summary' then
    select jsonb_build_object('contractVersion','patient-sync/1','resourceType',_resource_type,
      'resourceId',a.id,'record',jsonb_build_object('id',a.id,'type',a.appointment_type,
        'status',a.status,'startsAt',a.starts_at,'endsAt',a.ends_at,'location',a.location,
        'version',a.version)) into _payload from clinical_core.appointments a
      where a.id=_resource_id and a.organization_id=_organization_id
        and a.patient_record_id=_patient_id and a.deleted_at is null;
  elsif _resource_type='lab_summary' and _resource_id=_patient_id then
    select jsonb_build_object('contractVersion','patient-sync/1','resourceType',_resource_type,
      'resourceId',_patient_id,'record',jsonb_build_object('observationCount',count(*),
        'lastObservedAt',max(o.observed_at))) into _payload from clinical_core.lab_observations o
      where o.organization_id=_organization_id and o.patient_record_id=_patient_id;
  else raise exception using errcode='55000',message='resource_not_production_ready';
  end if;
  if _payload is null then raise exception using errcode='P0002',message='sync_resource_not_found'; end if;
  return _payload;
end $$;

