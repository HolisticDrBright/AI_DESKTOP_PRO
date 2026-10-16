-- Rollback for the UNREGISTERED, BLOCKED workforce-bootstrap-operator-listing candidate. Applied nowhere.
--
-- Removes the operator's read of bootstrapped clinics. It wrote nothing, so nothing else changes: every bootstrap, its
-- append-only events and every suspension stay as recorded. Apply it before the bootstrap candidate's own rollback.

drop function clinical_private.list_bootstrapped_workforce_clinics(text);
