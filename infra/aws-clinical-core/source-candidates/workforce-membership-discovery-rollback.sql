-- Rollback for workforce-membership-discovery.sql (UNREGISTERED; applied nowhere). The candidate creates only this one
-- function and grants it to clinical_core_api. Dropping it removes the grant with it and touches no table, row, policy
-- or other function. It fails if the function is absent, so a rollback cannot be mistaken for one that did nothing.
--
-- Afterwards the discovery route answers 503 and no first clinic can be chosen under `database_current`; a selection
-- already made keeps working, because every clinical request still runs set_current_workforce_context. The legacy
-- claim path is unaffected.

drop function clinical_private.discover_current_workforce_memberships(text);
