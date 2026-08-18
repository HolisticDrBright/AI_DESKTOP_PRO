-- Force jsonb key-removal arrays to text[]. Without the casts, the deployed
-- function can resolve the expression through an incompatible overload and
-- reject a valid object with SQLSTATE 22P02.
begin;

do $migration$
declare
  _signature regprocedure :=
    'public.record_sync_lab_result_pgtext(uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid)'::regprocedure;
  _ddl text;
begin
  _ddl := pg_get_functiondef(_signature);
  _ddl := replace(
    _ddl,
    $old$array['schemaVersion','source','panel','result']$old$,
    $new$array['schemaVersion','source','panel','result']::text[]$new$
  );
  _ddl := replace(
    _ddl,
    $old$array['system','recordType','panelId','markerId','recordVersion']$old$,
    $new$array['system','recordType','panelId','markerId','recordVersion']::text[]$new$
  );
  _ddl := replace(
    _ddl,
    $old$array['name','collectedAt','sourceLabel']$old$,
    $new$array['name','collectedAt','sourceLabel']::text[]$new$
  );
  _ddl := replace(
    _ddl,
    $old$array['name','value','unit','sourceStatus','referenceRange']$old$,
    $new$array['name','value','unit','sourceStatus','referenceRange']::text[]$new$
  );
  _ddl := replace(
    _ddl,
    $old$array['min','max']$old$,
    $new$array['min','max']::text[]$new$
  );
  if length(_ddl) - length(replace(_ddl, '::text[]', '')) <> 5 * length('::text[]') then
    raise exception 'lab result key-validation patch did not match the expected function';
  end if;
  execute _ddl;
end;
$migration$;

revoke all on function public.record_sync_lab_result_pgtext(
  uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid
) from public, anon, authenticated, service_role;

commit;
