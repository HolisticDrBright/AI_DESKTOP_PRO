-- Phase 10A reconciliation — revoke PUBLIC + anon EXECUTE on the copilot
-- functions added in the previous three migrations. They are already refused
-- inside their function bodies (auth.uid() is null raises SQLSTATE 28000),
-- but grant-level defense-in-depth is what the prior Phase 10A functions do
-- (finalize_copilot_run, mark_copilot_run_stale, record_copilot_disposition,
-- get_copilot_runs_for_patient), and the three new read + practitioner-action
-- RPCs and the extended 14-arg create_copilot_run should match that shape.

revoke all on function public.create_copilot_run(
  uuid, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, jsonb
) from public, anon;

revoke all on function public.build_copilot_input_snapshot(uuid, uuid)
  from public, anon;
revoke all on function public.fetch_copilot_governed_retrieval(uuid)
  from public, anon;

revoke all on function public.apply_copilot_run_to_note(uuid, uuid, uuid, jsonb, text)
  from public, anon;
revoke all on function public.apply_copilot_run_to_protocol_draft(uuid, uuid, uuid, text, text)
  from public, anon;
revoke all on function public.create_copilot_review_task(uuid, uuid, text, text, timestamptz)
  from public, anon;

grant execute on function public.create_copilot_run(
  uuid, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, jsonb
) to authenticated, service_role;

grant execute on function public.build_copilot_input_snapshot(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.fetch_copilot_governed_retrieval(uuid)
  to authenticated, service_role;

grant execute on function public.apply_copilot_run_to_note(uuid, uuid, uuid, jsonb, text)
  to authenticated, service_role;
grant execute on function public.apply_copilot_run_to_protocol_draft(uuid, uuid, uuid, text, text)
  to authenticated, service_role;
grant execute on function public.create_copilot_review_task(uuid, uuid, text, text, timestamptz)
  to authenticated, service_role;
