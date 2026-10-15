-- Rollback for the UNREGISTERED, BLOCKED workforce-onboarding-approval-authority candidate. BLOCKED: run only where
-- that candidate was applied, after its parents. It restores the parents' behaviour exactly: the applicant status read
-- and activate_my_memberships to their parent bodies, EXECUTE on the parent review functions, and removes the five
-- reasoned functions and the (empty) activation-hold table.
--
-- Preserving: every decision already recorded stays. The reason columns, the revocation ledger and the operator
-- registry are kept as inert structures with no grants; nothing that was written under the successor is deleted.
--
-- It refuses while any clinic proposal approved under the successor is still held. The parent's
-- activate_my_memberships does not know about holds, so rolling back over a held owner membership would let its holder
-- activate it, which is exactly what the hold exists to prevent. Decide those clinics first.

do $$
begin
  if exists (select 1 from clinical_private.workforce_clinic_activation_holds) then
    raise exception using errcode='55000',message='workforce_rollback_refused_held_clinics';
  end if;
end $$;

revoke all on function clinical_core.list_workforce_join_requests() from clinical_core_api;
revoke all on function clinical_core.review_workforce_join_request_v2(uuid,boolean,text,text) from clinical_core_api;
revoke all on function clinical_private.review_workforce_clinic_proposal_v2(uuid,boolean,text,text) from clinical_workforce_operator;
drop function clinical_core.list_workforce_join_requests();
drop function clinical_core.review_workforce_join_request_v2(uuid,boolean,text,text);
drop function clinical_private.review_workforce_clinic_proposal_v2(uuid,boolean,text,text);
revoke all on function clinical_core.revoke_workforce_membership(uuid,text) from clinical_core_api;
drop function clinical_core.revoke_workforce_membership(uuid,text);
revoke all on function clinical_private.list_workforce_clinic_proposals(text) from clinical_workforce_operator;
drop function clinical_private.list_workforce_clinic_proposals(text);
grant execute on function clinical_core.review_workforce_join_request(uuid,boolean) to clinical_core_api;
grant execute on function clinical_private.review_workforce_clinic_proposal(uuid,boolean,text) to clinical_workforce_operator;

create or replace function clinical_core.activate_my_memberships()
returns integer
language plpgsql security definer set search_path = '' as $$
declare _activated integer;
begin
  perform clinical_private.assert_production_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );
  update clinical_core.organization_memberships membership
  set status = 'active'
  where membership.organization_id = clinical_private.organization_id()
    and membership.person_id = clinical_private.actor_person_id()
    and membership.status = 'pending';
  get diagnostics _activated = row_count;
  if _activated > 0 then
    insert into clinical_audit.events(
      organization_id, actor_person_id, action, resource_type, purpose,
      safe_metadata
    ) values (
      clinical_private.organization_id(), clinical_private.actor_person_id(),
      'membership.role_changed', 'organization_membership', 'clinical_data',
      jsonb_build_object('event','activated','count',_activated)
    );
  end if;
  return _activated;
end
$$;

create or replace function clinical_private.workforce_access_status_for_subject(_subject text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if _subject is null or _subject !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    raise exception using errcode='22023',message='workforce_subject_invalid';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'kind',r.kind,'status',r.status,'createdAt',r.created_at,
      'organizationId',coalesce(r.approved_organization_id,r.requested_organization_id))
      order by r.created_at desc,r.id)
    from (select * from clinical_private.workforce_access_requests
      where identity_subject=_subject order by created_at desc,id limit 50) r),'[]'::jsonb);
end $$;

drop table clinical_private.workforce_clinic_activation_holds;
