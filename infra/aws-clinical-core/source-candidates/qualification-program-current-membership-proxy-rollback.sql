-- BLOCKED rollback for the qualification-only current-membership proxy.
-- The reviewed operator must verify the exact source/body and absence of live
-- requests before executing; this does not roll back either parent candidate.
begin;
do $$
declare _proxy oid;
begin
  if current_database() <> 'clinical_core_qualification' then
    raise exception 'qualification_database_refused';
  end if;
  _proxy := to_regprocedure('clinical_program_qualification.set_current_workforce_context(text,uuid,text)');
  if _proxy is null or not exists (select 1 from pg_proc p where p.oid=_proxy
      and p.prokind='f' and p.prosecdef and p.proconfig=array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='5bfb5080bc9bd3bb5613574fdd15a4bff65ef31f8fb3062cd2784c770377f077') then
    raise exception 'qualification_proxy_changed';
  end if;
end
$$;
drop function clinical_program_qualification.set_current_workforce_context(text,uuid,text);
commit;
