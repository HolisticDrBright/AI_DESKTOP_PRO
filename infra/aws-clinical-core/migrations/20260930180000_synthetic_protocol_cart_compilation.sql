-- Compiling a purchasable cart from a published protocol, with the exclusions applied here.
-- Synthetic-only. No real patient data, and nothing here is enabled for production.
--
-- Practice Better publishes a protocol and hands the patient a pre-filled dispensary cart, and
-- that is genuinely the step that gets a protocol actually taken. What it does is copy whatever
-- the protocol names into a basket.
--
-- This compiles instead of copying, and the difference is the whole point.
--
-- FIRST, a cart is compiled from the PUBLISHED version's own stored content, never from
-- anything a caller sends. A request can name a version; it cannot describe one. The version's
-- content digest is recorded on the manifest, so a cart can always be shown to be the cart that
-- protocol produced.
--
-- SECOND, the exclusions are applied at compile time, not at checkout and not by a reviewer
-- remembering. A supplement carrying iron never lands in a cart, because iron dosing depends on
-- a ferritin the cart cannot see. A supplement whose ingredients touch pregnancy, nursing or
-- fertility never lands in a cart for the same reason. Neither is a UI warning: the line is
-- excluded, in SQL, before a manifest exists.
--
-- THIRD, an excluded line is still IN the manifest, with its reason. A product that silently
-- disappears between the protocol and the cart is the failure this shape prevents: the
-- practitioner sees "three of five, and here is why the other two are not here" and can decide
-- about those two individually, which is exactly the decision that should not be automated.
--
-- Nothing here delivers anything. There is no send action, no cart is created at any provider,
-- and no destination is contacted. Compilation and delivery are separate steps and only the
-- first exists; the manifest is what a delivery step would later read.
--
-- A manifest is derived from the practice's own protocol and names no patient, so it is
-- deliberately absent from `care_data_export` and untouched by a patient erasure. There is
-- nothing about a patient in it to export or erase.

create table clinical_core.protocol_cart_manifests(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 program_id uuid not null,
 program_version_id uuid not null,
 program_version integer not null check(program_version>0),
 -- The digest of the published version's content at the moment it was compiled.
 version_content_sha256 text not null check(version_content_sha256 ~ '^[a-f0-9]{64}$'),
 status text not null default 'compiled' check(status in('compiled','superseded')),
 -- Every line the protocol named, included or not, each with its reason.
 lines jsonb not null,
 included_count integer not null check(included_count>=0),
 excluded_count integer not null check(excluded_count>=0),
 content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
 compiled_at timestamptz not null default clock_timestamp(),
 compiled_by_person_id uuid not null references clinical_core.persons(id),
 foreign key (program_version_id,organization_id)
  references clinical_core.synthetic_desktop_program_versions(id,organization_id),
 -- One manifest per published version. Recompiling returns the one that exists.
 unique(program_version_id)
);
create index protocol_cart_manifests_program_idx
 on clinical_core.protocol_cart_manifests(organization_id,program_id,status);

/* A compiled manifest is never rewritten. Superseding it is the only permitted update, because
   an order placed from version 2 has to keep being explainable after version 3 exists. */
create or replace function clinical_private.protect_protocol_cart_manifest() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then
  raise exception using errcode='0A000',message='protocol_cart_immutable'; end if;
 if old.status='compiled' and new.status='superseded'
 and new.lines=old.lines and new.content_sha256=old.content_sha256
 and new.version_content_sha256=old.version_content_sha256
 and new.included_count=old.included_count and new.excluded_count=old.excluded_count
 and new.program_version_id=old.program_version_id
 and new.compiled_at=old.compiled_at then return new; end if;
 raise exception using errcode='0A000',message='protocol_cart_immutable';
end $$;
create trigger protocol_cart_manifests_protect before update or delete
 on clinical_core.protocol_cart_manifests
 for each row execute function clinical_private.protect_protocol_cart_manifest();

/* Why a supplement may not be added to a cart without an individual decision, or null if it may.
   Applied here so that no caller, screen or later delivery step can skip it. */
create or replace function clinical_private.cart_exclusion_reason(_product jsonb)
returns text language plpgsql immutable set search_path='' as $$
declare _text text;
begin
 -- Product id and every ingredient key, together, in one lowercase haystack.
 select lower(coalesce(_product->>'id','')||' '||
  coalesce(string_agg(value,' '),'')) into _text
 from jsonb_array_elements_text(_product->'ingredientKeys');
 -- Iron dosing depends on a ferritin a cart cannot see, so a cart never decides it.
 if _text ~ '(^|[^a-z])(iron|ferrous|ferric|heme|ferritin)([^a-z]|$)' then
  return 'iron_requires_individual_review'; end if;
 -- Pregnancy, nursing and fertility are individual decisions for the same reason.
 if _text ~ '(pregnan|nursing|lactat|breastfeed|fertil|conception|trimester)' then
  return 'reproductive_requires_individual_review'; end if;
 -- No approved destination is not an exclusion about the product; it is a missing address.
 if clinical_private.jsonb_kind(_product->'purchaseUrl')<>'string' then
  return 'no_purchase_destination'; end if;
 return null;
end $$;
revoke all on function clinical_private.cart_exclusion_reason(jsonb) from public;

/* Every supplement line a published version's own content names, in protocol order, with the
   exclusion decision already made. Reads the compiled consumer program rather than the raw
   content, so a version that approved nothing for patients compiles to nothing. */
create or replace function clinical_private.protocol_cart_lines(_version_content jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare _program jsonb; _phase jsonb; _item jsonb; _product jsonb; _reason text; _lines jsonb:='[]'::jsonb;
begin
 _program:=clinical_private.program_consumer_content(_version_content);
 if _program is null then return null; end if;
 for _phase in select value from jsonb_array_elements(_program->'phases') loop
  for _item in select value from jsonb_array_elements(_phase->'items') loop
   if _item->>'kind'='supplement' then
    _product:=_item->'product';
    _reason:=clinical_private.cart_exclusion_reason(_product);
    _lines:=_lines||jsonb_build_object(
     'phaseId',_phase->>'id','itemId',_item->>'id','title',_item->>'title',
     'productId',_product->>'id','dose',_product->>'dose',
     'ingredientKeys',_product->'ingredientKeys','purchaseUrl',_product->'purchaseUrl',
     'included',_reason is null,'exclusionReason',_reason);
   end if;
  end loop;
 end loop;
 return _lines;
end $$;
revoke all on function clinical_private.protocol_cart_lines(jsonb) from public;

/* Compiling a cart, reading one, and listing a program's. There is deliberately no send: this
   function produces the manifest a delivery step would read, and no delivery step exists. */
create or replace function clinical_core.protocol_cart_workforce(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text;
 _version clinical_core.synthetic_desktop_program_versions%rowtype;
 _row clinical_core.protocol_cart_manifests%rowtype;
 _lines jsonb; _included integer; _excluded integer; _items jsonb;
begin
 _actor:=clinical_private.assert_practice_workforce(_org,'protocol_cart_forbidden');
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='protocol_cart_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('compile','read','list') then
  raise exception using errcode='22023',message='protocol_cart_invalid'; end if;

 if _action='list' then
  if _request-array['action','programId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='protocol_cart_invalid'; end if;
  begin
   select coalesce(jsonb_agg(jsonb_build_object('manifestId',m.id,
     'programVersionId',m.program_version_id,'programVersion',m.program_version,
     'status',m.status,'includedCount',m.included_count,'excludedCount',m.excluded_count,
     'contentSha256',m.content_sha256,
     'compiledAt',to_char(m.compiled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
     order by m.program_version desc),'[]'::jsonb) into _items
   from clinical_core.protocol_cart_manifests m
   where m.organization_id=_org and m.program_id=(_request->>'programId')::uuid;
  exception when invalid_text_representation then
   raise exception using errcode='22023',message='protocol_cart_invalid'; end;
  return jsonb_build_object('action','list','manifests',_items);
 end if;

 if _action='read' then
  if _request-array['action','manifestId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='protocol_cart_invalid'; end if;
  begin
   select * into _row from clinical_core.protocol_cart_manifests
    where organization_id=_org and id=(_request->>'manifestId')::uuid;
  exception when invalid_text_representation then
   raise exception using errcode='22023',message='protocol_cart_invalid'; end;
  if _row.id is null then
   raise exception using errcode='P0002',message='protocol_cart_absent'; end if;
  return jsonb_build_object('action','read','manifestId',_row.id,
   'programVersionId',_row.program_version_id,'programVersion',_row.program_version,
   'status',_row.status,'versionContentSha256',_row.version_content_sha256,
   'lines',_row.lines,'includedCount',_row.included_count,
   'excludedCount',_row.excluded_count,'contentSha256',_row.content_sha256,
   -- Stated in the answer, not only in a screen: nothing has been sent anywhere.
   'delivery',jsonb_build_object('state','not_implemented',
    'detail','no_cart_is_created_at_any_provider'));
 end if;

 -- compile
 if _request-array['action','programVersionId']<>'{}'::jsonb then
  raise exception using errcode='22023',message='protocol_cart_invalid'; end if;
 begin
  select * into _version from clinical_core.synthetic_desktop_program_versions
   where organization_id=_org and id=(_request->>'programVersionId')::uuid;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='protocol_cart_invalid'; end;
 if _version.id is null then
  raise exception using errcode='P0002',message='protocol_cart_version_absent'; end if;
 -- Only a published version may be compiled. A draft or an approved-but-unpublished version
 -- has approved nothing for anyone to buy.
 if _version.status<>'published' then
  raise exception using errcode='0A000',message='protocol_cart_version_unpublished'; end if;

 -- Already compiled: return the manifest that exists rather than making a second one. A retry
 -- must not produce a second cart for the same protocol.
 select * into _row from clinical_core.protocol_cart_manifests
  where program_version_id=_version.id;
 if _row.id is not null then
  return jsonb_build_object('action','compile','manifestId',_row.id,
   'programVersion',_row.program_version,'includedCount',_row.included_count,
   'excludedCount',_row.excluded_count,'contentSha256',_row.content_sha256,'replayed',true);
 end if;

 _lines:=clinical_private.protocol_cart_lines(_version.content);
 if _lines is null then
  raise exception using errcode='0A000',message='protocol_cart_version_unpublished'; end if;
 select count(*) filter (where (value->>'included')::boolean),
  count(*) filter (where not (value->>'included')::boolean)
  into _included,_excluded from jsonb_array_elements(_lines);
 if coalesce(_included,0)+coalesce(_excluded,0)=0 then
  raise exception using errcode='P0002',message='protocol_cart_no_supplements'; end if;

 insert into clinical_core.protocol_cart_manifests(organization_id,program_id,program_version_id,
  program_version,version_content_sha256,lines,included_count,excluded_count,content_sha256,
  compiled_by_person_id)
 values(_org,_version.program_id,_version.id,_version.version,
  encode(public.digest(convert_to(_version.content::text,'UTF8'),'sha256'),'hex'),
  _lines,coalesce(_included,0),coalesce(_excluded,0),
  encode(public.digest(convert_to(_lines::text,'UTF8'),'sha256'),'hex'),_actor)
 returning * into _row;
 -- An earlier version's cart is superseded, not deleted: an order placed from it stays
 -- explainable.
 update clinical_core.protocol_cart_manifests set status='superseded'
  where organization_id=_org and program_id=_version.program_id and id<>_row.id
   and status='compiled' and program_version<_row.program_version;
 return jsonb_build_object('action','compile','manifestId',_row.id,
  'programVersion',_row.program_version,'includedCount',_row.included_count,
  'excludedCount',_row.excluded_count,'contentSha256',_row.content_sha256,'replayed',false);
end $$;
revoke all on function clinical_core.protocol_cart_workforce(jsonb) from public;
grant execute on function clinical_core.protocol_cart_workforce(jsonb) to clinical_core_api;
