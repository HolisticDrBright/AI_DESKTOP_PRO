-- Unreleased source candidate: admit the additive program item education fields
-- (program-item-education/1) and the product catalog binding
-- (program-item-catalog-binding/1) into the database copy of the program content
-- contract, and return the authored patient program to the Program Studio.
--
-- Parent assumptions (the candidate is written against exactly these artifacts; a
-- test refuses to run it if either file's digest has moved):
--   20260903200000_synthetic_desktop_programs_inbox.sql
--     sha256 6ba42349af12e2deb2aa163fbca59ea168bababe4017a098ec88314f31a8b26f
--     (clinical_private.synthetic_program_version_detail, replaced below)
--   20260929120000_synthetic_program_assignments.sql
--     sha256 8d6bcac8dfbe5582e7ee63d5f7ed6a5b4466760195f251d10780f08e3fb4a1d8
--     (clinical_private.program_content_valid, replaced below)
-- Not registered in migrations/manifest.json; not applied anywhere. Registration,
-- preserving integration and execution are Codex work after review. No historical
-- migration, ledger, binary, privilege or custody file is changed by this file.
--
-- What it does and does not change:
--   * An artifact without the new fields validates exactly as before and
--     program_consumer_content returns the identical jsonb, so every existing
--     source digest is unchanged.
--   * Education fields are optional on every item kind; a product may carry an
--     optional catalog binding. Unknown keys are still refused at every level.
--   * Admission is syntax, not approval: authorship is a label, a source is a
--     reference, a media slot is an address, a binding is an identity. None is a
--     dose, a clinical claim or a purchase.
--   * The version detail gains `consumerProgram` (JSON null when none is authored),
--     so the Studio can round-trip what it saved instead of overwriting it blind.

create or replace function clinical_private.program_content_valid(_content jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare
 _phase jsonb; _item jsonb; _ids text[]:='{}'; _phase_ids text[]:='{}'; _keys text[]; _product jsonb;
 _catalog jsonb; _ref jsonb; _days numeric; _version numeric;
 _phase_keys text[]:=array['id','title','days','transition','items'];
 _item_keys text[]:=array['id','title','kind','instructions','released'];
 _education_keys text[]:=array['rationale','sources','media','authorship'];
 _product_keys text[]:=array['id','ingredientKeys','dose','purchaseUrl'];
 _catalog_keys text[]:=array['stableId','version','target'];
 _source_keys text[]:=array['title','url'];
 _media_keys text[]:=array['kind','url','caption'];
 -- An explicit https origin with no credentials or port; the same shape the purchase destination already requires.
 _url text:='^https://[A-Za-z0-9._~-]+\.[A-Za-z]{2,}(/[^\s]*)?$';
begin
 if _content is null or jsonb_typeof(_content)<>'array' then return false; end if;
 if jsonb_array_length(_content) not between 1 and 52 then return false; end if;
 if octet_length(_content::text)>262144 then return false; end if;
 for _phase in select value from jsonb_array_elements(_content) loop
  if jsonb_typeof(_phase)<>'object' then return false; end if;
  if not (_phase ?& _phase_keys) then return false; end if;
  if _phase-_phase_keys<>'{}'::jsonb then return false; end if;
  if jsonb_typeof(_phase->'id')<>'string' or _phase->>'id' !~ '^[A-Za-z0-9_.:-]{1,160}$' then return false; end if;
  if jsonb_typeof(_phase->'title')<>'string' or char_length(_phase->>'title') not between 1 and 240 then return false; end if;
  if jsonb_typeof(_phase->'days')<>'number' then return false; end if;
  _days:=(_phase->>'days')::numeric;
  if _days<>floor(_days) or _days not between 1 and 365 then return false; end if;
  if jsonb_typeof(_phase->'transition')<>'string'
   or _phase->>'transition' not in('scheduled','check_in','practitioner') then return false; end if;
  if jsonb_typeof(_phase->'items')<>'array' or jsonb_array_length(_phase->'items')>100 then return false; end if;
  if _phase->>'id'=any(_phase_ids) then return false; end if;
  _phase_ids:=_phase_ids||(_phase->>'id');
  for _item in select value from jsonb_array_elements(_phase->'items') loop
   if jsonb_typeof(_item)<>'object' then return false; end if;
   if not (_item ?& _item_keys) then return false; end if;
   if jsonb_typeof(_item->'id')<>'string' or _item->>'id' !~ '^[A-Za-z0-9_.:-]{1,160}$' then return false; end if;
   if jsonb_typeof(_item->'title')<>'string' or char_length(_item->>'title') not between 1 and 240 then return false; end if;
   if jsonb_typeof(_item->'instructions')<>'string' or char_length(_item->>'instructions')>4000 then return false; end if;
   if jsonb_typeof(_item->'released')<>'boolean' then return false; end if;
   if jsonb_typeof(_item->'kind')<>'string'
    or _item->>'kind' not in('lesson','diet','habit','supplement') then return false; end if;
   if _item->>'id'=any(_ids) then return false; end if;
   _ids:=_ids||(_item->>'id');
   -- Education fields (program-item-education/1): each optional, each checked only when present. A key that is
   -- present with JSON null is wrong, not absent.
   if _item ? 'rationale' then
    if jsonb_typeof(_item->'rationale')<>'string' or char_length(_item->>'rationale')>1000 then return false; end if;
   end if;
   if _item ? 'authorship' then
    if jsonb_typeof(_item->'authorship')<>'string'
     or _item->>'authorship' not in('practitioner_authored','consumer_ai','unreviewed') then return false; end if;
   end if;
   if _item ? 'sources' then
    if jsonb_typeof(_item->'sources')<>'array' or jsonb_array_length(_item->'sources')>10 then return false; end if;
    for _ref in select value from jsonb_array_elements(_item->'sources') loop
     if jsonb_typeof(_ref)<>'object' or not (_ref ?& _source_keys) or _ref-_source_keys<>'{}'::jsonb then return false; end if;
     if jsonb_typeof(_ref->'title')<>'string' or char_length(btrim(_ref->>'title')) not between 1 and 240 then return false; end if;
     if jsonb_typeof(_ref->'url')<>'string' or char_length(_ref->>'url')>2048 or _ref->>'url' !~ _url then return false; end if;
    end loop;
   end if;
   if _item ? 'media' then
    if jsonb_typeof(_item->'media')<>'array' or jsonb_array_length(_item->'media')>5 then return false; end if;
    for _ref in select value from jsonb_array_elements(_item->'media') loop
     if jsonb_typeof(_ref)<>'object' or not (_ref ?& array['kind','url']) or _ref-_media_keys<>'{}'::jsonb then return false; end if;
     if jsonb_typeof(_ref->'kind')<>'string' or _ref->>'kind' not in('video','image') then return false; end if;
     if jsonb_typeof(_ref->'url')<>'string' or char_length(_ref->>'url')>2048 or _ref->>'url' !~ _url then return false; end if;
     if _ref ? 'caption' then
      if jsonb_typeof(_ref->'caption')<>'string' or char_length(_ref->>'caption')>240 then return false; end if;
     end if;
    end loop;
   end if;
   if _item->>'kind'='supplement' then
    -- A supplement without a governed product is not reviewable.
    if not (_item ? 'product') then return false; end if;
    if _item-(_item_keys||_education_keys||array['product'])<>'{}'::jsonb then return false; end if;
    _product:=_item->'product';
    if jsonb_typeof(_product)<>'object' then return false; end if;
    if not (_product ?& _product_keys) then return false; end if;
    if _product-(_product_keys||array['catalog'])<>'{}'::jsonb then return false; end if;
    if jsonb_typeof(_product->'id')<>'string' or _product->>'id' !~ '^[A-Za-z0-9_.:-]{1,160}$' then return false; end if;
    if jsonb_typeof(_product->'dose')<>'string' or char_length(_product->>'dose') not between 1 and 240 then return false; end if;
    if jsonb_typeof(_product->'ingredientKeys')<>'array'
     or jsonb_array_length(_product->'ingredientKeys') not between 1 and 40 then return false; end if;
    -- A purchase destination must be an explicit https origin or explicitly absent.
    -- Syntax is not provider approval; it only stops an unusable value being stored.
    if jsonb_typeof(_product->'purchaseUrl')<>'null' then
     if jsonb_typeof(_product->'purchaseUrl')<>'string' or _product->>'purchaseUrl' !~ _url then return false; end if;
    end if;
    if exists(select 1 from jsonb_array_elements(_product->'ingredientKeys') e where jsonb_typeof(e.value)<>'string') then
     return false; end if;
    select array_agg(lower(btrim(value))) into _keys from jsonb_array_elements_text(_product->'ingredientKeys');
    if _keys is null or array_length(_keys,1)<>jsonb_array_length(_product->'ingredientKeys') then return false; end if;
    if exists(select 1 from unnest(_keys) k where k !~ '^[A-Za-z0-9_.:-]{1,160}$') then return false; end if;
    if array_length(_keys,1)<>(select count(distinct k) from unnest(_keys) k) then return false; end if;
    -- Catalog binding (program-item-catalog-binding/1): the exact governed product, catalog version and service
    -- target the step was authored against. An identity, not an approval; optional, and strict when present.
    if _product ? 'catalog' then
     _catalog:=_product->'catalog';
     if jsonb_typeof(_catalog)<>'object' or not (_catalog ?& _catalog_keys) or _catalog-_catalog_keys<>'{}'::jsonb then return false; end if;
     if jsonb_typeof(_catalog->'stableId')<>'string' or _catalog->>'stableId' !~ '^prd_[a-z0-9][a-z0-9_-]{2,95}$' then return false; end if;
     if jsonb_typeof(_catalog->'version')<>'number' then return false; end if;
     _version:=(_catalog->>'version')::numeric;
     if _version<>floor(_version) or _version not between 1 and 1000000 then return false; end if;
     if jsonb_typeof(_catalog->'target')<>'string'
      or _catalog->>'target' not in('synthetic-staging','production-clinical') then return false; end if;
    end if;
   else
    -- A product on a lesson, a diet step or a habit is a claim nobody approved.
    if _item ? 'product' then return false; end if;
    if _item-(_item_keys||_education_keys)<>'{}'::jsonb then return false; end if;
   end if;
  end loop;
 end loop;
 return true;
end $$;
revoke all on function clinical_private.program_content_valid(jsonb) from public;

-- The Studio reads back the patient program it authored. The key is always present once
-- this candidate is applied: JSON null means "none authored", and an absent key means the
-- service does not yet return it, which the Studio treats as authoring unavailable rather
-- than as permission to overwrite content it cannot see.
create or replace function clinical_private.synthetic_program_version_detail(_version_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id',version_row.id,'version',version_row.version,'status',version_row.status,
    'title',nullif(version_row.content->>'title',''),
    'summary',nullif(version_row.content->>'summary',''),
    'audience',nullif(version_row.content->>'audience',''),
    'disclaimer',nullif(version_row.content->>'disclaimer',''),
    'sourceTemplateId',null,'sourceTemplateVersion',null,
    'supersedesVersionId',version_row.supersedes_version_id,
    'reviewNote',version_row.review_note,'approvedAt',version_row.approved_at,
    'publishedAt',version_row.published_at,'updatedAt',version_row.updated_at,
    'createdAt',version_row.created_at,
    'modules',clinical_private.synthetic_program_modules(version_row.id,version_row.content),
    'consumerProgram',version_row.content->'consumerProgram')
  from clinical_core.synthetic_desktop_program_versions version_row
  where version_row.id = _version_id
$$;
