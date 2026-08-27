-- Repair the bounded URL checks without changing the applied import migration.
-- PostgreSQL regular-expression repetition bounds are intentionally small, so
-- URL length remains a separate scalar constraint.

alter table clinical_reference.product_label_candidates
  drop constraint product_label_candidates_source_url_check;
alter table clinical_reference.product_label_candidates
  add constraint product_label_candidates_source_url_check check (
    source_url ~ '^https://[^[:space:]]+$' and char_length(source_url)<=2000
  );

create or replace function clinical_private.knowledge_import_validation_errors(
  _entity_type text,_payload jsonb
) returns jsonb language plpgsql immutable set search_path='' as $$
declare _errors jsonb:='[]'::jsonb; _content jsonb; _label jsonb; _sources jsonb;
begin
  if _payload::text ~* '"(affiliateUrl|affiliateUrls|destinationUrl|discountCode|trackingCode)"' then
    _errors:=_errors||'["Commercial fields must use the separate governed commercial import"]'::jsonb;
  end if;
  if _entity_type='pathway' then
    _content:=_payload->'content'; _sources:=_payload->'sourceRefs';
    if coalesce(_payload->>'code','') !~ '^[a-z0-9][a-z0-9_-]{1,63}$' then
      _errors:=_errors||'["Pathway code is invalid"]'::jsonb; end if;
    if char_length(btrim(coalesce(_payload->>'name',''))) not between 1 and 200 then
      _errors:=_errors||'["Pathway name is required"]'::jsonb; end if;
    if coalesce(_payload->>'domainCode','') !~ '^[a-z0-9][a-z0-9_-]{1,63}$' then
      _errors:=_errors||'["Pathway domain is invalid"]'::jsonb; end if;
    if jsonb_typeof(_sources)<>'array' or jsonb_array_length(_sources)=0
      or jsonb_array_length(_sources)>100 or octet_length(coalesce(_sources,'[]'::jsonb)::text)>131072 then
      _errors:=_errors||'["At least one bounded pathway source reference is required"]'::jsonb; end if;
    if jsonb_typeof(_content)<>'object' then
      _errors:=_errors||'["Pathway content must be an object"]'::jsonb;
    elsif jsonb_typeof(coalesce(_content->'differentiatingQuestions','[]'::jsonb))<>'array'
      or jsonb_typeof(coalesce(_content->'labStrategy','[]'::jsonb))<>'array'
      or jsonb_typeof(coalesce(_content->'productCandidates','[]'::jsonb))<>'array'
      or jsonb_typeof(coalesce(_content->'nutrition','[]'::jsonb))<>'array'
      or jsonb_typeof(coalesce(_content->'lifestyle','[]'::jsonb))<>'array'
      or jsonb_typeof(coalesce(_content->'safetyStops','[]'::jsonb))<>'array'
      or octet_length(_content::text)>524288 then
      _errors:=_errors||'["Pathway content arrays are invalid or oversized"]'::jsonb;
    end if;
  elsif _entity_type='product_label' then
    _label:=_payload->'exactLabel';
    if coalesce(_payload->>'productCode','') !~ '^[a-z0-9][a-z0-9_-]{2,95}$' then
      _errors:=_errors||'["Product code is invalid"]'::jsonb; end if;
    if char_length(btrim(coalesce(_payload->>'productName',''))) not between 1 and 200 then
      _errors:=_errors||'["Product name is required"]'::jsonb; end if;
    if char_length(btrim(coalesce(_payload->>'brand',''))) not between 1 and 200 then
      _errors:=_errors||'["Product brand is required"]'::jsonb; end if;
    if jsonb_typeof(_label)<>'object' then
      _errors:=_errors||'["Exact product label must be an object"]'::jsonb;
    else
      if coalesce(btrim(_label->>'ingredients'),'')='' then
        _errors:=_errors||'["Ingredient amounts and units are required"]'::jsonb; end if;
      if coalesce(btrim(_label->>'servingSize'),'')='' then
        _errors:=_errors||'["Serving size is required"]'::jsonb; end if;
    end if;
    if left(coalesce(_payload->>'sourceUrl',''),8)<>'https://'
      or char_length(coalesce(_payload->>'sourceUrl','')) not between 9 and 2000
      or _payload->>'sourceUrl' ~ '[[:space:]]' then
      _errors:=_errors||'["Current manufacturer label URL is required"]'::jsonb; end if;
  else
    _errors:=_errors||'["Unsupported import entity type"]'::jsonb;
  end if;
  return _errors;
end $$;
