-- No consent release or activation is seeded. Keep consent-management routes
-- restricted; clinical-data callers get a boolean, never the consent history.
create function clinical_core.owned_reproductive_context_allowed()
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor();
begin
  if clinical_private.claim('purpose') is distinct from 'clinical_data' then
    raise exception using errcode='22023',message='owned_record_request_invalid';
  end if;
  -- Identical lock namespace to writes and set_owned_consumer_consent. The
  -- consent query is a separate statement after acquiring the lock, so under
  -- READ COMMITTED it sees a withdrawal committed while waiting for the lock.
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  return clinical_private.owned_consumer_consent(_actor,'reproductive_health') is not null;
end $$;
revoke all on function clinical_core.owned_reproductive_context_allowed() from public;
grant execute on function clinical_core.owned_reproductive_context_allowed() to clinical_core_api;

create function clinical_private.guard_owned_reproductive_context()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.collection='lab_observations' and not new.deleted and exists (
    select 1 from unnest(array['pregnancyStatus','cyclePhase','reproductiveStage','contraception','pregnancyTrimester']) k
    where new.payload->'collectionContext'->k is not null
      and new.payload->'collectionContext'->k <> 'null'::jsonb
  ) then
    if new.owner_id is distinct from clinical_private.owned_consumer_actor()
      or not clinical_core.owned_reproductive_context_allowed() then
      raise exception using errcode='42501',message='consumer_storage_consent_required';
    end if;
  end if;
  return new;
end $$;
revoke all on function clinical_private.guard_owned_reproductive_context() from public;
create trigger owned_reproductive_context_guard before insert on clinical_core.owned_consumer_record_versions
  for each row execute function clinical_private.guard_owned_reproductive_context();
