-- UNREGISTERED, BLOCKED source candidate (workforce-bootstrap-operator-listing). Applied nowhere, registered in no
-- manifest; no route, role or Lambda depends on it. Registration and execution are Codex work after the production
-- security, agreement, privacy and PHI reviews.
--
-- Parent, applied after the whole bootstrap chain:
--   source-candidates/workforce-new-clinic-bootstrap.sql (SHA-256 82efb74c41fe8da9934538332398101cfb25e73006d59fa306746f637f1d8eb1)
-- Rollback: workforce-bootstrap-operator-listing-rollback.sql (apply it before the parent's rollback).
--
-- What it adds: one read for the platform operator's console, so a suspension can be chosen and every decision about
-- a bootstrapped clinic can be audited without reading any account. It writes nothing and grants nothing.
--
-- 1. Only an ACTIVE registered platform operator may call it (the same registry check as every operator function); the
--    caller's subject comes from the separate, MFA-protected operator sign-in, never from a workforce token.
-- 2. It answers the 50 newest bootstrapped clinics: the clinic's id and its own name, its status, when it was created,
--    and, if suspended, when and the closed-vocabulary reason; then each recorded event in order (created, suspended)
--    with its reason and time.
-- 3. The operator who decided an event is named only by a fingerprint (`aidp-operator/1`), plus whether it was the
--    caller: enough to audit "who decided" against the operator registry, without a subject in the clear.
-- 4. It returns no owner subject, address digest, person, membership, patient or clinical row, and no release state.
-- 5. Nothing here reinstates a suspended clinic: no reinstatement is defined.

create function clinical_private.list_bootstrapped_workforce_clinics(_operator_subject text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if _operator_subject is null or not exists (select 1 from clinical_private.workforce_platform_operators
      where operator_subject=_operator_subject and status='active') then
    raise exception using errcode='42501',message='workforce_operator_refused';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'organizationId',b.organization_id,'clinicLabel',b.clinic_label,'status',b.status,'createdAt',b.created_at,
      'suspendedAt',b.suspended_at,'suspensionReason',b.suspension_reason,
      'events',coalesce((select jsonb_agg(jsonb_build_object(
          'action',e.action,'reason',e.reason_code,'occurredAt',e.occurred_at,
          'operator',case when e.operator_subject is null then null
            else substr(encode(sha256(convert_to('aidp-operator/1|'||lower(e.operator_subject),'UTF8')),'hex'),1,16) end,
          'byCaller',e.operator_subject is not null and lower(e.operator_subject)=lower(_operator_subject))
          order by e.occurred_at,e.id)
        from clinical_private.workforce_clinic_bootstrap_events e where e.request_id=b.request_id),'[]'::jsonb))
      order by b.created_at desc,b.organization_id)
    from (select * from clinical_private.workforce_clinic_bootstraps
      order by created_at desc,organization_id limit 50) b),'[]'::jsonb);
end $$;

revoke all on function clinical_private.list_bootstrapped_workforce_clinics(text)
  from public,clinical_core_api,clinical_workforce_application;
grant execute on function clinical_private.list_bootstrapped_workforce_clinics(text) to clinical_workforce_operator;
