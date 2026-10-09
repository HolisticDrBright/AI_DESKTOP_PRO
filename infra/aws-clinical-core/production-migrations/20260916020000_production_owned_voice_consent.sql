-- Separate voice-processing consent. No approval, grant, identity or PHI activation
-- is seeded. Existing owner checks, RLS, append-only audits and execution grants
-- are preserved; no collection becomes readable with this scope.
alter table clinical_private.consumer_storage_consent_releases
  drop constraint consumer_storage_consent_releases_scope_check;
alter table clinical_private.consumer_storage_consent_releases
  add constraint consumer_storage_consent_releases_scope_check check(scope in (
    'forms_checkins','symptoms_adherence','nutrition','protocols_supplements',
    'wearables','reproductive_health','ai_context','lab_history','voice_transcription'));

create or replace function clinical_core.get_owned_storage_consent_state(_scope text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _release jsonb; _current jsonb; _history jsonb;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management'
    or _scope is null or _scope not in ('forms_checkins','symptoms_adherence','nutrition',
      'protocols_supplements','wearables','reproductive_health','ai_context','lab_history','voice_transcription') then
    raise exception using errcode='22023',message='consent_request_invalid';
  end if;
  select jsonb_build_object('version',version,'content',content,'contentSha256',content_sha256,'approvedAt',approved_at)
    into _release from clinical_private.consumer_storage_consent_releases
    where scope=_scope and retired_at is null and approved_at<=clock_timestamp()
    order by approved_at desc,version desc limit 1;
  select jsonb_build_object('revision',revision,'status',status,'releaseVersion',release_version,'recordedAt',recorded_at)
    into _current from clinical_core.consumer_storage_consents where owner_id=_actor and scope=_scope
    order by revision desc limit 1;
  select coalesce(jsonb_agg(to_jsonb(c) order by c.revision desc),'[]'::jsonb) into _history
    from (select revision,status,release_version as "releaseVersion",recorded_at as "recordedAt"
      from clinical_core.consumer_storage_consents where owner_id=_actor and scope=_scope order by revision desc limit 100) c;
  return jsonb_build_object('scope',_scope,'release',_release,'current',_current,'history',_history,
    'historyLimit',100,'activeRevision',clinical_private.owned_consumer_consent(_actor,_scope));
end $$;
revoke all on function clinical_core.get_owned_storage_consent_state(text) from public;
grant execute on function clinical_core.get_owned_storage_consent_state(text) to clinical_core_api;
