-- Phase 9D follow-up — restricted-flag text scan reads the whole payload.
--
-- The prior version scanned a hand-listed set of payload fields (name,
-- productName, description, statement, proposition, title, category, form,
-- subjectLabel, mechanism, suggestedDose, directions, warnings, notes).
-- Reference rows produced by the docx normaliser also carry `shortExcerpt`,
-- `supportingActions`, `additionalTesting`, and `clinicalPearl` — where the
-- practitioner's peptide/vaccine/IV vocabulary actually appears in real
-- reference content. The hand-listed scan missed them, and 15 items that
-- a broader scan classifies as `suspected_restricted` were slipping
-- through the pipeline unmarked.
--
-- Fix: cast the whole payload to text and scan that. The vocabulary and
-- the single `suspected_restricted` outcome are unchanged — this is
-- widening WHERE the classifier looks, not what it looks for. Declared
-- authority still cannot be created or downgraded by text.

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

  -- The scan reads the whole payload as text. This is deliberately wider
  -- than the hand-listed field set was — the practitioner's vocabulary
  -- shows up wherever the source material put it, and a scan that ignores
  -- half of a reference row's structured fields ignores half of the
  -- signal. The vocabulary itself is unchanged; the outcome is still the
  -- single `suspected_restricted` flag.
  _text := lower(coalesce(_payload::text, ''));

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
