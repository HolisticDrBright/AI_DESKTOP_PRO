-- Guarded rollback for the UNREGISTERED, BLOCKED event-order successor. Applied nowhere.
-- Restores the pinned parent function body. It preserves every append-only event and all existing privileges.
-- Apply before workforce-bootstrap-operator-listing-rollback.sql if unwinding the entire operator listing.

do $$
begin
  if (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')
      from pg_proc p where p.oid=to_regprocedure('clinical_private.list_bootstrapped_workforce_clinics(text)'))
      is distinct from '8b840dfecd982871ba2ea0545869a1187249ef08dc4c478732f2b8ca63ca1745' then
    raise exception using errcode='P0001',message='workforce_operator_event_order_rollback_mismatch';
  end if;
end $$;

create or replace function clinical_private.list_bootstrapped_workforce_clinics(_operator_subject text)
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
