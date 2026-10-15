-- Rollback for the UNREGISTERED workforce-membership-fence-guard.sql candidate. It removes the guard and its helpers
-- and nothing else: no membership, identity, person or clinic row is changed. After it runs, an unacknowledged
-- authority-reducing change commits again, so telehealth writes under `database_current` must be disabled first
-- (remove the telehealth `membershipFenceTable` setting), never left running against an unguarded database.

drop trigger organizations_membership_fence on clinical_core.organizations;
drop trigger persons_membership_fence on clinical_core.persons;
drop trigger identities_membership_fence on clinical_core.identities;
drop trigger organization_memberships_membership_fence on clinical_core.organization_memberships;
drop function clinical_private.membership_fence_subjects(uuid);
drop function clinical_private.require_membership_fence();
drop function clinical_private.membership_fence_acknowledged(text);
