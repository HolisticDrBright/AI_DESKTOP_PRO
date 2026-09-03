-- Preserve transferred laboratory intervals in the Desktop patient read model.
-- Functional ranges stay null unless a future governed, provenance-bearing
-- import contract supplies them. This migration enables no PHI and creates no rows.

alter function clinical_core.get_patient_app_intake(uuid,uuid)
  rename to get_patient_app_intake_base_v1;

revoke all on function clinical_core.get_patient_app_intake_base_v1(uuid,uuid) from public;

create or replace function clinical_core.get_patient_app_intake(
  _organization_id uuid, _patient_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  _base jsonb;
  _connection_id uuid;
  _lab_imports jsonb;
begin
  -- The base function remains authoritative for organization, role, patient,
  -- environment, and consent checks.
  _base := clinical_core.get_patient_app_intake_base_v1(_organization_id, _patient_id);

  select c.id into _connection_id
  from clinical_core.patient_connections c
  where c.organization_id = _organization_id
    and c.patient_record_id = _patient_id
    and c.state in ('verified','paused','revoked')
  order by c.updated_at desc, c.id desc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'eventId', e.id,
    'panelName', e.panel_name,
    'markerName', e.marker_name,
    'value', e.value_numeric,
    'unit', e.unit,
    'sourceStatus', e.source_status,
    'referenceMin', e.reference_min,
    'referenceMax', e.reference_max,
    'functionalMin', null,
    'functionalMax', null,
    'functionalSourceVersion', null,
    'functionalPopulation', null,
    'collectedAt', e.collected_at,
    'state', e.state,
    'receivedAt', e.received_at)
    order by e.collected_at desc, e.marker_name), '[]'::jsonb)
  into _lab_imports
  from clinical_core.lab_import_events e
  where e.connection_id = _connection_id;

  return jsonb_set(_base, '{labImports}', _lab_imports, true);
end
$$;

revoke all on function clinical_core.get_patient_app_intake(uuid,uuid) from public;
grant execute on function clinical_core.get_patient_app_intake(uuid,uuid) to clinical_core_api;
