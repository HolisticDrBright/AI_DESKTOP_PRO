-- UNREGISTERED, BLOCKED source candidate (workforce-identity-emergency-revocation). Applied nowhere, registered in no
-- manifest; no route, role or Lambda depends on it. Even once applied it does nothing until its release row is switched
-- on, with an approval mode, by the table owner; no API or operator role can switch it. Registration, execution and the
-- release are Codex work after Brandon decides the approval mode and the operator roster
-- (docs/clinic-continuity-emergency-revocation-2026-10-16.md).
--
-- Parents, over the 106-migration production artifact, in this order (the platform-operator registry and the
-- clinical_workforce_operator role come from the last):
--   source-candidates/workforce-token-binding-lookup.sql
--   source-candidates/workforce-clinic-approved-onboarding.sql
--   production-candidates/workforce-invitation-role-repair.sql
--   source-candidates/workforce-join-review-uniform-refusal.sql
--   source-candidates/workforce-current-membership-context.sql
--   source-candidates/workforce-onboarding-approval-authority.sql
-- and clinical_private.set_request_context exactly as deployed (prosrc SHA-256
-- 36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea). It therefore cannot follow
-- legacy-claims-clinic-status.sql, whose immediate refusal the owner has ruled out for ordinary suspension, and that
-- candidate cannot follow this one: each refuses the other's definition as its parent.
-- Rollback: workforce-identity-emergency-revocation-rollback.sql (restores the parent's entry, keeps every record and
-- leaves every revoked identity disabled).
--
-- An EMERGENCY revocation of one practitioner's LOGIN, for a suspected compromise. It is not a clinic suspension: no
-- clinic, membership, patient record, consent or audit row is changed or deleted. What it changes is one row:
-- clinical_core.identities.status for the workforce identity, from 'active' to 'disabled', in every clinic at once,
-- because both workforce authorities read that row on every request:
--   * legacy claims: set_request_context, the entry of every legacy workforce request, refuses a disabled identity;
--   * database_current: set_current_workforce_context refuses it.
-- The token the attacker holds may stay cryptographically valid until it expires, and Cognito may be slow or
-- unreachable. Neither matters to the refusal: the database answers it, on the next request, before any operation.
--
-- Ordering. set_request_context below is the parent's definition with one change: a workforce request's identity row is
-- held FOR SHARE until the operation's transaction ends (the current-membership setter already does this). The
-- revocation takes the same row FOR UPDATE. So a revocation waits for every request already admitted to finish, and a
-- request that arrives while a revocation is pending waits for it and then re-reads the committed row and is refused.
-- When the operator's receipt is returned, nothing that login started can still commit.
--
-- Authority. Only the platform operator, signed in separately with MFA, on the clinical_workforce_operator connection,
-- and listed active in the registry no API role can write. Never a practitioner token (that role has no EXECUTE here),
-- and never the operator's own workforce login. The independent second operator is required in both approval modes,
-- and which mode applies is a release decision recorded in the release row, not chosen here:
--   'second_operator_before'   the proposal has no effect until a different active operator approves it;
--   'independent_review_after' the proposal takes effect at once (disabling is the safe direction) and a different
--                              operator must confirm or dispute it afterwards. A dispute never restores the login:
--                              nothing here re-enables an identity. A wrongly revoked practitioner is restored only
--                              through a separately verified replacement credential, never by rebinding the old one.
--
-- The provider side (Cognito AdminDisableUser and AdminUserGlobalSignOut, scoped to the workforce pool) runs after the
-- database commits, outside this file. Each attempt is recorded here, append-only, by its own idempotency key; a failed
-- attempt stays an actionable pending item, never a receipt. No token, credential, email or patient datum is stored.

begin;

do $guard$
declare _fn regprocedure := to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)');
  _p record;
begin
  if _fn is null or to_regclass('clinical_private.workforce_platform_operators') is null
    or to_regclass('clinical_core.workforce_identity_directory') is null
    or not exists (select 1 from pg_roles where rolname = 'clinical_workforce_operator')
    or to_regprocedure('clinical_private.set_current_workforce_context(text,uuid,text)') is null then
    raise exception using errcode = '55000', message = 'emergency_revocation_parent_refused';
  end if;
  select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as body
    into _p from pg_proc p where p.oid = _fn;
  if not _p.prosecdef or _p.proconfig is distinct from array['search_path=""'] or _p.owner <> current_user
    or _p.body <> '36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea' then
    raise exception using errcode = '55000', message = 'emergency_revocation_parent_refused';
  end if;
end
$guard$;

-- The release: off, with no approval mode, until the table owner records the decision.
create table clinical_private.workforce_identity_revocation_release (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  approval_mode text check (approval_mode is null or approval_mode in ('second_operator_before','independent_review_after')),
  changed_at timestamptz not null default clock_timestamp(),
  check (not enabled or approval_mode is not null)
);
insert into clinical_private.workforce_identity_revocation_release(singleton, enabled, approval_mode) values (true, false, null);

create table clinical_private.workforce_identity_revocation_proposals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  identity_id uuid not null references clinical_core.identities(id),
  reason_code text not null check (reason_code in
    ('suspected_compromise','credential_exposed','device_lost_or_stolen','practitioner_request','security_review')),
  approval_mode text not null check (approval_mode in ('second_operator_before','independent_review_after')),
  proposed_by text not null check (proposed_by ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'),
  proposed_at timestamptz not null default clock_timestamp()
);
create index workforce_identity_revocation_proposals_identity_idx on clinical_private.workforce_identity_revocation_proposals(identity_id);

create table clinical_private.workforce_identity_revocation_decisions (
  proposal_id uuid primary key references clinical_private.workforce_identity_revocation_proposals(id),
  decision text not null check (decision in ('approved','declined','confirmed','disputed')),
  decided_by text not null check (decided_by ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'),
  decided_at timestamptz not null default clock_timestamp()
);

-- The effect: one row per proposal that took effect. `identity_subject` is the provider username the adapter needs; it
-- is an identifier, not a credential.
create table clinical_private.workforce_identity_revocations (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null unique references clinical_private.workforce_identity_revocation_proposals(id),
  identity_id uuid not null references clinical_core.identities(id),
  identity_subject text not null check (identity_subject ~ '^[A-Za-z0-9:_-]{8,128}$'),
  effect text not null check (effect in ('disabled','already_disabled')),
  revoked_at timestamptz not null default clock_timestamp()
);

create table clinical_private.workforce_identity_provider_actions (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null unique,
  revocation_id uuid not null references clinical_private.workforce_identity_revocations(id),
  step text not null check (step in ('disable_user','global_sign_out')),
  outcome text not null check (outcome in ('succeeded','failed')),
  failure_code text check (failure_code is null or failure_code in
    ('not_found','throttled','unavailable','access_denied','timeout','unknown')),
  recorded_by text not null check (recorded_by ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  check ((outcome = 'failed') = (failure_code is not null))
);
create index workforce_identity_provider_actions_revocation_idx on clinical_private.workforce_identity_provider_actions(revocation_id);

create function clinical_private.workforce_identity_revocation_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'append_only_record';
end $$;
create trigger workforce_identity_revocation_proposals_append_only before update or delete on clinical_private.workforce_identity_revocation_proposals
  for each row execute function clinical_private.workforce_identity_revocation_append_only();
create trigger workforce_identity_revocation_proposals_no_truncate before truncate on clinical_private.workforce_identity_revocation_proposals
  for each statement execute function clinical_private.workforce_identity_revocation_append_only();
create trigger workforce_identity_revocation_decisions_append_only before update or delete on clinical_private.workforce_identity_revocation_decisions
  for each row execute function clinical_private.workforce_identity_revocation_append_only();
create trigger workforce_identity_revocation_decisions_no_truncate before truncate on clinical_private.workforce_identity_revocation_decisions
  for each statement execute function clinical_private.workforce_identity_revocation_append_only();
create trigger workforce_identity_revocations_append_only before update or delete on clinical_private.workforce_identity_revocations
  for each row execute function clinical_private.workforce_identity_revocation_append_only();
create trigger workforce_identity_revocations_no_truncate before truncate on clinical_private.workforce_identity_revocations
  for each statement execute function clinical_private.workforce_identity_revocation_append_only();
create trigger workforce_identity_provider_actions_append_only before update or delete on clinical_private.workforce_identity_provider_actions
  for each row execute function clinical_private.workforce_identity_revocation_append_only();
create trigger workforce_identity_provider_actions_no_truncate before truncate on clinical_private.workforce_identity_provider_actions
  for each statement execute function clinical_private.workforce_identity_revocation_append_only();

alter table clinical_private.workforce_identity_revocation_release enable row level security;
alter table clinical_private.workforce_identity_revocation_proposals enable row level security;
alter table clinical_private.workforce_identity_revocation_decisions enable row level security;
alter table clinical_private.workforce_identity_revocations enable row level security;
alter table clinical_private.workforce_identity_provider_actions enable row level security;
revoke all on clinical_private.workforce_identity_revocation_release, clinical_private.workforce_identity_revocation_proposals,
  clinical_private.workforce_identity_revocation_decisions, clinical_private.workforce_identity_revocations,
  clinical_private.workforce_identity_provider_actions
  from public, clinical_core_api, clinical_workforce_application, clinical_workforce_operator;

-- The entry of every legacy request: the parent's definition, with the workforce identity row held FOR SHARE.
create or replace function clinical_private.set_request_context(
  _actor_person_id uuid,
  _organization_id uuid,
  _identity_pool text,
  _identity_subject text,
  _purpose text,
  _environment text,
  _data_classification text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if _identity_pool not in ('workforce','consumer')
    or _purpose not in ('identity_link','consent_management','clinical_data')
    or _environment <> 'production-clinical'
    or _data_classification <> 'clinical_phi'
    or not exists (
      select 1 from clinical_core.identities i
      join clinical_core.persons p on p.id = i.person_id
      where i.person_id = _actor_person_id
        and i.identity_pool = _identity_pool
        and i.identity_subject = _identity_subject
        and i.production_bound = true
        and i.status = 'active'
        and p.status = 'active'
        and p.contains_phi = true
    ) then
    raise exception using errcode = '42501', message = 'request_context_refused';
  end if;
  -- workforce-identity-emergency-revocation: the workforce identity row stays share-locked until the operation's
  -- transaction ends, so an emergency revocation (FOR UPDATE on the same row) waits for this request to finish, and a
  -- request that waited on a pending revocation re-reads the committed row here and is refused. The refusal is the one
  -- above, so it does not say why. Consumer requests are unchanged.
  if _identity_pool = 'workforce' then
    perform 1 from clinical_core.identities i
      where i.person_id = _actor_person_id
        and i.identity_pool = 'workforce'
        and i.identity_subject = _identity_subject
        and i.production_bound = true
        and i.status = 'active'
      for share;
    if not found then
      raise exception using errcode = '42501', message = 'request_context_refused';
    end if;
  end if;
  perform set_config('clinical.claim.actor_person_id', _actor_person_id::text, true);
  perform set_config('clinical.claim.organization_id', _organization_id::text, true);
  perform set_config('clinical.claim.identity_pool', _identity_pool, true);
  perform set_config('clinical.claim.identity_subject', _identity_subject, true);
  perform set_config('clinical.claim.purpose', _purpose, true);
  perform set_config('clinical.claim.environment', _environment, true);
  perform set_config('clinical.claim.data_classification', _data_classification, true);
end
$$;

create function clinical_private.require_active_platform_operator(_operator_subject text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if _operator_subject is null or _operator_subject !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    or not exists (select 1 from clinical_private.workforce_platform_operators
      where operator_subject = _operator_subject and status = 'active' for share) then
    raise exception using errcode = '42501', message = 'workforce_operator_refused';
  end if;
end $$;

-- An operator never decides about their own workforce login: not the same subject, and not a workforce account that
-- shares the email of the operator's own workforce account (a person holds one workforce identity).
create function clinical_private.require_not_own_workforce_login(_operator_subject text, _identity_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from clinical_core.identities i where i.id = _identity_id
        and lower(i.identity_subject) = lower(_operator_subject))
    or exists (select 1 from clinical_core.identities i
        join clinical_core.workforce_identity_directory target on lower(target.identity_subject) = lower(i.identity_subject)
        join clinical_core.workforce_identity_directory own on own.email_sha256 = target.email_sha256
        where i.id = _identity_id and lower(own.identity_subject) = lower(_operator_subject)) then
    raise exception using errcode = '42501', message = 'workforce_self_approval_refused';
  end if;
end $$;

create function clinical_private.workforce_identity_revocation_summary(_proposal_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare _p clinical_private.workforce_identity_revocation_proposals%rowtype;
  _d clinical_private.workforce_identity_revocation_decisions%rowtype;
  _r clinical_private.workforce_identity_revocations%rowtype;
  _disable text; _signout text;
begin
  select * into _p from clinical_private.workforce_identity_revocation_proposals where id = _proposal_id;
  select * into _d from clinical_private.workforce_identity_revocation_decisions where proposal_id = _proposal_id;
  select * into _r from clinical_private.workforce_identity_revocations where proposal_id = _proposal_id;
  if _r.id is not null then
    select a.outcome into _disable from clinical_private.workforce_identity_provider_actions a
      where a.revocation_id = _r.id and a.step = 'disable_user' order by a.recorded_at desc, a.id desc limit 1;
    select a.outcome into _signout from clinical_private.workforce_identity_provider_actions a
      where a.revocation_id = _r.id and a.step = 'global_sign_out' order by a.recorded_at desc, a.id desc limit 1;
  end if;
  return jsonb_build_object(
    'proposalId', _p.id, 'requestId', _p.request_id, 'reason', _p.reason_code, 'approvalMode', _p.approval_mode,
    'proposedAt', _p.proposed_at,
    'state', case when _r.id is not null then 'revoked' when _d.decision = 'declined' then 'declined' else 'awaiting_approval' end,
    'review', case
      when _d.decision is not null then _d.decision
      when _p.approval_mode = 'independent_review_after' then 'awaiting_independent_review'
      else 'awaiting_independent_approval' end,
    'revocationId', _r.id, 'effect', _r.effect, 'revokedAt', _r.revoked_at,
    'provider', case
      when _r.id is null then 'not_started'
      when _disable = 'succeeded' and _signout = 'succeeded' then 'complete'
      when _disable = 'failed' or _signout = 'failed' then 'failed'
      else 'pending' end);
end $$;

-- Applies one proposal: the identity is held FOR UPDATE, so every admitted request finishes first.
create function clinical_private.apply_workforce_identity_revocation(_proposal_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare _p clinical_private.workforce_identity_revocation_proposals%rowtype;
  _identity clinical_core.identities%rowtype;
begin
  select * into _p from clinical_private.workforce_identity_revocation_proposals where id = _proposal_id;
  select * into _identity from clinical_core.identities where id = _p.identity_id for update;
  if _identity.status = 'active' then
    update clinical_core.identities set status = 'disabled' where id = _identity.id;
  end if;
  insert into clinical_private.workforce_identity_revocations(proposal_id, identity_id, identity_subject, effect)
    values (_p.id, _identity.id, _identity.identity_subject,
      case when _identity.status = 'active' then 'disabled' else 'already_disabled' end);
end $$;

create function clinical_private.propose_workforce_identity_revocation(
  _operator_subject text, _request_id uuid, _identity_subject text, _reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _release clinical_private.workforce_identity_revocation_release%rowtype;
  _existing clinical_private.workforce_identity_revocation_proposals%rowtype;
  _identity clinical_core.identities%rowtype;
  _proposal_id uuid;
begin
  if _request_id is null or _identity_subject is null or _identity_subject !~ '^[A-Za-z0-9:_-]{8,128}$'
    or _reason is null or _reason not in
      ('suspected_compromise','credential_exposed','device_lost_or_stolen','practitioner_request','security_review') then
    raise exception using errcode = '22023', message = 'workforce_identity_revocation_invalid';
  end if;
  select * into _release from clinical_private.workforce_identity_revocation_release where singleton;
  if not found or not _release.enabled or _release.approval_mode is null then
    raise exception using errcode = '55000', message = 'workforce_identity_revocation_not_released';
  end if;
  perform clinical_private.require_active_platform_operator(_operator_subject);
  -- One request id, one answer: a retry waits for the first and receives its result.
  perform pg_advisory_xact_lock(hashtextextended('workforce-identity-revocation/' || _request_id::text, 0));
  select * into _existing from clinical_private.workforce_identity_revocation_proposals where request_id = _request_id;
  if found then
    if _existing.proposed_by <> _operator_subject or _existing.reason_code <> _reason
      or (select i.identity_subject from clinical_core.identities i where i.id = _existing.identity_id) <> _identity_subject then
      raise exception using errcode = '23505', message = 'workforce_identity_revocation_conflict';
    end if;
    return clinical_private.workforce_identity_revocation_summary(_existing.id) || jsonb_build_object('duplicate', true);
  end if;
  select * into _identity from clinical_core.identities
    where identity_pool = 'workforce' and identity_subject = _identity_subject for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'workforce_identity_not_found';
  end if;
  perform clinical_private.require_not_own_workforce_login(_operator_subject, _identity.id);
  insert into clinical_private.workforce_identity_revocation_proposals(request_id, identity_id, reason_code, approval_mode, proposed_by)
    values (_request_id, _identity.id, _reason, _release.approval_mode, _operator_subject) returning id into _proposal_id;
  if _release.approval_mode = 'independent_review_after' then
    perform clinical_private.apply_workforce_identity_revocation(_proposal_id);
  end if;
  return clinical_private.workforce_identity_revocation_summary(_proposal_id) || jsonb_build_object('duplicate', false);
end $$;

create function clinical_private.decide_workforce_identity_revocation(
  _operator_subject text, _proposal_id uuid, _decision text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _release clinical_private.workforce_identity_revocation_release%rowtype;
  _p clinical_private.workforce_identity_revocation_proposals%rowtype;
  _d clinical_private.workforce_identity_revocation_decisions%rowtype;
  _recorded text := case _decision when 'approve' then 'approved' when 'decline' then 'declined'
    when 'confirm' then 'confirmed' when 'dispute' then 'disputed' end;
begin
  if _proposal_id is null or _recorded is null then
    raise exception using errcode = '22023', message = 'workforce_identity_revocation_invalid';
  end if;
  select * into _release from clinical_private.workforce_identity_revocation_release where singleton;
  if not found or not _release.enabled then
    raise exception using errcode = '55000', message = 'workforce_identity_revocation_not_released';
  end if;
  perform clinical_private.require_active_platform_operator(_operator_subject);
  perform pg_advisory_xact_lock(hashtextextended('workforce-identity-revocation-decision/' || _proposal_id::text, 0));
  select * into _p from clinical_private.workforce_identity_revocation_proposals where id = _proposal_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'workforce_identity_revocation_not_found';
  end if;
  if lower(_p.proposed_by) = lower(_operator_subject) then
    raise exception using errcode = '42501', message = 'workforce_independent_operator_required';
  end if;
  perform clinical_private.require_not_own_workforce_login(_operator_subject, _p.identity_id);
  if (_p.approval_mode = 'second_operator_before' and _recorded not in ('approved','declined'))
    or (_p.approval_mode = 'independent_review_after' and _recorded not in ('confirmed','disputed')) then
    raise exception using errcode = '22023', message = 'workforce_identity_revocation_invalid';
  end if;
  select * into _d from clinical_private.workforce_identity_revocation_decisions where proposal_id = _proposal_id;
  if found then
    if _d.decided_by <> _operator_subject or _d.decision <> _recorded then
      raise exception using errcode = '23505', message = 'workforce_identity_revocation_conflict';
    end if;
    return clinical_private.workforce_identity_revocation_summary(_proposal_id) || jsonb_build_object('duplicate', true);
  end if;
  insert into clinical_private.workforce_identity_revocation_decisions(proposal_id, decision, decided_by)
    values (_proposal_id, _recorded, _operator_subject);
  if _recorded = 'approved' then
    perform clinical_private.apply_workforce_identity_revocation(_proposal_id);
  end if;
  return clinical_private.workforce_identity_revocation_summary(_proposal_id) || jsonb_build_object('duplicate', false);
end $$;

-- One provider attempt, recorded by its own idempotency key. A failure is recorded as a failure: the summary stays
-- 'failed' until a later attempt succeeds. Recording does not need the release, so switching it off after a revocation
-- never strands a pending provider item.
create function clinical_private.record_workforce_identity_provider_action(
  _operator_subject text, _action_id uuid, _revocation_id uuid, _step text, _outcome text, _failure_code text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _a clinical_private.workforce_identity_provider_actions%rowtype;
  _proposal uuid;
begin
  if _action_id is null or _revocation_id is null or _step is null or _step not in ('disable_user','global_sign_out')
    or _outcome is null or _outcome not in ('succeeded','failed')
    or (_outcome = 'failed') <> (_failure_code is not null)
    or (_failure_code is not null and _failure_code not in ('not_found','throttled','unavailable','access_denied','timeout','unknown')) then
    raise exception using errcode = '22023', message = 'workforce_identity_revocation_invalid';
  end if;
  perform clinical_private.require_active_platform_operator(_operator_subject);
  select proposal_id into _proposal from clinical_private.workforce_identity_revocations where id = _revocation_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'workforce_identity_revocation_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('workforce-identity-provider-action/' || _action_id::text, 0));
  select * into _a from clinical_private.workforce_identity_provider_actions where action_id = _action_id;
  if found then
    if _a.revocation_id <> _revocation_id or _a.step <> _step or _a.outcome <> _outcome
      or _a.failure_code is distinct from _failure_code then
      raise exception using errcode = '23505', message = 'workforce_identity_revocation_conflict';
    end if;
    return clinical_private.workforce_identity_revocation_summary(_proposal) || jsonb_build_object('duplicate', true);
  end if;
  insert into clinical_private.workforce_identity_provider_actions(action_id, revocation_id, step, outcome, failure_code, recorded_by)
    values (_action_id, _revocation_id, _step, _outcome, _failure_code, _operator_subject);
  return clinical_private.workforce_identity_revocation_summary(_proposal) || jsonb_build_object('duplicate', false);
end $$;

-- The operator's reconciliation list: every revocation whose provider side is not complete, and every proposal still
-- awaiting its independent operator, with the workforce subject (the provider username, and the subject an approval
-- must fence before it disables the identity).
create function clinical_private.list_workforce_identity_revocation_work(_operator_subject text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform clinical_private.require_active_platform_operator(_operator_subject);
  return coalesce((select jsonb_agg(item order by (item->>'proposedAt') desc, item->>'proposalId')
    from (select clinical_private.workforce_identity_revocation_summary(p.id)
        || jsonb_build_object('providerUsername', i.identity_subject) as item
      from clinical_private.workforce_identity_revocation_proposals p
      join clinical_core.identities i on i.id = p.identity_id
      order by p.proposed_at desc, p.id limit 200) listed
    where item->>'provider' <> 'complete' or item->>'review' like 'awaiting%'), '[]'::jsonb);
end $$;

revoke all on function clinical_private.require_active_platform_operator(text) from public;
revoke all on function clinical_private.require_not_own_workforce_login(text,uuid) from public;
revoke all on function clinical_private.workforce_identity_revocation_summary(uuid) from public;
revoke all on function clinical_private.apply_workforce_identity_revocation(uuid) from public;
revoke all on function clinical_private.workforce_identity_revocation_append_only() from public;
revoke all on function clinical_private.propose_workforce_identity_revocation(text,uuid,text,text) from public;
revoke all on function clinical_private.decide_workforce_identity_revocation(text,uuid,text) from public;
revoke all on function clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text) from public;
revoke all on function clinical_private.list_workforce_identity_revocation_work(text) from public;
grant execute on function clinical_private.propose_workforce_identity_revocation(text,uuid,text,text) to clinical_workforce_operator;
grant execute on function clinical_private.decide_workforce_identity_revocation(text,uuid,text) to clinical_workforce_operator;
grant execute on function clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text) to clinical_workforce_operator;
grant execute on function clinical_private.list_workforce_identity_revocation_work(text) to clinical_workforce_operator;

do $check$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'))
      <> '3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b'
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid in (to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'),
        to_regprocedure('clinical_private.propose_workforce_identity_revocation(text,uuid,text,text)'),
        to_regprocedure('clinical_private.decide_workforce_identity_revocation(text,uuid,text)'),
        to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)'),
        to_regprocedure('clinical_private.list_workforce_identity_revocation_work(text)'))
        and a.grantee = 0)
    or has_function_privilege('clinical_core_api', 'clinical_private.propose_workforce_identity_revocation(text,uuid,text,text)', 'execute')
    or has_function_privilege('clinical_core_api', 'clinical_private.decide_workforce_identity_revocation(text,uuid,text)', 'execute')
    or has_function_privilege('clinical_workforce_application', 'clinical_private.propose_workforce_identity_revocation(text,uuid,text,text)', 'execute') then
    raise exception using errcode = '55000', message = 'emergency_revocation_successor_refused';
  end if;
end
$check$;

commit;
