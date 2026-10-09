-- Owner-bound recovery after a lost request response, app restart or device change.
-- Existing owner/created_at/id index supports this bounded backwards lookup.
-- No packaging, object-store access, new export, policy approval or seeded data.
alter table clinical_audit.owned_privacy_export_events drop constraint owned_privacy_export_events_action_check;
alter table clinical_audit.owned_privacy_export_events add constraint owned_privacy_export_events_action_check
  check(action in ('created','records.read','consents.read','job.requested','job.pass','job.completed','job.failed','job.cancelled','job.expired','download.issued','object.deleted',
    'cleanup.deferred','object.reconciled','object.reappeared','retention.sweep','job.recovered'));

create function clinical_core.find_latest_owned_privacy_export_job() returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _id uuid; _view jsonb; _export uuid;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select id,export_id into _id,_export from clinical_private.owned_privacy_export_jobs
    where owner_id=_actor order by created_at desc,id desc limit 1;
  if not found then return null; end if;
  -- Reuse the owner check and committed deadline transition, not a stale row view.
  _view:=clinical_core.get_owned_privacy_export_job(_id);
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count)
    values(_actor,_export,'job.recovered',0);
  return _view;
end $$;
revoke all on function clinical_core.find_latest_owned_privacy_export_job() from public;
grant execute on function clinical_core.find_latest_owned_privacy_export_job() to clinical_core_api;
