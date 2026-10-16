-- UNREGISTERED, BLOCKED successor to workforce-bootstrap-operator-listing.sql. Applied nowhere.
-- Parent candidate SHA-256: 5a7af23d78387eab099e2c749b87edc52234b61eca8893cc54bf37d38639351b.
-- Only change: preserve causal bootstrap-before-suspension order when clock timestamps tie.
-- No table, row, role, grant or release state is changed. Roll back with the separately guarded successor rollback.

do $$
begin
  if (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')
      from pg_proc p where p.oid=to_regprocedure('clinical_private.list_bootstrapped_workforce_clinics(text)'))
      is distinct from 'e076188526e9d321920783dd2997df3cb7a0599db239d3b18e1a1545f5f15e58' then
    raise exception using errcode='P0001',message='workforce_operator_listing_parent_mismatch';
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
          order by case e.action when 'bootstrapped' then 0 else 1 end,e.occurred_at,e.id)
        from clinical_private.workforce_clinic_bootstrap_events e where e.request_id=b.request_id),'[]'::jsonb))
      order by b.created_at desc,b.organization_id)
    from (select * from clinical_private.workforce_clinic_bootstraps
      order by created_at desc,organization_id limit 50) b),'[]'::jsonb);
end $$;
