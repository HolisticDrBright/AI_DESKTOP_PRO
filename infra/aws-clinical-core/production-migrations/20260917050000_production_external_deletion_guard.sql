-- Guard one external lab cleanup operation in a transaction held open by the
-- caller. No arbitrary owner argument, consent grant, hold release or activation.
create function clinical_core.guard_owned_external_deletion()
returns uuid language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor();
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' then
    raise exception using errcode='42501',message='consumer_owner_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  -- Recheck after the owner lock and pin the active identity/person while the
  -- external operation is in progress. Same owner lock as legal-hold placement.
  perform 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
    where i.person_id=_actor and i.identity_pool='consumer'
      and i.identity_subject=clinical_private.claim('identity_subject')
      and i.production_bound=true and i.status='active' and p.status='active'
    for share of i,p;
  if not found then raise exception using errcode='42501',message='consumer_owner_required'; end if;
  if exists(select 1 from clinical_private.owned_legal_holds where owner_id=_actor and released_at is null) then
    raise exception using errcode='42501',message='owned_record_legal_hold';
  end if;
  return _actor;
end $$;
revoke all on function clinical_core.guard_owned_external_deletion() from public;
grant execute on function clinical_core.guard_owned_external_deletion() to clinical_core_api;
