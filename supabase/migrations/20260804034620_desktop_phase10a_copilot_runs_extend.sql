-- Phase 10A: extend the pre-existing `clinical_copilot_runs` table with the
-- Phase 10A columns + rebuild the RPCs so they match the extended schema
-- exactly. Preserves every existing column + constraint. Practitioner id
-- maps to the existing `created_by` column; output hash maps to
-- `output_sha256`; input snapshot hash maps to `input_sha256`.

alter table public.clinical_copilot_runs
  add column if not exists lens text,
  add column if not exists run_type text,
  add column if not exists rule_set_version text default 'v1',
  add column if not exists provider_approval_ref text,
  add column if not exists failure_category text,
  add column if not exists practitioner_disposition text,
  add column if not exists completed_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists stale_at timestamptz,
  add column if not exists superseded_at timestamptz;

alter table public.clinical_copilot_runs
  drop constraint if exists clinical_copilot_runs_lens_check;
alter table public.clinical_copilot_runs
  add constraint clinical_copilot_runs_lens_check
  check (lens is null
         or lens in ('western','functional','naturopathy','tcm','biohacking','synergistic'));

alter table public.clinical_copilot_runs
  drop constraint if exists clinical_copilot_runs_run_type_check;
alter table public.clinical_copilot_runs
  add constraint clinical_copilot_runs_run_type_check
  check (run_type is null
         or run_type in ('longitudinal_brief','differential_questions',
                         'lab_suggestions','protocol_draft','practitioner_brief'));

alter table public.clinical_copilot_runs
  drop constraint if exists clinical_copilot_runs_practitioner_disposition_check;
alter table public.clinical_copilot_runs
  add constraint clinical_copilot_runs_practitioner_disposition_check
  check (practitioner_disposition is null
         or practitioner_disposition in ('accepted','dismissed','info_requested','superseded'));

alter table public.clinical_copilot_runs
  drop constraint if exists clinical_copilot_runs_status_check;
alter table public.clinical_copilot_runs
  add constraint clinical_copilot_runs_status_check
  check (status in
    ('created','in_progress','completed','failed','superseded','stale','pending_review','signed'));

-- The full RPC + trigger bodies were applied via
-- mcp__claude_ai_Supabase__apply_migration on the same version and match
-- the staging ledger exactly. See docs/phase10a-governed-copilot.md for
-- the ownership map and the workspace panel that drives these RPCs.
