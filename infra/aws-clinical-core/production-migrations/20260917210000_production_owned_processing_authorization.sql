-- Read both processing consents and account closure state under the same owner
-- lock. This is a checkpoint, not a lease spanning an external provider call.
create function clinical_core.get_owned_processing_consent_states(_operation text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _second text;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management'
      or _operation is null or _operation not in ('lab','voice') then
    raise exception using errcode='22023',message='consent_request_invalid';
  end if;
  perform clinical_private.assert_owned_storage_writable(_actor);
  _second:=case _operation when 'lab' then 'lab_history' else 'voice_transcription' end;
  return jsonb_build_object('version','owned-processing-consent/1','ownerId',_actor,'operation',_operation,
    'states',jsonb_build_array(clinical_core.get_owned_storage_consent_state('ai_context'),
      clinical_core.get_owned_storage_consent_state(_second)));
end $$;
revoke all on function clinical_core.get_owned_processing_consent_states(text) from public;
grant execute on function clinical_core.get_owned_processing_consent_states(text) to clinical_core_api;
