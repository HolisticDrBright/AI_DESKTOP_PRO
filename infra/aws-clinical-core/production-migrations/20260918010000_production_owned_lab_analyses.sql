-- Durable owner copies of completed lab analyses (original phase 2 cloud
-- publication). Same owner lock, consent, revision, hold, deletion-fence and
-- audit guards as every other personal record. No clinic collection, consent
-- release, approval or plan adoption is created.
alter table clinical_core.owned_consumer_record_versions drop constraint owned_consumer_record_versions_collection_check;
alter table clinical_core.owned_consumer_record_versions add constraint owned_consumer_record_versions_collection_check check(collection in (
  'protocols','daily_adherence','symptom_logs','hormone_entries','meal_logs','subjective_rollups','weekly_checkins',
  'wellness_profiles','lifestyle_profiles','contraindications','questionnaire_responses','clinical_intakes',
  'wearable_daily_records','reproductive_profiles','adverse_event_reports','lab_observations','diet_preferences','lab_analyses'));

-- A whole completed result needs more than the ordinary 16 KiB personal record
-- budget; every other collection keeps the original limit.
do $$ declare c record; begin
  for c in select conname from pg_constraint
    where conrelid='clinical_core.owned_consumer_record_versions'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%octet_length(%' loop
    execute format('alter table clinical_core.owned_consumer_record_versions drop constraint %I',c.conname);
  end loop;
end $$;
alter table clinical_core.owned_consumer_record_versions add constraint owned_consumer_record_versions_payload_check
  check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=case when collection='lab_analyses' then 262144 else 16384 end);

create or replace function clinical_private.consumer_collection_scope(_collection text)
returns text language sql immutable set search_path='' as $$
  select case _collection when 'protocols' then 'protocols_supplements'
    when 'daily_adherence' then 'symptoms_adherence' when 'symptom_logs' then 'symptoms_adherence'
    when 'adverse_event_reports' then 'symptoms_adherence'
    when 'hormone_entries' then 'reproductive_health' when 'reproductive_profiles' then 'reproductive_health'
    when 'meal_logs' then 'nutrition' when 'diet_preferences' then 'nutrition'
    when 'subjective_rollups' then 'symptoms_adherence'
    when 'weekly_checkins' then 'forms_checkins' when 'wellness_profiles' then 'forms_checkins'
    when 'lifestyle_profiles' then 'forms_checkins' when 'contraindications' then 'forms_checkins'
    when 'questionnaire_responses' then 'forms_checkins' when 'clinical_intakes' then 'forms_checkins'
    when 'wearable_daily_records' then 'wearables' when 'lab_observations' then 'lab_history'
    when 'lab_analyses' then 'lab_history' else null end
$$;

create or replace function clinical_core.write_owned_consumer_record(
  _collection text,_record_id uuid,_expected_revision integer,_request_id uuid,
  _payload jsonb,_deleted boolean,_consent_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _scope text; _current integer;
  _hash text; _previous clinical_core.owned_consumer_record_versions; _saved clinical_core.owned_consumer_record_versions;
  _limit integer:=case when _collection='lab_analyses' then 262144 else 16384 end;
begin
  _scope:=clinical_private.consumer_collection_scope(_collection);
  if clinical_private.claim('purpose') is distinct from 'clinical_data'
    or _scope is null or _record_id is null or _request_id is null or _deleted is null
    or _expected_revision is null or _expected_revision<0 or _consent_revision is null
    or _payload is null or jsonb_typeof(_payload)<>'object' or octet_length(_payload::text)>_limit
    or (_deleted and _payload<>'{}'::jsonb) then
    raise exception using errcode='22023',message='owned_record_request_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  if clinical_private.owned_consumer_consent(_actor,_scope) is distinct from _consent_revision then
    raise exception using errcode='42501',message='consumer_storage_consent_required';
  end if;
  _hash:=encode(public.digest(jsonb_build_array(_collection,_record_id,_expected_revision,_payload,_deleted,_consent_revision)::text,'sha256'),'hex');
  select * into _previous from clinical_core.owned_consumer_record_versions where owner_id=_actor and request_id=_request_id;
  if found then
    if _previous.command_sha256<>_hash then
      raise exception using errcode='40001',message='owned_record_idempotency_conflict';
    end if;
    return jsonb_build_object('recordId',_previous.record_id,'revision',_previous.revision,'duplicate',true,'receivedAt',_previous.received_at);
  end if;
  select max(revision) into _current from clinical_core.owned_consumer_record_versions
    where owner_id=_actor and collection=_collection and record_id=_record_id;
  if coalesce(_current,0)<>_expected_revision then
    raise exception using errcode='40001',message='owned_record_revision_conflict';
  end if;
  insert into clinical_core.owned_consumer_record_versions
    (owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision)
    values(_actor,_collection,_record_id,coalesce(_current,0)+1,_request_id,_hash,_payload,_deleted,_consent_revision)
    returning * into _saved;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope,collection,record_id,revision)
    values(_actor,case when _deleted then 'record.deleted' else 'record.written' end,_scope,_collection,_record_id,_saved.revision);
  return jsonb_build_object('recordId',_saved.record_id,'revision',_saved.revision,'duplicate',false,'receivedAt',_saved.received_at);
end $$;

create function clinical_private.validate_owned_lab_analysis()
returns trigger language plpgsql set search_path='' as $$
declare p jsonb:=new.payload; stamp timestamptz;
begin
  if new.collection<>'lab_analyses' then return new; end if;
  if new.deleted then return new; end if;
  if jsonb_typeof(p) is distinct from 'object'
    or not p ?& array['id','version','jobId','kind','completedAt','resultSha256','sourceStatus','result']
    or p-array['id','version','jobId','kind','completedAt','resultSha256','sourceStatus','result']<>'{}'::jsonb
    or p->>'id' is distinct from new.record_id::text
    or p->>'version' is distinct from 'personal-lab-analysis/1'
    or p->>'sourceStatus' is distinct from 'consumer_lab_analysis_unreviewed'
    or p->>'kind' not in ('documents','saved')
    or p->>'jobId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p->>'resultSha256' !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p->'result') is distinct from 'object'
    or jsonb_typeof(p->'completedAt') is distinct from 'string' then
    raise exception using errcode='22023',message='owned_lab_analysis_invalid';
  end if;
  begin
    if p->>'completedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then raise exception 'invalid_date'; end if;
    stamp:=(p->>'completedAt')::timestamptz;
    if not isfinite(stamp) or stamp>clock_timestamp() then raise exception 'invalid_date'; end if;
  exception when others then
    raise exception using errcode='22023',message='owned_lab_analysis_invalid';
  end;
  return new;
end $$;
revoke all on function clinical_private.validate_owned_lab_analysis() from public,clinical_core_api;
create trigger validate_owned_lab_analysis before insert on clinical_core.owned_consumer_record_versions
  for each row execute function clinical_private.validate_owned_lab_analysis();
