-- UNREGISTERED, BLOCKED successor. No database has it, and no live API depends on it.
--
-- The database half of the workforce membership fence (membership-fence/1). A telehealth write admitted under the
-- `database_current` authority is held to the DynamoDB fence item it read before its current-membership check (see
-- src/server/clinical-core/membership-fence.ts). That holds only if every change that REDUCES the authority that check
-- reads moves the fence first. This guard makes the database refuse such a change unless its transaction carries the
-- fence writer's acknowledgement for the right subject or clinic:
--
--   clinical.membership_fence_ack = 'membership-fence/1 <change uuid> subject:<uuid> [clinic:<uuid> ...]'
--
-- Authority-reducing means, for the rows set_current_workforce_context reads:
--   * a membership that is active: deleted, or its status, role, person or clinic changed (a role change in either
--     direction is fenced; only pending -> active and other non-active rows are left alone);
--   * a workforce identity that is active: deleted, or its status, production binding, subject or person changed;
--   * a person who is active: deleted, or their status or PHI flag changed (for each of their workforce identities);
--   * a clinic that is active: deleted, or its status, environment, classification or PHI flag changed.
--
-- The acknowledgement is an attestation by the caller, not proof: PostgreSQL cannot read DynamoDB. What it does
-- guarantee is that a path which never began the fence (an older function, an operator's ad-hoc UPDATE, the deployed
-- add_org_member re-invite that can demote an active member) is refused instead of committing unfenced. A refused
-- change is the fail-closed direction; an operator who must make one first begins the fence for that subject or clinic,
-- then sets the acknowledgement in the same transaction, then settles the fence.
--
-- membership_fence_subjects names the subjects a membership change must fence, for the caller's own clinic only.

create function clinical_private.membership_fence_acknowledged(_target text)
returns boolean language plpgsql stable set search_path='' as $$
declare _parts text[] := string_to_array(coalesce(current_setting('clinical.membership_fence_ack', true), ''), ' ');
begin
  return coalesce(array_length(_parts, 1), 0) >= 3
    and _parts[1] = 'membership-fence/1'
    and _parts[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and _target = any(_parts[3:]);
end $$;

create function clinical_private.require_membership_fence()
returns trigger language plpgsql security definer set search_path='' as $$
declare _subject text;
begin
  if tg_table_name = 'organization_memberships' then
    if old.status = 'active' and (tg_op = 'DELETE' or new.status is distinct from old.status
        or new.role is distinct from old.role or new.person_id is distinct from old.person_id
        or new.organization_id is distinct from old.organization_id) then
      for _subject in select identity.identity_subject from clinical_core.identities identity
          where identity.person_id = old.person_id and identity.identity_pool = 'workforce' loop
        if not clinical_private.membership_fence_acknowledged('subject:' || lower(_subject)) then
          raise exception using errcode = '55000', message = 'membership_fence_required';
        end if;
      end loop;
    end if;
  elsif tg_table_name = 'identities' then
    if old.identity_pool = 'workforce' and old.status = 'active' and (tg_op = 'DELETE'
        or new.status is distinct from old.status or new.production_bound is distinct from old.production_bound
        or new.identity_subject is distinct from old.identity_subject or new.person_id is distinct from old.person_id
        or new.identity_pool is distinct from old.identity_pool)
      and not clinical_private.membership_fence_acknowledged('subject:' || lower(old.identity_subject)) then
      raise exception using errcode = '55000', message = 'membership_fence_required';
    end if;
  elsif tg_table_name = 'persons' then
    if old.status = 'active' and (tg_op = 'DELETE' or new.status is distinct from old.status
        or new.contains_phi is distinct from old.contains_phi) then
      for _subject in select identity.identity_subject from clinical_core.identities identity
          where identity.person_id = old.id and identity.identity_pool = 'workforce' loop
        if not clinical_private.membership_fence_acknowledged('subject:' || lower(_subject)) then
          raise exception using errcode = '55000', message = 'membership_fence_required';
        end if;
      end loop;
    end if;
  elsif tg_table_name = 'organizations' then
    if old.status = 'active' and (tg_op = 'DELETE' or new.status is distinct from old.status
        or new.environment is distinct from old.environment
        or new.data_classification is distinct from old.data_classification
        or new.contains_phi is distinct from old.contains_phi)
      and not clinical_private.membership_fence_acknowledged('clinic:' || old.id::text) then
      raise exception using errcode = '55000', message = 'membership_fence_required';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create function clinical_private.membership_fence_subjects(_membership_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  return coalesce((select jsonb_agg(lower(identity.identity_subject) order by identity.identity_subject)
    from clinical_core.organization_memberships membership
    join clinical_core.identities identity
      on identity.person_id = membership.person_id and identity.identity_pool = 'workforce'
    where membership.id = _membership_id
      and membership.organization_id = clinical_private.organization_id()), '[]'::jsonb);
end $$;

create trigger organization_memberships_membership_fence
  before update or delete on clinical_core.organization_memberships
  for each row execute function clinical_private.require_membership_fence();
create trigger identities_membership_fence
  before update or delete on clinical_core.identities
  for each row execute function clinical_private.require_membership_fence();
create trigger persons_membership_fence
  before update or delete on clinical_core.persons
  for each row execute function clinical_private.require_membership_fence();
create trigger organizations_membership_fence
  before update or delete on clinical_core.organizations
  for each row execute function clinical_private.require_membership_fence();

revoke all on function clinical_private.membership_fence_acknowledged(text) from public;
revoke all on function clinical_private.require_membership_fence() from public;
revoke all on function clinical_private.membership_fence_subjects(uuid) from public;
grant execute on function clinical_private.membership_fence_subjects(uuid) to clinical_core_api;
