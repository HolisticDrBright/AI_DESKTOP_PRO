-- Read-only connection posture for the Cognito-authenticated consumer App.

create or replace function clinical_core.get_consumer_connection()
returns table(connection_id uuid, patient_record_id uuid, state text,
  verified_at timestamptz, lab_results_import_consent text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform clinical_private.assert_synthetic_context(
    clinical_private.organization_id(), 'clinical_data', 'consumer');
  return query
    select c.id, c.patient_record_id, c.state, c.verified_at,
      coalesce((select cc.status from clinical_core.current_consent cc
        where cc.connection_id = c.id and cc.scope = 'lab_results_import'), 'not_granted')
    from clinical_core.patient_connections c
    where c.organization_id = clinical_private.organization_id()
      and c.consumer_person_id = clinical_private.actor_person_id()
      and c.state in ('verified','paused')
    order by c.verified_at desc limit 1;
end
$$;

grant execute on function clinical_core.get_consumer_connection() to clinical_core_api;
revoke all on function clinical_core.get_consumer_connection() from public;
