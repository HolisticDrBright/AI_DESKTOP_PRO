-- Unreleased source candidate. Requires the canonical production schema and
-- fullscript-draft-ledger.sql's private schema, NOT the legacy staging tables.
-- No source approval, provider release, patient or fixture is seeded.
create table fullscript_delivery.protocol_manifests (
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 program_id uuid not null,
 program_version_id uuid not null,
 program_version integer not null check(program_version>0),
 version_content_sha256 text not null check(version_content_sha256~'^[a-f0-9]{64}$'),
 approval_sha256 text not null check(approval_sha256~'^[a-f0-9]{64}$'),
 catalog_source_sha256 text not null check(catalog_source_sha256~'^[a-f0-9]{64}$'),
 status text not null default 'compiled' check(status in ('compiled','superseded')),
 lines jsonb not null check(jsonb_typeof(lines)='array' and jsonb_array_length(lines) between 1 and 400),
 included_count integer not null check(included_count>=0),
 excluded_count integer not null check(excluded_count>=0),
 content_sha256 text not null check(content_sha256~'^[a-f0-9]{64}$'),
 compiled_at timestamptz not null default clock_timestamp(),
 compiled_by_person_id uuid not null references clinical_core.persons(id),
 foreign key(program_id,organization_id) references clinical_core.programs(id,organization_id),
 foreign key(program_version_id,organization_id) references clinical_core.program_versions(id,organization_id),
 unique(program_version_id,approval_sha256,catalog_source_sha256,content_sha256)
);
revoke all on fullscript_delivery.protocol_manifests from public,clinical_core_api,fullscript_draft_worker;
alter table fullscript_delivery.protocol_manifests enable row level security;
alter table fullscript_delivery.protocol_manifests force row level security;
create policy canonical_cart_clinic on fullscript_delivery.protocol_manifests
 using(organization_id=clinical_private.organization_id() and clinical_private.has_clinical_role(organization_id))
 with check(organization_id=clinical_private.organization_id() and clinical_private.has_clinical_role(organization_id));
create function fullscript_delivery.protect_manifest() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and old.status='compiled' and new.status='superseded'
  and (to_jsonb(new)-'status')=(to_jsonb(old)-'status') then return new; end if;
 raise exception 'protocol_cart_immutable';
end $$;
revoke all on function fullscript_delivery.protect_manifest() from public;
create trigger protect_manifest before update or delete on fullscript_delivery.protocol_manifests
 for each row execute function fullscript_delivery.protect_manifest();

-- Dedicated append-only events: no modification of released generic audit
-- action allow-lists and no clinical text or commercial destination in metadata.
create table clinical_audit.protocol_cart_events (
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 manifest_id uuid not null references fullscript_delivery.protocol_manifests(id),
 actor_person_id uuid not null references clinical_core.persons(id),
 action text not null check(action in ('compiled','read','superseded')),
 occurred_at timestamptz not null default clock_timestamp()
);
revoke all on clinical_audit.protocol_cart_events from public,clinical_core_api,fullscript_draft_worker;
alter table clinical_audit.protocol_cart_events enable row level security;
alter table clinical_audit.protocol_cart_events force row level security;
create policy canonical_cart_audit_clinic on clinical_audit.protocol_cart_events
 using(organization_id=clinical_private.organization_id() and clinical_private.has_clinical_role(organization_id))
 with check(organization_id=clinical_private.organization_id() and clinical_private.has_clinical_role(organization_id));
create function fullscript_delivery.protect_cart_audit() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'protocol_cart_audit_immutable'; end $$;
revoke all on function fullscript_delivery.protect_cart_audit() from public;
create trigger protect_cart_audit before update or delete on clinical_audit.protocol_cart_events
 for each row execute function fullscript_delivery.protect_cart_audit();

-- One same-database snapshot; no model query, name/URL matching to products,
-- external catalog, bundled fallback or caller-supplied approval.
create function fullscript_delivery.catalog_source(_content jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(row_data order by stable_id),'[]'::jsonb) from (
  select p.stable_id,jsonb_build_object('productId',p.stable_id,'productStatus',p.review_status,
   'activeVersion',p.active_version,'environment',p.environment,'containsPhi',p.contains_phi,
   'versionId',v.id,'version',v.version,'versionStatus',v.review_status,'productType',v.product_type,
   'accessTier',v.access_tier,'restricted',v.declared_restricted,'directOrderAllowed',v.direct_order_allowed,
   'contentSha256',v.content_sha256,'labelSha256',v.label_sha256,'sourceRefs',v.source_refs,
   'importSucceeded',b.status='succeeded','verificationNote',q.verification_note,'verificationId',q.id,
   'reviewerActive',exists(select 1 from clinical_core.persons person
     join clinical_core.identities i on i.person_id=person.id and i.identity_pool='workforce'
     join clinical_core.organization_memberships m on m.person_id=person.id
     where person.id=q.reviewer_person_id and person.status='active' and i.status='active' and i.production_bound
      and m.organization_id=clinical_private.organization_id() and m.status='active' and m.role in ('owner','admin')),
   'destinations',coalesce((select jsonb_agg(jsonb_build_object('id',ov.id,'url',ov.destination_url,
      'contentSha256',ov.content_sha256) order by ov.id)
    from commercial_reference.affiliate_offers o join commercial_reference.affiliate_offer_versions ov
      on ov.offer_stable_id=o.stable_id and ov.version=o.active_version
    join clinical_reference.catalog_import_batches ob on ob.id=ov.import_batch_id and ob.status='succeeded'
    where o.product_stable_id=p.stable_id and o.review_status='approved' and ov.review_status='approved'
      and ov.environment='production-clinical' and ov.direct_order_allowed and not ov.declared_restricted),'[]'::jsonb)) as row_data
  from clinical_reference.catalog_products p
  join clinical_reference.catalog_product_versions v on v.product_stable_id=p.stable_id and v.version=p.active_version
  join clinical_reference.catalog_import_batches b on b.id=v.import_batch_id
  left join lateral(select * from clinical_reference.product_label_verifications
   where product_version_id=v.id order by verified_at desc,id desc limit 1) q on true
  where p.stable_id in(select item->'product'->>'id'
   from jsonb_array_elements(case when jsonb_typeof(_content->'consumerProgram'->'phases')='array'
    then _content->'consumerProgram'->'phases' else '[]'::jsonb end) phase,
   lateral jsonb_array_elements(case when jsonb_typeof(phase->'items')='array' then phase->'items' else '[]'::jsonb end) item)
 ) source
$$;
revoke all on function fullscript_delivery.catalog_source(jsonb) from public,clinical_core_api;

create function fullscript_delivery.cart_lines(_content jsonb,_catalog jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare p jsonb; i jsonb; product jsonb; c jsonb; proof jsonb; reason text; all_text text;
 lines jsonb:='[]'::jsonb; phases text[]:=array[]::text[]; items text[]:=array[]::text[]; good boolean;
begin
 if jsonb_typeof(_content->'consumerProgram'->'phases') is distinct from 'array'
  or jsonb_array_length(_content->'consumerProgram'->'phases') not between 1 and 52 then
  raise exception 'protocol_cart_program_invalid'; end if;
 for p in select value from jsonb_array_elements(_content->'consumerProgram'->'phases') loop
  if jsonb_typeof(p)<>'object' or jsonb_typeof(p->'id') is distinct from 'string'
   or p->>'id'!~'^[A-Za-z0-9_.:-]{1,160}$' or p->>'id'=any(phases)
   or jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items')>100 then
   raise exception 'protocol_cart_program_invalid'; end if;
  phases:=array_append(phases,p->>'id');
  for i in select value from jsonb_array_elements(p->'items') loop
   if jsonb_typeof(i)<>'object' or jsonb_typeof(i->'id') is distinct from 'string'
    or i->>'id'!~'^[A-Za-z0-9_.:-]{1,160}$' or i->>'id'=any(items)
    or jsonb_typeof(i->'kind') is distinct from 'string' or i->>'kind' not in ('lesson','diet','habit','supplement')
    or jsonb_typeof(i->'released') is distinct from 'boolean' then raise exception 'protocol_cart_program_invalid'; end if;
   items:=array_append(items,i->>'id');
   if i->>'kind'<>'supplement' then continue; end if;
   product:=i->'product';
   if jsonb_typeof(product) is distinct from 'object' or jsonb_typeof(product->'id') is distinct from 'string'
    or product->>'id'!~'^[A-Za-z0-9_.:-]{1,160}$' or jsonb_typeof(product->'dose') is distinct from 'string'
    or length(btrim(product->>'dose')) not between 1 and 240 or jsonb_typeof(i->'title') is distinct from 'string'
    or length(btrim(i->>'title')) not between 1 and 240
    or jsonb_typeof(product->'ingredientKeys') is distinct from 'array'
    or jsonb_array_length(product->'ingredientKeys') not between 1 and 40
    or exists(select 1 from jsonb_array_elements(product->'ingredientKeys') k where jsonb_typeof(k)<>'string'
      or k#>>'{}'!~'^[a-z0-9][a-z0-9_.:-]{0,159}$')
    or (select count(distinct k) from jsonb_array_elements_text(product->'ingredientKeys') k)<>jsonb_array_length(product->'ingredientKeys')
    or jsonb_typeof(product->'purchaseUrl') not in ('string','null') or not(product ? 'purchaseUrl') then
    raise exception 'protocol_cart_program_invalid'; end if;
   if jsonb_typeof(product->'purchaseUrl')='string' and (length(product->>'purchaseUrl')>2048
    or product->>'purchaseUrl'!~'^https://[^/?#@[:space:]]+([/?#]|$)') then raise exception 'protocol_cart_program_invalid'; end if;
   select value into c from jsonb_array_elements(_catalog) where value->>'productId'=product->>'id';
   proof:=null;
   begin proof:=(c->>'verificationNote')::jsonb; exception when invalid_text_representation then proof:=null; end;
   good:=false;
   if jsonb_typeof(proof)='object' and jsonb_typeof(proof->'ingredientKeys')='array'
    and jsonb_typeof(proof->'sourceRefs')='array' then
   good:=coalesce(c->>'productStatus'='approved' and c->>'versionStatus'='approved'
    and c->>'environment'='production-clinical' and c->>'containsPhi'='false' and c->>'importSucceeded'='true'
    and c->>'productType'='supplement' and c->>'accessTier'='open' and c->>'restricted'='false'
    and c->>'directOrderAllowed'='true' and c->>'reviewerActive'='true'
    and proof->>'contract'='production-catalog-ingredient-release/1' and proof->>'sourceVerification'='V'
    and proof->>'completeness'='complete' and proof->>'productId'=c->>'productId'
    and proof->'productVersion'=c->'version' and proof->>'productContentSha256'=c->>'contentSha256'
    and proof->>'labelVersionId'=c->>'versionId' and proof->>'labelSha256'=c->>'labelSha256'
    and (proof->'ingredientKeys') @> (product->'ingredientKeys') and (product->'ingredientKeys') @> (proof->'ingredientKeys')
    and proof-array['contract','productId','productVersion','productContentSha256','labelVersionId','labelSha256',
     'completeness','sourceVerification','ingredientKeys','sourceRefs']='{}'::jsonb
    and jsonb_array_length(proof->'ingredientKeys')=jsonb_array_length(product->'ingredientKeys')
    and jsonb_array_length(proof->'sourceRefs') between 1 and 100
    and not exists(select 1 from jsonb_array_elements(proof->'sourceRefs') s where jsonb_typeof(s)<>'string')
    and (select count(distinct s) from jsonb_array_elements_text(proof->'sourceRefs') s)=jsonb_array_length(proof->'sourceRefs')
    and (c->'sourceRefs') @> (proof->'sourceRefs'),false);
   end if;
   all_text:=lower((product->>'id')||' '||(product->'ingredientKeys')::text||' '||coalesce((proof->'ingredientKeys')::text,''));
   reason:=case when all_text~'(^|[^a-z])(iron|ferrous|ferric|heme|ferritin)([^a-z]|$)' then 'iron_requires_individual_review'
    when all_text~'(pregnan|nursing|lactat|breastfeed|fertil|conception|trimester)' then 'reproductive_requires_individual_review'
    when i->>'released'<>'true' then 'program_step_unreleased'
    when not good then 'catalog_authority_unavailable'
    when not exists(select 1 from jsonb_array_elements(c->'destinations') d where d->>'url'=product->>'purchaseUrl')
     then 'no_purchase_destination' else null end;
   lines:=lines||jsonb_build_object('phaseId',p->>'id','itemId',i->>'id','title',i->>'title',
    'productId',product->>'id','dose',product->>'dose','ingredientKeys',product->'ingredientKeys',
    'purchaseUrl',product->'purchaseUrl','included',reason is null,'exclusionReason',reason);
  end loop;
 end loop;
 if jsonb_array_length(lines) not between 1 and 400 then raise exception 'protocol_cart_no_supplements'; end if;
 return lines;
end $$;
revoke all on function fullscript_delivery.cart_lines(jsonb,jsonb) from public,clinical_core_api;

create function clinical_core.canonical_protocol_cart_workforce(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid:=clinical_private.organization_id(); actor uuid; action text:=_request->>'action'; key_name text;
 v clinical_core.program_versions; program clinical_core.programs; m fullscript_delivery.protocol_manifests;
 catalog jsonb; lines jsonb; source_hash text; lines_hash text; approval_hash text; approver_active boolean;
 included integer; excluded integer; result jsonb;
begin
 actor:=clinical_private.care_connection_actor('workforce','clinical_data');
 key_name:=case action when 'compile' then 'programVersionId' when 'read' then 'manifestId' when 'list' then 'programId' else null end;
 if jsonb_typeof(_request) is distinct from 'object' or key_name is null
  or _request-array['action',key_name]<>'{}'::jsonb or jsonb_typeof(_request->key_name) is distinct from 'string'
  or _request->>key_name!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception 'protocol_cart_invalid'; end if;
 if action='list' then
  select coalesce(jsonb_agg(jsonb_build_object('manifestId',x.id,'programVersionId',x.program_version_id,
   'programVersion',x.program_version,'status',x.status,'includedCount',x.included_count,'excludedCount',x.excluded_count,
   'contentSha256',x.content_sha256,'compiledAt',x.compiled_at) order by x.compiled_at desc,x.id),'[]'::jsonb) into result
   from(select * from fullscript_delivery.protocol_manifests where organization_id=org and program_id=(_request->>'programId')::uuid
    order by compiled_at desc,id limit 200) x;
  return jsonb_build_object('action','list','manifests',result);
 end if;
 if action='read' then
  select * into m from fullscript_delivery.protocol_manifests where id=(_request->>'manifestId')::uuid and organization_id=org;
  if m.id is null then raise exception 'protocol_cart_absent'; end if;
  perform pg_advisory_xact_lock(hashtextextended('canonical-cart:'||org::text||':'||m.program_id::text,0));
  select * into m from fullscript_delivery.protocol_manifests where id=m.id and organization_id=org for update;
  select * into v from clinical_core.program_versions where id=m.program_version_id and organization_id=org for share;
 else
  select * into v from clinical_core.program_versions where id=(_request->>'programVersionId')::uuid and organization_id=org;
  if v.id is null then raise exception 'protocol_cart_absent'; end if;
  perform pg_advisory_xact_lock(hashtextextended('canonical-cart:'||org::text||':'||v.program_id::text,0));
  select * into v from clinical_core.program_versions where id=(_request->>'programVersionId')::uuid and organization_id=org for share;
 end if;
 if v.id is null then raise exception 'protocol_cart_absent'; end if;
 select * into program from clinical_core.programs where id=v.program_id and organization_id=org for share;
 approval_hash:=encode(public.digest(convert_to(jsonb_build_object('approvedBy',v.approved_by_person_id,
  'approvedAt',extract(epoch from v.approved_at),'publishedAt',extract(epoch from v.published_at))::text,'UTF8'),'sha256'),'hex');
 select exists(select 1 from clinical_core.persons person join clinical_core.identities identity
  on identity.person_id=person.id and identity.identity_pool='workforce'
  join clinical_core.organization_memberships membership on membership.person_id=person.id
  where person.id=v.approved_by_person_id and person.status='active' and identity.status='active'
   and identity.production_bound and membership.organization_id=org and membership.status='active'
   and membership.role in ('owner','admin','practitioner')) into approver_active;
 -- Validate bounds before querying catalog rows; this also refuses malformed
 -- program items even when every product would otherwise be withheld.
 perform fullscript_delivery.cart_lines(v.content,'[]'::jsonb);
 catalog:=fullscript_delivery.catalog_source(v.content);
 source_hash:=encode(public.digest(convert_to(catalog::text,'UTF8'),'sha256'),'hex');
 if action='read' then
  if m.status='compiled' and (v.status<>'published' or program.status<>'active' or program.archived_at is not null
   or program.active_version_id is distinct from v.id or v.approved_by_person_id is null or v.approved_at is null
   or not approver_active or m.approval_sha256<>approval_hash
   or v.approved_at>clock_timestamp() or v.published_at is null or v.published_at>clock_timestamp()
   or v.content_sha256 is distinct from m.version_content_sha256
   or m.version_content_sha256 is distinct from encode(public.digest(convert_to(v.content::text,'UTF8'),'sha256'),'hex')
   or m.catalog_source_sha256<>source_hash) then
   update fullscript_delivery.protocol_manifests set status='superseded' where id=m.id; m.status:='superseded';
   insert into clinical_audit.protocol_cart_events(organization_id,manifest_id,actor_person_id,action)
    values(org,m.id,actor,'superseded');
  end if;
  insert into clinical_audit.protocol_cart_events(organization_id,manifest_id,actor_person_id,action)
   values(org,m.id,actor,'read');
  return jsonb_build_object('action','read','manifestId',m.id,'programVersionId',m.program_version_id,
   'programVersion',m.program_version,'status',m.status,'versionContentSha256',m.version_content_sha256,
   'lines',m.lines,'includedCount',m.included_count,'excludedCount',m.excluded_count,'contentSha256',m.content_sha256,
   'delivery',jsonb_build_object('state','not_implemented','detail','no_cart_is_created_at_any_provider'));
 end if;
 if v.status<>'published' or program.status<>'active' or program.archived_at is not null or program.active_version_id is distinct from v.id
  or v.approved_by_person_id is null or v.approved_at is null or v.published_at is null
  or not approver_active
  or v.approved_at>clock_timestamp() or v.published_at>clock_timestamp()
  or v.content_sha256 is distinct from encode(public.digest(convert_to(v.content::text,'UTF8'),'sha256'),'hex') then
  raise exception 'protocol_cart_version_unpublished'; end if;
 lines:=fullscript_delivery.cart_lines(v.content,catalog);
 lines_hash:=encode(public.digest(convert_to(lines::text,'UTF8'),'sha256'),'hex');
 select * into m from fullscript_delivery.protocol_manifests where program_version_id=v.id
  and approval_sha256=approval_hash and catalog_source_sha256=source_hash and content_sha256=lines_hash;
 if m.id is not null then
  if m.status<>'compiled' then raise exception 'protocol_cart_manifest_superseded'; end if;
 else
  select count(*) filter(where (value->>'included')::boolean),count(*) filter(where not(value->>'included')::boolean)
   into included,excluded from jsonb_array_elements(lines);
  insert into fullscript_delivery.protocol_manifests(organization_id,program_id,program_version_id,program_version,
   version_content_sha256,approval_sha256,catalog_source_sha256,lines,included_count,excluded_count,content_sha256,compiled_by_person_id)
   values(org,v.program_id,v.id,v.version,v.content_sha256,approval_hash,source_hash,lines,included,excluded,lines_hash,actor) returning * into m;
  with superseded as (
   update fullscript_delivery.protocol_manifests set status='superseded' where organization_id=org and program_id=v.program_id
    and status='compiled' and id<>m.id returning id
  ) insert into clinical_audit.protocol_cart_events(organization_id,manifest_id,actor_person_id,action)
    select org,id,actor,'superseded' from superseded;
  insert into clinical_audit.protocol_cart_events(organization_id,manifest_id,actor_person_id,action)
   values(org,m.id,actor,'compiled');
  return jsonb_build_object('action','compile','manifestId',m.id,'programVersion',m.program_version,
   'includedCount',m.included_count,'excludedCount',m.excluded_count,'contentSha256',m.content_sha256,'replayed',false);
 end if;
 return jsonb_build_object('action','compile','manifestId',m.id,'programVersion',m.program_version,
  'includedCount',m.included_count,'excludedCount',m.excluded_count,'contentSha256',m.content_sha256,'replayed',true);
end $$;
revoke all on function clinical_core.canonical_protocol_cart_workforce(jsonb) from public;
grant execute on function clinical_core.canonical_protocol_cart_workforce(jsonb) to clinical_core_api;
