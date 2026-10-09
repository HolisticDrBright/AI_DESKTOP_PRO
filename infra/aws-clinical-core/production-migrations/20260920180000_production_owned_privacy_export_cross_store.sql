-- Cross-store export coverage. The server-prepared personal-storage copy may
-- carry two more sections after records and consents: `labs` (the owner's lab
-- processing jobs with their sanitized results and source documents) and
-- `voice` (the owner's chat transcription jobs with their transcripts). Both are
-- read by the export pass from the external stores under the owner's own
-- identity, only where the deployment names those stores; the database only
-- widens the section vocabulary and keeps the order records, consents, labs,
-- voice, done. Progress inside a cross-store section travels in the cursor.
alter table clinical_private.owned_privacy_export_jobs drop constraint owned_privacy_export_jobs_section_check;
alter table clinical_private.owned_privacy_export_jobs add constraint owned_privacy_export_jobs_section_check
  check (section in ('records','consents','labs','voice','done'));

create or replace function clinical_core.record_owned_privacy_export_pass(_job uuid,_version bigint,_upload_id text,_part_sha256 text,_part_etag text,_part_bytes bigint,
  _staging_version text,_section text,_cursor jsonb,_exported_records bigint,_exported_consents bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
  _order text[]:=array['records','consents','labs','voice','done'];
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _version is null
    or _section is null or _section<>all(_order) and _section is not null and not (_section=any(_order))
    or (_part_sha256 is not null and _part_sha256!~'^[a-f0-9]{64}$') or ((_part_sha256 is null)<>(_part_bytes is null)) or ((_part_sha256 is null)<>(_part_etag is null))
    or (_part_etag is not null and length(_part_etag) not between 1 and 256)
    or (_part_bytes is not null and _part_bytes not between 1 and 5368709120)
    or (_staging_version is not null and (length(_staging_version) not between 1 and 1024 or _staging_version='null'))
    or (_upload_id is not null and length(_upload_id) not between 1 and 1024)
    or _exported_records is null or _exported_records<0 or _exported_consents is null or _exported_consents<0 then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  if not (_section=any(_order)) then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status<>'running' or _j.version<>_version or _j.lease_until is null or _j.lease_until<=clock_timestamp() then
    raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  -- Sections never move backwards and nothing follows done.
  if (_j.upload_id is not null and _upload_id is distinct from _j.upload_id) or (_part_sha256 is not null and _upload_id is null)
    or _exported_records<_j.exported_records or _exported_consents<_j.exported_consents
    or array_position(_order,_section)<array_position(_order,_j.section) or (_j.section='done') then
    raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  -- The lease is released only when this pass has no storage step left; a pass that recorded the last part still completes the upload.
  update clinical_private.owned_privacy_export_jobs set upload_id=coalesce(_upload_id,upload_id),
    parts=parts+case when _part_sha256 is null then 0 else 1 end,
    part_sha256s=case when _part_sha256 is null then part_sha256s else part_sha256s||to_jsonb(_part_sha256) end,
    part_etags=case when _part_etag is null then part_etags else part_etags||to_jsonb(_part_etag) end,
    bytes_written=bytes_written+coalesce(_part_bytes,0),staging_version=_staging_version,section=_section,cursor=_cursor,
    exported_records=_exported_records,exported_consents=_exported_consents,
    lease_until=case when _section='done' then lease_until else null end,version=version+1,updated_at=clock_timestamp()
    where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.pass',0);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;
