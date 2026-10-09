-- Per-record removal must not bypass the same hold used by account deletion.
-- History remains append-only; no held records or approvals are changed.
create function clinical_private.guard_owned_record_deletion_hold()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.deleted then
    -- Same owner-lock namespace as record writes and hold placement/release.
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text,0));
    if exists(select 1 from clinical_private.owned_legal_holds
      where owner_id=new.owner_id and released_at is null) then
      raise exception using errcode='42501',message='owned_record_legal_hold';
    end if;
  end if;
  return new;
end $$;
revoke all on function clinical_private.guard_owned_record_deletion_hold() from public;
create trigger owned_record_deletion_hold_guard before insert on clinical_core.owned_consumer_record_versions
  for each row execute function clinical_private.guard_owned_record_deletion_hold();
