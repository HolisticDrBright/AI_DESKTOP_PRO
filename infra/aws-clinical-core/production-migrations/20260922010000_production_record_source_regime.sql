-- Per-record provenance, set at ingestion and never by later inference.
--
-- The two populations are governed by different regimes: records a consumer enters for themselves, and records a clinic's
-- patient generates under that clinic's authority. Until now the separation was structural (different tables, different
-- identity pools, different APIs) and therefore true but not *provable* from a row. A reviewer asking "which records are
-- consumer records, and can you show none of a clinic's protected information ever landed here" had to be answered by
-- argument about table names rather than by reading the data.
--
-- This adds the marker to the owner-scoped consumer store and makes the answer structural:
--   * every version carries source_regime, written by the ingestion path, never inferred afterwards;
--   * the only value this table accepts is 'consumer_self_entered', so a clinic-regime row cannot exist here at all;
--   * the regime cannot change between revisions of the same record, so a later write cannot reclassify history.
-- The clinic side keeps its own separation: those rows live in organization-scoped tables under workforce identity and are
-- unreachable from the consumer actor. Nothing here moves data, changes any existing value, or enables anything.
alter table clinical_core.owned_consumer_record_versions
  add column source_regime text not null default 'consumer_self_entered'
    check (source_regime in ('consumer_self_entered'));

comment on column clinical_core.owned_consumer_record_versions.source_regime is
  'Provenance regime fixed at ingestion. This store admits consumer self-entered records only; clinic-authority records live in organization-scoped tables.';

create function clinical_private.owned_record_regime_is_immutable()
returns trigger language plpgsql set search_path='' as $$
declare _previous text;
begin
  -- A new revision inherits the record's regime; it may never restate it differently. Reclassification after the fact is
  -- exactly the inference this column exists to rule out.
  select source_regime into _previous from clinical_core.owned_consumer_record_versions
    where owner_id=new.owner_id and collection=new.collection and record_id=new.record_id
    order by revision desc limit 1;
  if _previous is not null and _previous is distinct from new.source_regime then
    raise exception using errcode='22023',message='owned_record_regime_immutable';
  end if;
  return new;
end $$;

create trigger owned_record_regime_immutable
  before insert on clinical_core.owned_consumer_record_versions
  for each row execute function clinical_private.owned_record_regime_is_immutable();

-- An existing version row is never rewritten (the store is append-only by revision); say so at the table as well, so a
-- direct update cannot quietly change a stored regime.
create function clinical_private.owned_record_regime_is_append_only()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.source_regime is distinct from old.source_regime then
    raise exception using errcode='22023',message='owned_record_regime_immutable';
  end if;
  return new;
end $$;

create trigger owned_record_regime_append_only
  before update on clinical_core.owned_consumer_record_versions
  for each row execute function clinical_private.owned_record_regime_is_append_only();

-- The writer states the regime explicitly rather than relying on the column default, so the ingestion path is the place
-- provenance is decided and that fact is visible in the function body.
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
    return jsonb_build_object('recordId',_previous.record_id,'revision',_previous.revision,'duplicate',true,'receivedAt',_previous.received_at,'sourceRegime',_previous.source_regime);
  end if;
  select max(revision) into _current from clinical_core.owned_consumer_record_versions
    where owner_id=_actor and collection=_collection and record_id=_record_id;
  if coalesce(_current,0)<>_expected_revision then
    raise exception using errcode='40001',message='owned_record_revision_conflict';
  end if;
  insert into clinical_core.owned_consumer_record_versions
    (owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision,source_regime)
    values(_actor,_collection,_record_id,coalesce(_current,0)+1,_request_id,_hash,_payload,_deleted,_consent_revision,'consumer_self_entered')
    returning * into _saved;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope,collection,record_id,revision)
    values(_actor,case when _deleted then 'record.deleted' else 'record.written' end,_scope,_collection,_record_id,_saved.revision);
  return jsonb_build_object('recordId',_saved.record_id,'revision',_saved.revision,'duplicate',false,'receivedAt',_saved.received_at,'sourceRegime',_saved.source_regime);
end $$;
