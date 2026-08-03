-- Phase 9D repair — the widened text scan must exclude declared-value fields.
--
-- Migration `20260802220512` widened `private.import_restricted_flags` to
-- scan the whole payload as text so reference rows with peptide/vaccine
-- vocabulary in `subjectLabel`/`mechanism`/`shortExcerpt` would still
-- trip. That worked, but it also scanned the DECLARED fields
-- (`regulatoryClassification`, `route`, `restrictedFlags`,
-- `vaccineRelated`) themselves. A row with a benign name and
-- `regulatoryClassification="peptide"` now acquires BOTH `peptide`
-- (correct, from the declared branch) AND `suspected_restricted` (wrong
-- — the declared value is the authority; the text scan on that same
-- value creates redundant suspicion).
--
-- The inference boundary is:
--   * DECLARED values are authority — the declared branch turns them
--     into a specific flag.
--   * TEXT signals are suspicion — the text scan looks at what the
--     source SAID, not at what the source DECLARED.
-- The scan must therefore read the payload minus the declared-value
-- keys. Missing/unknown regulatory facts remain Unknown — nothing is
-- inferred as "safe" from absence.

create or replace function private.import_restricted_flags(
  _entity_type text, _payload jsonb)
returns text[] language plpgsql immutable set search_path = ''
as $fn$
declare
  _flags text[] := '{}';
  _declared text;
  _route text;
  _text text;
  _payload_for_scan jsonb;
begin
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

  -- Text scan reads the payload MINUS the declared-value keys so a
  -- declared class does not double-flag itself as `suspected_restricted`.
  -- Keys stripped: regulatoryClassification, route, vaccineRelated,
  -- restrictedFlags. Everything else (name, description, subjectLabel,
  -- mechanism, suggestedDose, shortExcerpt, sourceRaw fields the parser
  -- kept, etc.) is fair scan territory.
  _payload_for_scan := _payload
    - 'regulatoryClassification'
    - 'route'
    - 'vaccineRelated'
    - 'restrictedFlags';
  _text := lower(coalesce(_payload_for_scan::text, ''));

  if _text ~ '(peptide|bpc-?157|tb-?500|semaglutide|tirzepatide|ipamorelin|sermorelin|ghk-?cu|melanotan|glp-?1)'
     or _text ~ '(intravenous|\miv\M|infusion|injectable|injection|iv therapy|myers.? cocktail)'
     or _text ~ '(vaccine|\mvax\M|mrna|spike protein|post-?vax|jab injury)'
     or _text ~ '(prescription|\mrx\M|schedule i{1,3}|schedule iv|schedule v|controlled substance|low-?dose naltrexone|\mldn\M)'
     or _text ~ '(chelation|ozone therapy|stem cell|exosome|hbot|hyperbaric|pemf|pbm|cold-?laser)'
     or _text ~ '(not for sale in|\meu only\M|fda-?approved|\mmhra\M|\mtga\M|regulated in)' then
    if not ('suspected_restricted' = any(_flags)) then
      _flags := _flags || 'suspected_restricted'::text;
    end if;
  end if;

  return _flags;
end;
$fn$;
