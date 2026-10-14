-- Rollback for production-program-consumer-boundary.sql (program-consumer-boundary/1). BLOCKED like its forward
-- file: applied nowhere, run only by the operator who applied the forward file, in the same reviewed change window.
--
-- Order matters. Removing the boundary gives the API role the parent's unredacted request function back, so the
-- program family is switched OFF first, in the same transaction: a rollback never leaves an enabled family that
-- can return a purchase destination. Re-enabling the family afterwards without the boundary would reintroduce the
-- leak this boundary closes; that is a separate, reviewed decision, not part of a rollback.
--
-- Nothing stored changes: program content, assignments, completions and audit rows written while the boundary was
-- active stay exactly as they are (completions are the parent's own rows).
--
-- Checks after running it (the return document lists them, and a database test runs them):
--   * clinical_core.production_program_activation.enabled is false;
--   * clinical_core_api cannot execute clinical_core.production_program_bounded_request(jsonb) (it no longer exists);
--   * clinical_core_api can execute clinical_core.production_program_assignment_request(jsonb) again, and it refuses
--     with production_program_disabled;
--   * clinical_core.program_consumer_boundary_activation and both private functions no longer exist;
--   * program_versions, program_assignments and program_assignment_completions are row-for-row unchanged.

update clinical_core.production_program_activation set enabled=false,updated_at=clock_timestamp() where singleton;
revoke execute on function clinical_core.production_program_bounded_request(jsonb) from clinical_core_api;
grant execute on function clinical_core.production_program_assignment_request(jsonb) to clinical_core_api;
drop function clinical_core.production_program_bounded_request(jsonb);
drop function clinical_private.production_program_bounded_complete(jsonb);
drop function clinical_private.production_program_without_destinations(jsonb);
drop table clinical_core.program_consumer_boundary_activation;
