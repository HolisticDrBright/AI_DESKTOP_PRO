-- Rollback for the UNREGISTERED, BLOCKED workforce-new-clinic-bootstrap candidate. Applied nowhere.
--
-- Removes the three doors (bootstrap, the applicant's read, the operator's suspension) and the access helper, so no
-- new clinic can be bootstrapped and no suspension can be recorded through this path. It keeps every recorded row:
-- the release row, the bootstraps and their append-only events stay, inert and without grants. Clinics already
-- bootstrapped keep their state (an active owner stays active, a suspended clinic stays suspended); rolling back the
-- door is not a decision about the clinics that came through it.

drop function clinical_private.suspend_bootstrapped_workforce_clinic(uuid,text,text);
drop function clinical_private.workforce_clinic_bootstrap_for_subject(text);
drop function clinical_private.bootstrap_workforce_clinic(uuid,text,text,text,text);
drop function clinical_private.workforce_clinic_bootstrap_access(clinical_private.workforce_clinic_bootstraps);
update clinical_private.workforce_clinic_bootstrap_release set enabled=false,changed_at=clock_timestamp() where singleton;
