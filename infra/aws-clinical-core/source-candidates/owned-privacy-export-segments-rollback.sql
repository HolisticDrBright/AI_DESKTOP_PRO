-- Guarded rollback of the UNREGISTERED, BLOCKED segmented privacy-export reader (owned-privacy-export-segments.sql).
-- It drops exactly that one function, and only while its body is the reviewed one (prosrc SHA-256
-- e8dd247406a6469916e617af2651aa2c68412445d1c08a69e679c6e6657e432a). Preserving: every
-- clinical_audit.owned_privacy_export_events row the function wrote stays, and the deployed reader
-- clinical_core.read_owned_privacy_export, the export and job tables, every record version, consent and job row are
-- untouched. Move PRIVACY_EXPORT_SEGMENTED_READ_RELEASE back to 'blocked' and deploy that build BEFORE running this file:
-- a build still on 'qualification' would find no function and fail every records page (as storage_unavailable).
begin;

do $guard$
declare _fn regprocedure := to_regprocedure('clinical_core.read_owned_privacy_export_segments(uuid,integer,jsonb)');
begin
  if _fn is null or not exists (select 1 from pg_proc p
      where p.oid = _fn and p.prosecdef and p.proconfig = array['search_path=""']::text[]
        and p.proowner = (select oid from pg_roles where rolname = current_user)
        and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = 'e8dd247406a6469916e617af2651aa2c68412445d1c08a69e679c6e6657e432a')
    or to_regprocedure('clinical_core.read_owned_privacy_export(uuid,text,integer,jsonb)') is null then
    raise exception using errcode = '55000', message = 'privacy_export_segments_rollback_refused';
  end if;
end
$guard$;

drop function clinical_core.read_owned_privacy_export_segments(uuid,integer,jsonb);

do $post$
begin
  if to_regprocedure('clinical_core.read_owned_privacy_export_segments(uuid,integer,jsonb)') is not null
    or to_regprocedure('clinical_core.read_owned_privacy_export(uuid,text,integer,jsonb)') is null then
    raise exception using errcode = '55000', message = 'privacy_export_segments_rollback_refused';
  end if;
end
$post$;
commit;
