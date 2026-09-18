-- Prevent a later save from repopulating personal storage during/after account
-- deletion. This is not erasure authority and never touches device/clinic data.
-- Submission, fulfillment and these guards use the same owner transaction lock.
-- Refused deletion requests and correction requests do not fence the account.
create index owned_deletion_write_fence on clinical_private.owned_privacy_requests(owner_id)
  where kind='deletion' and status<>'refused';

create function clinical_private.assert_owned_storage_writable(_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if _owner is null then raise exception using errcode='42501',message='consumer_owner_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(_owner::text,0));
  if exists(select 1 from clinical_private.owned_privacy_requests
      where owner_id=_owner and kind='deletion' and status<>'refused') then
    raise exception using errcode='42501',message='owned_account_deletion_write_blocked';
  end if;
end $$;

create function clinical_private.guard_owned_deletion_record_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- Tombstones remain available subject to existing consent, hold and revision
  -- checks. Historical idempotent replays perform no insert and remain receipts.
  if not new.deleted then perform clinical_private.assert_owned_storage_writable(new.owner_id); end if;
  return new;
end $$;
create trigger owned_deletion_record_write before insert on clinical_core.owned_consumer_record_versions
  for each row execute function clinical_private.guard_owned_deletion_record_write();

create function clinical_private.guard_owned_deletion_consent_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- Withdrawal must remain possible. A new grant must not reopen purged storage.
  if new.status='granted' then perform clinical_private.assert_owned_storage_writable(new.owner_id); end if;
  return new;
end $$;
create trigger owned_deletion_consent_write before insert on clinical_core.consumer_storage_consents
  for each row execute function clinical_private.guard_owned_deletion_consent_write();

create function clinical_private.guard_owned_deletion_plan_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform clinical_private.assert_owned_storage_writable(new.owner_id);
  return new;
end $$;
create trigger owned_deletion_plan_write before insert or update on clinical_core.owned_consumer_active_plans
  for each row execute function clinical_private.guard_owned_deletion_plan_write();

revoke all on function clinical_private.assert_owned_storage_writable(uuid),
  clinical_private.guard_owned_deletion_record_write(),clinical_private.guard_owned_deletion_consent_write(),
  clinical_private.guard_owned_deletion_plan_write() from public,clinical_core_api;
