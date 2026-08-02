-- `_flags || 'literal'` does not do what it reads like.
--
-- With an untyped string literal on the right, Postgres resolves the `||`
-- operator as array || array, then tries to parse `'parenteral_therapy'` as an
-- array literal and fails at runtime — not at create time, because the body of
-- a plpgsql function is only parsed when it executes. The classifier therefore
-- deployed cleanly in 20260801185637 and raised
-- `malformed array literal` the first time it saw a declared route.
--
-- Every appended literal is now cast to ::text so it appends as ONE element.
--
-- This was found by running the refusal probe rather than by reading the
-- migration back, which is the argument for running them: a refusal that has
-- never been triggered is a comment, not a control.

begin;

create or replace function private.import_restricted_flags(
  _entity_type text, _payload jsonb)
returns text[] language plpgsql immutable set search_path = ''
as $fn$
declare
  _flags text[] := '{}';
  _declared text;
  _route text;
  _text text;
begin
  -- ---------------------------------------------------------------- declared
  _declared := lower(btrim(coalesce(_payload ->> 'regulatoryClassification', '')));
  if _declared in ('prescription', 'peptide', 'device') then
    _flags := _flags || _declared::text;
  end if;

  _route := lower(btrim(coalesce(_payload ->> 'route', '')));
  if _route in ('iv', 'intravenous', 'infusion', 'im', 'intramuscular',
                'subcutaneous', 'injection') then
    _flags := _flags || 'parenteral_therapy'::text;
  end if;

  if coalesce((_payload ->> 'vaccineRelated')::boolean, false) then
    _flags := _flags || 'vaccine_related'::text;
  end if;

  if jsonb_typeof(_payload -> 'restrictedFlags') = 'array' then
    _flags := _flags || coalesce(array(
      select lower(btrim(value))
      from jsonb_array_elements_text(_payload -> 'restrictedFlags')
      where btrim(value) <> ''), '{}'::text[]);
  end if;

  -- --------------------------------------------------------------- signalled
  --
  -- Concatenated free text, checked for restricted vocabulary. The outcome is
  -- always the same single flag; the vocabulary that matched is deliberately
  -- not recorded as a class.
  _text := lower(concat_ws(' ',
    _payload ->> 'name', _payload ->> 'productName', _payload ->> 'description',
    _payload ->> 'statement', _payload ->> 'proposition', _payload ->> 'title',
    _payload ->> 'category', _payload ->> 'form'));

  if _text ~ '(peptide|bpc-?157|tb-?500|semaglutide|tirzepatide|ipamorelin|sermorelin)'
     or _text ~ '(intravenous|\miv\M|infusion|injectable|injection)'
     or _text ~ '(vaccine|vax|mrna|spike protein)'
     or _text ~ '(prescription|\mrx\M|schedule ii|controlled substance)'
     or _text ~ '(chelation|ozone therapy|stem cell|exosome)' then
    if not ('suspected_restricted' = any(_flags)) then
      _flags := _flags || 'suspected_restricted'::text;
    end if;
  end if;

  return (select coalesce(array_agg(distinct f order by f), '{}'::text[])
          from unnest(_flags) f);
end;
$fn$;

commit;
