-- Ask ALP is available to an authenticated consumer before a clinic is linked.
-- An unlinked account receives a truthful empty snapshot; no clinical values are
-- inferred, copied from another tenant, or supplied as hidden defaults.

alter function clinical_core.get_patient_chat_context()
  rename to get_patient_chat_context_before_independent_consumer;

create or replace function clinical_core.get_patient_chat_context()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.assert_synthetic_context(
    clinical_private.organization_id(),'clinical_data','consumer');

  if not exists (
    select 1 from clinical_core.patient_connections connection
    where connection.organization_id=clinical_private.organization_id()
      and connection.consumer_person_id=clinical_private.actor_person_id()
      and connection.state in ('verified','paused')
  ) then
    return jsonb_build_object(
      'profile',null,
      'cycle',null,
      'wearables',null,
      'labs','[]'::jsonb,
      'protocol',null,
      'tcm',null,
      'conversationMemory',null,
      'promotedPatterns','[]'::jsonb,
      'careTeam',null,
      'recentReports','[]'::jsonb,
      'governedOptions','[]'::jsonb
    );
  end if;

  return clinical_core.get_patient_chat_context_before_independent_consumer();
end $$;

revoke all on function clinical_core.get_patient_chat_context() from public;
grant execute on function clinical_core.get_patient_chat_context() to clinical_core_api;
