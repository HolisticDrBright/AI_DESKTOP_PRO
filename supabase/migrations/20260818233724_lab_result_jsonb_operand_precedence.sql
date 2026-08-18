-- Parenthesize nested jsonb extraction before key removal. PostgreSQL gives
-- the custom JSON operators equal precedence, so the unparenthesized form
-- can try to subtract a text array from the key literal itself.
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
    $old$(_payload->'source' - array['system','recordType','panelId','markerId','recordVersion']::text[])$old$,
    $new$((_payload->'source') - array['system','recordType','panelId','markerId','recordVersion']::text[])$new$
  );
  _ddl := replace(
    _ddl,
    $old$(_payload->'panel' - array['name','collectedAt','sourceLabel']::text[])$old$,
    $new$((_payload->'panel') - array['name','collectedAt','sourceLabel']::text[])$new$
  );
  _ddl := replace(
    _ddl,
    $old$(_payload->'result' - array['name','value','unit','sourceStatus','referenceRange']::text[])$old$,
    $new$((_payload->'result') - array['name','value','unit','sourceStatus','referenceRange']::text[])$new$
  );
  _ddl := replace(
    _ddl,
    $old$(_payload#>'{result,referenceRange}' - array['min','max']::text[])$old$,
    $new$((_payload#>'{result,referenceRange}') - array['min','max']::text[])$new$
  );
  if length(_ddl) - length(replace(_ddl, ') - array[', '')) <> 4 * length(') - array[') then
    raise exception 'lab result operand-precedence patch did not match the expected function';
  end if;
  execute _ddl;
end;
$migration$;

revoke all on function public.record_sync_lab_result_pgtext(
  uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid
) from public, anon, authenticated, service_role;

commit;
