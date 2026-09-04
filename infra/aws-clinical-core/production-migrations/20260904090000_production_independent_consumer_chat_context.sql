-- Production counterpart for independent consumer Ask ALP. This does not
-- widen PHI activation: the production workload remains fail-closed until its
-- separately reviewed activation gates pass.

alter function clinical_core.get_patient_chat_context()
  rename to get_patient_chat_context_before_independent_consumer;

create or replace function clinical_core.get_patient_chat_context()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if clinical_private.claim('identity_pool')<>'consumer'
    or clinical_private.claim('purpose')<>'clinical_data' then
    raise exception using errcode='42501',message='consumer_clinical_context_required';
  end if;

  if not exists (
    select 1 from clinical_core.patient_connections connection
    where connection.consumer_person_id=clinical_private.actor_person_id()
      and connection.state='verified'
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
