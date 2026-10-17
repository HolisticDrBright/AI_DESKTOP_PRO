-- Rollback of the UNREGISTERED, BLOCKED workforce-revocation-campaign-signal.sql. Applied nowhere.
--
-- Preserving: it restores workforce_identity_revocation_summary and record_workforce_identity_provider_action exactly
-- as the emergency revocation wrote them (prosrc SHA-256 775819dd791c2df318aaa18544ba7bd0ea12a9c9749dba68e81943146904a4a7 and
-- 60817476eca810cd704937eb2df836dcb69b4fe4986eb0db81d65d52aad0f3d6). It keeps every row, including every recorded 'campaign_signal'
-- attempt, so it keeps the widened step check too: narrowing it would refuse rows that are already there. Restored, the
-- summary no longer reads those rows, and the recorder refuses a new one. Nothing is deleted from the campaign signal
-- table either: a published revocation stays published.
--
-- Roll this back before the emergency revocation's own rollback, which removes both functions.
-- It refuses unless both functions are exactly the successor's.

begin;

do $guard$
declare _p record;
begin
  for _p in select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner,
      encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as body, p.oid = to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)') as is_summary
    from pg_proc p where p.oid in (to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)'), to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)')) loop
    if not _p.prosecdef or _p.proconfig is distinct from array['search_path=""'] or _p.owner <> current_user
      or _p.body <> (case when _p.is_summary then 'da11a53c05619318ccb6e88af3f7c51a9b48f7d3bef3acac34cb2c6ac78f9fe6' else '8eab347a286520a0619681dc895ea9a216fbb25d4653b4b1e8f47ec7e2b3d458' end) then
      raise exception using errcode = '55000', message = 'revocation_campaign_signal_rollback_refused';
    end if;
  end loop;
  if to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)') is null or to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)') is null
    -- Grants are as the parent left them: the summary is the owner's alone; the recorder is the operator's.
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)') and a.grantee <> p.proowner)
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)') and a.grantee <> p.proowner
        and (a.grantee <> (select oid from pg_roles where rolname = 'clinical_workforce_operator') or a.privilege_type <> 'EXECUTE'))
    or not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)') and a.grantee = (select oid from pg_roles where rolname = 'clinical_workforce_operator')) then
    raise exception using errcode = '55000', message = 'revocation_campaign_signal_rollback_refused';
  end if;
end
$guard$;

create or replace function clinical_private.workforce_identity_revocation_summary(_proposal_id uuid)
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

create or replace function clinical_private.record_workforce_identity_provider_action(
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

do $check$
declare _p record;
begin
  for _p in select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner,
      encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as body, p.oid = to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)') as is_summary
    from pg_proc p where p.oid in (to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)'), to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)')) loop
    if not _p.prosecdef or _p.proconfig is distinct from array['search_path=""'] or _p.owner <> current_user
      or _p.body <> (case when _p.is_summary then '775819dd791c2df318aaa18544ba7bd0ea12a9c9749dba68e81943146904a4a7' else '60817476eca810cd704937eb2df836dcb69b4fe4986eb0db81d65d52aad0f3d6' end) then
      raise exception using errcode = '55000', message = 'revocation_campaign_signal_rollback_refused';
    end if;
  end loop;
  if to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)') is null or to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)') is null
    -- Grants are as the parent left them: the summary is the owner's alone; the recorder is the operator's.
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)') and a.grantee <> p.proowner)
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)') and a.grantee <> p.proowner
        and (a.grantee <> (select oid from pg_roles where rolname = 'clinical_workforce_operator') or a.privilege_type <> 'EXECUTE'))
    or not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)') and a.grantee = (select oid from pg_roles where rolname = 'clinical_workforce_operator')) then
    raise exception using errcode = '55000', message = 'revocation_campaign_signal_rollback_refused';
  end if;
end
$check$;

commit;
