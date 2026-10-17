-- Rollback of the UNREGISTERED, BLOCKED workforce-identity-recovery.sql. Applied nowhere.
--
-- Preserving: it removes the recovery and custodial-access functions, so no new replacement credential or custodial
-- read can happen here, and switches the release off. It keeps every table and every row (proposals, decisions,
-- retired subjects, custodial grants and the access log), no longer reachable by any API or operator role.
-- It keeps the retired-subject guard on identities and the directory: a subject retired after a compromise stays
-- retired, so rolling back can never let the old login back in. It undoes no recovery that already happened.

begin;

do $guard$
begin
  if to_regprocedure('clinical_private.decide_workforce_identity_recovery(text,uuid,boolean)') is null
    or to_regclass('clinical_private.workforce_retired_identity_subjects') is null then
    raise exception using errcode = '55000', message = 'identity_recovery_rollback_refused';
  end if;
end
$guard$;

drop function clinical_private.read_workforce_custodial_patient_file(text,uuid,uuid);
drop function clinical_private.decide_workforce_custodial_access(text,uuid,boolean);
drop function clinical_private.request_workforce_custodial_access(text,uuid,uuid,uuid,text,integer);
drop function clinical_private.decide_workforce_identity_recovery(text,uuid,boolean);
drop function clinical_private.propose_workforce_identity_recovery(text,uuid,text,text,text,text,text,text);
drop function clinical_private.workforce_custodial_access_summary(uuid);
drop function clinical_private.workforce_identity_recovery_summary(uuid);
drop function clinical_private.require_recovery_approver(text,text);
drop function clinical_private.require_identity_recovery_release();
update clinical_private.workforce_identity_recovery_release set enabled = false, changed_at = clock_timestamp();

do $check$
begin
  if to_regprocedure('clinical_private.read_workforce_custodial_patient_file(text,uuid,uuid)') is not null
    or not exists (select 1 from pg_trigger where tgname = 'identities_refuse_retired_subject' and not tgisinternal)
    or not exists (select 1 from pg_trigger where tgname = 'workforce_identity_directory_refuse_retired_subject' and not tgisinternal) then
    raise exception using errcode = '55000', message = 'identity_recovery_rollback_refused';
  end if;
end
$check$;

commit;
