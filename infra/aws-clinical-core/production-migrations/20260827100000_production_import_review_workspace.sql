-- AWS-native governed import-review workspace. Reference-only records are
-- isolated from clinical and commercial records, every mutation is
-- tenant-scoped, and this migration creates no catalog or patient rows.

create table clinical_reference.import_source_files (
  id uuid primary key default public.gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  declared_name text not null check (char_length(btrim(declared_name)) between 1 and 260),
  source_kind text check (source_kind is null or char_length(source_kind) <= 64),
  availability text not null check (availability in ('available','unavailable')),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint check (byte_size is null or byte_size between 0 and 1073741824),
  unavailable_reason text check (unavailable_reason is null or char_length(btrim(unavailable_reason)) between 1 and 2000),
  recorded_by_person_id uuid not null references clinical_core.persons(id),
  recorded_at timestamptz not null default clock_timestamp(),
  data_classification text not null default 'reference_only' check (data_classification='reference_only'),
  contains_phi boolean not null default false check (contains_phi=false),
  check ((availability='available' and content_sha256 is not null and unavailable_reason is null)
    or (availability='unavailable' and content_sha256 is null and unavailable_reason is not null))
);

create table clinical_reference.knowledge_references (
  id uuid primary key default public.gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  version integer not null default 1 check (version > 0),
  claim text not null check (char_length(btrim(claim)) between 1 and 10000),
  reference_type text,
  clinical_domain text,
  structured_claim jsonb not null default '{}'::jsonb check (jsonb_typeof(structured_claim)='object'),
  population text, intervention text, outcome_field text, evidence_grade text,
  citation text, source_kind text, source_version text, publication_date date,
  jurisdiction text,
  limitations text[] not null default '{}'::text[],
  contradictions text[] not null default '{}'::text[],
  restricted_flags text[] not null default '{}'::text[],
  status text not null default 'pending' check (status in ('pending','verified','retired')),
  supersedes_id uuid references clinical_reference.knowledge_references(id),
  review_reason text,
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  verified_by_person_id uuid references clinical_core.persons(id),
  verified_at timestamptz,
  data_classification text not null default 'reference_only' check (data_classification='reference_only'),
  contains_phi boolean not null default false check (contains_phi=false),
  check (status<>'verified' or (verified_at is not null and verified_by_person_id is not null))
);

create table clinical_reference.product_label_records (
  id uuid primary key default public.gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  product_code text not null check (product_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$'),
  version integer not null check (version > 0),
  product_name text not null check (char_length(btrim(product_name)) between 1 and 200),
  brand text not null check (char_length(btrim(brand)) between 1 and 200),
  exact_label jsonb not null check (jsonb_typeof(exact_label)='object' and octet_length(exact_label::text)<=262144),
  label_sha256 text not null check (label_sha256 ~ '^[0-9a-f]{64}$'),
  label_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(label_metadata)='object'),
  status text not null default 'pending' check (status in ('pending','verified','superseded')),
  supersedes_id uuid references clinical_reference.product_label_records(id),
  supersession_reason text,
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  verified_by_person_id uuid references clinical_core.persons(id),
  verified_at timestamptz,
  verification_note text,
  data_classification text not null default 'reference_only' check (data_classification='reference_only'),
  contains_phi boolean not null default false check (contains_phi=false),
  unique (organization_id,product_code,version),
  check (not (exact_label ?| array['affiliateUrl','affiliateUrls','destinationUrl','discountCode','trackingCode'])),
  check (status<>'verified' or (verified_at is not null and verified_by_person_id is not null))
);

create table clinical_reference.restricted_review_decisions (
  id uuid primary key default public.gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  subject_type text not null check (subject_type in ('product','preview_item','knowledge_reference')),
  subject_id text not null check (char_length(subject_id) between 1 and 128),
  outcome text not null check (outcome in ('retain_restricted','request_evidence','defer','reject','clinician_reviewed_for_jurisdiction')),
  reason text not null check (char_length(btrim(reason)) between 1 and 2000),
  jurisdiction text,
  decided_by_person_id uuid not null references clinical_core.persons(id),
  decided_at timestamptz not null default clock_timestamp(),
  data_classification text not null default 'reference_only' check (data_classification='reference_only'),
  contains_phi boolean not null default false check (contains_phi=false),
  check (outcome<>'clinician_reviewed_for_jurisdiction' or char_length(btrim(jurisdiction))>0)
);

create table clinical_reference.warning_resolutions (
  id uuid primary key default public.gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  subject_type text not null check (subject_type in ('product','preview_item','knowledge_reference')),
  subject_id text not null check (char_length(subject_id) between 1 and 128),
  warning_key text not null check (char_length(btrim(warning_key)) between 1 and 200),
  disposition text not null check (disposition in ('resolved','superseded','accepted_risk','not_applicable')),
  reason text not null check (char_length(btrim(reason)) between 1 and 2000),
  decided_by_person_id uuid not null references clinical_core.persons(id),
  decided_at timestamptz not null default clock_timestamp(),
  data_classification text not null default 'reference_only' check (data_classification='reference_only'),
  contains_phi boolean not null default false check (contains_phi=false)
);

create table clinical_reference.catalog_review_actions (
  id uuid primary key default public.gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  product_stable_id text not null references clinical_reference.catalog_products(stable_id),
  action text not null check (action in ('restriction_cleared','review_completed')),
  note text not null check (char_length(btrim(note)) between 10 and 2000),
  actor_person_id uuid not null references clinical_core.persons(id),
  occurred_at timestamptz not null default clock_timestamp(),
  data_classification text not null default 'reference_only' check (data_classification='reference_only'),
  contains_phi boolean not null default false check (contains_phi=false)
);

create table commercial_reference.product_links (
  id uuid primary key default public.gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  label_record_id uuid not null references clinical_reference.product_label_records(id),
  incoming_sku text, incoming_upc text, incoming_manufacturer text, incoming_product_name text,
  destination_url text not null check (destination_url ~ '^https://[^[:space:]]{1,1990}$'),
  discount_code text,
  disclosure text not null check (char_length(btrim(disclosure)) between 1 and 1000),
  match_reason text not null check (char_length(btrim(match_reason)) between 10 and 2000),
  recorded_by_person_id uuid not null references clinical_core.persons(id),
  recorded_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_by_person_id uuid references clinical_core.persons(id),
  revoked_reason text,
  check ((revoked_at is null and revoked_by_person_id is null and revoked_reason is null)
    or (revoked_at is not null and revoked_by_person_id is not null
      and char_length(btrim(revoked_reason)) between 10 and 2000))
);

alter table clinical_core.clinical_knowledge_import_items
  add column org_tag text check (org_tag is null or char_length(btrim(org_tag)) between 1 and 100),
  add column assigned_reviewer_person_id uuid references clinical_core.persons(id),
  add column duplicate_of_item_id uuid references clinical_core.clinical_knowledge_import_items(id),
  add column ambiguity_resolution text check (ambiguity_resolution is null or ambiguity_resolution in ('new_product','same_as_existing','skip')),
  add column ambiguity_note text check (ambiguity_note is null or char_length(btrim(ambiguity_note)) between 10 and 2000),
  add column ambiguity_existing_product_id text references clinical_reference.catalog_products(stable_id);

create index import_source_files_org_idx on clinical_reference.import_source_files(organization_id,recorded_at desc);
create index knowledge_references_org_idx on clinical_reference.knowledge_references(organization_id,created_at desc);
create index product_label_records_org_product_idx on clinical_reference.product_label_records(organization_id,product_code,version desc);
create index restricted_review_decisions_subject_idx on clinical_reference.restricted_review_decisions(organization_id,subject_type,subject_id,decided_at desc);
create index warning_resolutions_subject_idx on clinical_reference.warning_resolutions(organization_id,subject_type,subject_id,decided_at desc);
create index catalog_review_actions_product_idx on clinical_reference.catalog_review_actions(organization_id,product_stable_id,occurred_at desc);
create index product_links_label_idx on commercial_reference.product_links(organization_id,label_record_id,recorded_at desc);

alter table clinical_reference.import_source_files enable row level security;
alter table clinical_reference.knowledge_references enable row level security;
alter table clinical_reference.product_label_records enable row level security;
alter table clinical_reference.restricted_review_decisions enable row level security;
alter table clinical_reference.warning_resolutions enable row level security;
alter table clinical_reference.catalog_review_actions enable row level security;
alter table commercial_reference.product_links enable row level security;

revoke all on clinical_reference.import_source_files,clinical_reference.knowledge_references,
  clinical_reference.product_label_records,clinical_reference.restricted_review_decisions,
  clinical_reference.warning_resolutions,clinical_reference.catalog_review_actions,
  commercial_reference.product_links from public,clinical_core_api;

create trigger import_source_files_append_only before update or delete on clinical_reference.import_source_files
  for each row execute function clinical_reference.reject_immutable_catalog_history();
create trigger restricted_review_decisions_append_only before update or delete on clinical_reference.restricted_review_decisions
  for each row execute function clinical_reference.reject_immutable_catalog_history();
create trigger warning_resolutions_append_only before update or delete on clinical_reference.warning_resolutions
  for each row execute function clinical_reference.reject_immutable_catalog_history();
create trigger catalog_review_actions_append_only before update or delete on clinical_reference.catalog_review_actions
  for each row execute function clinical_reference.reject_immutable_catalog_history();

create or replace function clinical_private.require_import_review_subject(
  _organization_id uuid,_subject_type text,_subject_id text
) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if _subject_type='product' then
    if not exists(select 1 from clinical_reference.catalog_products where stable_id=_subject_id) then
      raise exception using errcode='P0002',message='catalog_product_not_found'; end if;
  elsif _subject_type='preview_item' then
    if not exists(select 1 from clinical_core.clinical_knowledge_import_items
      where id::text=_subject_id and organization_id=_organization_id) then
      raise exception using errcode='P0002',message='import_item_not_found'; end if;
  elsif _subject_type='knowledge_reference' then
    if not exists(select 1 from clinical_reference.knowledge_references
      where id::text=_subject_id and organization_id=_organization_id) then
      raise exception using errcode='P0002',message='knowledge_reference_not_found'; end if;
  else raise exception using errcode='22023',message='subject_type_invalid'; end if;
end $$;

create or replace function clinical_core.invoke_import_review_operation(_operation text,_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _org uuid:=clinical_private.organization_id(); _actor uuid; _id uuid; _id2 uuid;
  _subject_type text; _subject_id text; _status text; _version integer; _rows jsonb;
  _product_id text; _ids uuid[]; _count integer; _payload jsonb; _hash text;
begin
  if _args is null or jsonb_typeof(_args)<>'object' or octet_length(_args::text)>524288 then
    raise exception using errcode='22023',message='import_review_arguments_invalid'; end if;
  if _args ? '_organization_id' and (_args->>'_organization_id')::uuid<>_org then
    raise exception using errcode='42501',message='organization_context_mismatch'; end if;
  _actor:=clinical_private.require_knowledge_editor(_org);

  if _operation='record_import_source_file' then
    insert into clinical_reference.import_source_files(organization_id,declared_name,source_kind,
      availability,content_sha256,byte_size,unavailable_reason,recorded_by_person_id)
    values(_org,btrim(_args->>'_declared_name'),nullif(btrim(_args->>'_source_kind'),''),
      _args->>'_availability',nullif(btrim(_args->>'_content_sha256'),''),
      nullif(_args->>'_byte_size','')::bigint,nullif(btrim(_args->>'_unavailable_reason'),''),_actor)
    returning id into _id;
    return jsonb_build_object('ok',true,'sourceFileId',_id,'availability',_args->>'_availability');
  elsif _operation='get_import_source_inventory' then
    select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'declaredName',s.declared_name,
      'sourceKind',s.source_kind,'availability',s.availability,'contentSha256',s.content_sha256,
      'byteSize',s.byte_size,'unavailableReason',s.unavailable_reason,'recordedAt',s.recorded_at)
      order by s.recorded_at desc),'[]'::jsonb) into _rows
    from clinical_reference.import_source_files s where s.organization_id=_org;
    return jsonb_build_object('sources',_rows,'availableCount',(select count(*) from clinical_reference.import_source_files where organization_id=_org and availability='available'),
      'unavailableCount',(select count(*) from clinical_reference.import_source_files where organization_id=_org and availability='unavailable'));
  elsif _operation='resolve_knowledge_import_ambiguity' then
    _id:=(_args->>'_item_id')::uuid; _status:=_args->>'_resolution';
    if _status not in ('new_product','same_as_existing','skip')
      or char_length(btrim(coalesce(_args->>'_note',''))) not between 10 and 2000 then
      raise exception using errcode='22023',message='ambiguity_resolution_invalid'; end if;
    _product_id:=nullif(_args->>'_existing_product_id','');
    if (_status='same_as_existing')<> (_product_id is not null) then
      raise exception using errcode='22023',message='ambiguity_product_invalid'; end if;
    update clinical_core.clinical_knowledge_import_items set ambiguity_resolution=_status,
      ambiguity_note=btrim(_args->>'_note'),ambiguity_existing_product_id=_product_id,
      status=case when _status='skip' then 'rejected' else status end,
      reviewed_by_person_id=case when _status='skip' then _actor else reviewed_by_person_id end,
      reviewed_at=case when _status='skip' then clock_timestamp() else reviewed_at end
    where id=_id and organization_id=_org and status='needs_review';
    if not found then raise exception using errcode='P0002',message='import_item_not_open'; end if;
    return jsonb_build_object('ok',true,'itemId',_id,'resolution',_status);
  elsif _operation='get_catalog_review_queue' then
    select coalesce(jsonb_agg(jsonb_build_object('id',p.stable_id,'status',p.review_status,
      'activeVersion',p.active_version,'displayName',v.display_name,'brand',v.brand,
      'productType',v.product_type,'accessTier',v.access_tier,'declaredRestricted',v.declared_restricted,
      'directOrderAllowed',v.direct_order_allowed,'labelSha256',v.label_sha256,
      'restrictionCleared',exists(select 1 from clinical_reference.catalog_review_actions a
        where a.organization_id=_org and a.product_stable_id=p.stable_id and a.action='restriction_cleared'))
      order by v.display_name,p.stable_id),'[]'::jsonb) into _rows
    from clinical_reference.catalog_products p left join clinical_reference.catalog_product_versions v
      on v.product_stable_id=p.stable_id and v.version=p.active_version;
    return jsonb_build_object('products',_rows,'generatedAt',clock_timestamp());
  elsif _operation in ('clear_catalog_product_restriction','complete_catalog_product_review') then
    _product_id:=_args->>'_product_id';
    if char_length(btrim(coalesce(_args->>'_note',''))) not between 10 and 2000 then
      raise exception using errcode='22023',message='catalog_review_note_invalid'; end if;
    perform 1 from clinical_reference.catalog_products where stable_id=_product_id for update;
    if not found then raise exception using errcode='P0002',message='catalog_product_not_found'; end if;
    if _operation='complete_catalog_product_review' then
      if not exists(select 1 from clinical_reference.catalog_product_versions v
        join clinical_reference.product_label_verifications q on q.product_version_id=v.id
        where v.product_stable_id=_product_id) then
        raise exception using errcode='55000',message='verified_product_label_required'; end if;
      update clinical_reference.catalog_products set review_status='approved',updated_at=clock_timestamp()
        where stable_id=_product_id;
      _status:='review_completed';
    else _status:='restriction_cleared'; end if;
    insert into clinical_reference.catalog_review_actions(organization_id,product_stable_id,action,note,actor_person_id)
      values(_org,_product_id,_status,btrim(_args->>'_note'),_actor);
    return jsonb_build_object('ok',true,'productId',_product_id,
      'status',case when _status='review_completed' then 'approved' else 'needs_review' end,
      'message',case when _status='review_completed' then 'Catalog review completed' else 'Restriction clearance recorded; clinical approval remains separate' end);
  elsif _operation in ('record_restricted_review_outcome_v2','get_restricted_review_history_v2') then
    _subject_type:=_args->>'_subject_type'; _subject_id:=_args->>'_subject_id';
    perform clinical_private.require_import_review_subject(_org,_subject_type,_subject_id);
    if _operation='record_restricted_review_outcome_v2' then
      _status:=_args->>'_outcome';
      if _status not in ('retain_restricted','request_evidence','defer','reject','clinician_reviewed_for_jurisdiction')
        or char_length(btrim(coalesce(_args->>'_reason',''))) not between 1 and 2000
        or (_status='clinician_reviewed_for_jurisdiction' and coalesce(btrim(_args->>'_jurisdiction'),'')='') then
        raise exception using errcode='22023',message='restricted_review_invalid'; end if;
      insert into clinical_reference.restricted_review_decisions(organization_id,subject_type,subject_id,
        outcome,reason,jurisdiction,decided_by_person_id)
      values(_org,_subject_type,_subject_id,_status,btrim(_args->>'_reason'),nullif(btrim(_args->>'_jurisdiction'),''),_actor)
      returning id into _id;
      return jsonb_build_object('ok',true,'decisionId',_id,'subjectType',_subject_type,
        'subjectId',_subject_id,'outcome',_status,'restrictionsPreserved',true);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'outcome',d.outcome,'reason',d.reason,
      'jurisdiction',d.jurisdiction,'decidedBy',d.decided_by_person_id,'decidedAt',d.decided_at)
      order by d.decided_at desc),'[]'::jsonb) into _rows
    from clinical_reference.restricted_review_decisions d where d.organization_id=_org
      and d.subject_type=_subject_type and d.subject_id=_subject_id;
    return jsonb_build_object('subjectType',_subject_type,'subjectId',_subject_id,'organizationId',_org,
      'currentOutcome',_rows->0->>'outcome','history',_rows);
  elsif _operation in ('create_product_label_draft','supersede_product_label_version') then
    _id2:=nullif(_args->>'_supersedes_id','')::uuid;
    if _id2 is not null then
      select product_code,product_name,brand,version+1 into _product_id,_status,_subject_type,_version
      from clinical_reference.product_label_records where id=_id2 and organization_id=_org for update;
      if not found then raise exception using errcode='P0002',message='product_label_not_found'; end if;
      if char_length(btrim(coalesce(_args->>'_reason',''))) not between 10 and 2000 then
        raise exception using errcode='22023',message='supersession_reason_invalid'; end if;
    else
      _product_id:=_args->>'_product_code'; _status:=_args->>'_product_name';
      _subject_type:=_args->>'_brand';
      select coalesce(max(version),0)+1 into _version from clinical_reference.product_label_records
        where organization_id=_org and product_code=_product_id;
    end if;
    _payload:=_args->'_exact_label';
    if jsonb_typeof(_payload)<>'object' or _payload ?| array['affiliateUrl','affiliateUrls','destinationUrl','discountCode','trackingCode'] then
      raise exception using errcode='22023',message='product_label_invalid'; end if;
    _hash:=encode(public.digest(convert_to(_payload::text,'UTF8'),'sha256'),'hex');
    insert into clinical_reference.product_label_records(organization_id,product_code,version,product_name,
      brand,exact_label,label_sha256,label_metadata,supersedes_id,supersession_reason,created_by_person_id)
    values(_org,_product_id,_version,_status,_subject_type,_payload,_hash,
      jsonb_build_object('sourceUrl',_args->'_source_url','servingSize',_args->'_serving_size',
        'ingredients',coalesce(_args->'_ingredients','[]'::jsonb),'otherIngredients',_args->'_other_ingredients',
        'allergens',_args->'_allergens','contraindications',_args->'_contraindications',
        'warningsText',_args->'_warnings_text','storageInstructions',_args->'_storage_instructions',
        'observedDate',_args->'_observed_date','jurisdiction',_args->'_jurisdiction','labelImageRef',_args->'_label_image_ref'),
      _id2,nullif(btrim(_args->>'_reason'),''),_actor) returning id into _id;
    if _id2 is not null then update clinical_reference.product_label_records set status='superseded' where id=_id2; end if;
    return jsonb_build_object('ok',true,'id',_id,'version',_version,'supersedesId',_id2,'status','pending');
  elsif _operation='verify_product_label_version' then
    _id:=(_args->>'_label_version_id')::uuid;
    update clinical_reference.product_label_records set status='verified',verified_by_person_id=_actor,
      verified_at=clock_timestamp(),verification_note=btrim(_args->>'_verification_note')
    where id=_id and organization_id=_org and status='pending';
    if not found then raise exception using errcode='P0002',message='product_label_not_pending'; end if;
    return jsonb_build_object('ok',true,'id',_id,'status','verified');
  elsif _operation='list_product_label_versions' then
    _product_id:=_args->>'_product_code';
    select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'version',l.version,'productCode',l.product_code,
      'productName',l.product_name,'brand',l.brand,'exactLabel',l.exact_label,'labelSha256',l.label_sha256,
      'metadata',l.label_metadata,'status',l.status,'supersedesId',l.supersedes_id,
      'createdAt',l.created_at,'verifiedAt',l.verified_at,'verificationNote',l.verification_note)
      order by l.version desc),'[]'::jsonb) into _rows from clinical_reference.product_label_records l
      where l.organization_id=_org and l.product_code=_product_id;
    return jsonb_build_object('productCode',_product_id,'organizationId',_org,'versions',_rows);
  elsif _operation in ('create_knowledge_reference_draft','supersede_knowledge_reference') then
    _id2:=nullif(_args->>'_supersedes_id','')::uuid;
    if _id2 is not null then
      select version+1 into _version from clinical_reference.knowledge_references
        where id=_id2 and organization_id=_org for update;
      if not found then raise exception using errcode='P0002',message='knowledge_reference_not_found'; end if;
    else _version:=1; end if;
    insert into clinical_reference.knowledge_references(organization_id,version,claim,reference_type,
      clinical_domain,structured_claim,population,intervention,outcome_field,evidence_grade,citation,
      source_kind,source_version,publication_date,jurisdiction,limitations,contradictions,restricted_flags,
      supersedes_id,review_reason,created_by_person_id)
    values(_org,_version,btrim(coalesce(_args->>'_claim',_args->>'_new_claim')),
      nullif(btrim(_args->>'_reference_type'),''),nullif(btrim(_args->>'_clinical_domain'),''),
      coalesce(_args->'_structured_claim','{}'::jsonb),nullif(btrim(_args->>'_population'),''),
      nullif(btrim(_args->>'_intervention'),''),nullif(btrim(_args->>'_outcome_field'),''),
      nullif(btrim(_args->>'_evidence_grade'),''),nullif(btrim(_args->>'_citation'),''),
      nullif(btrim(_args->>'_source_kind'),''),nullif(btrim(_args->>'_source_version'),''),
      nullif(_args->>'_publication_date','')::date,nullif(btrim(_args->>'_jurisdiction'),''),
      coalesce(array(select jsonb_array_elements_text(coalesce(_args->'_limitations','[]'::jsonb))),'{}'::text[]),
      coalesce(array(select jsonb_array_elements_text(coalesce(_args->'_contradictions','[]'::jsonb))),'{}'::text[]),
      coalesce(array(select jsonb_array_elements_text(coalesce(_args->'_restricted_flags','[]'::jsonb))),'{}'::text[]),
      _id2,nullif(btrim(_args->>'_reason'),''),_actor) returning id into _id;
    if _id2 is not null then update clinical_reference.knowledge_references set status='retired' where id=_id2; end if;
    return jsonb_build_object('ok',true,'id',_id,'version',_version,'status','pending','supersedesId',_id2);
  elsif _operation='approve_knowledge_reference' then
    _id:=(_args->>'_reference_id')::uuid;
    if char_length(btrim(coalesce(_args->>'_verification_reason',''))) not between 10 and 2000 then
      raise exception using errcode='22023',message='verification_reason_invalid'; end if;
    update clinical_reference.knowledge_references set status='verified',verified_by_person_id=_actor,
      verified_at=clock_timestamp(),review_reason=btrim(_args->>'_verification_reason')
      where id=_id and organization_id=_org and status='pending';
    if not found then raise exception using errcode='P0002',message='knowledge_reference_not_pending'; end if;
    return jsonb_build_object('ok',true,'id',_id,'status','verified');
  elsif _operation='list_knowledge_references' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc),'[]'::jsonb) into _rows
      from clinical_reference.knowledge_references r where r.organization_id=_org;
    return jsonb_build_object('organizationId',_org,'references',_rows);
  elsif _operation='attach_commercial_link_to_verified_product' then
    _id2:=(_args->>'_label_version_id')::uuid;
    if not exists(select 1 from clinical_reference.product_label_records where id=_id2 and organization_id=_org and status='verified') then
      raise exception using errcode='55000',message='verified_product_label_required'; end if;
    insert into commercial_reference.product_links(organization_id,label_record_id,incoming_sku,incoming_upc,
      incoming_manufacturer,incoming_product_name,destination_url,discount_code,disclosure,match_reason,recorded_by_person_id)
    values(_org,_id2,nullif(btrim(_args->>'_incoming_sku'),''),nullif(btrim(_args->>'_incoming_upc'),''),
      nullif(btrim(_args->>'_incoming_manufacturer'),''),nullif(btrim(_args->>'_incoming_product_name'),''),
      _args->>'_affiliate_url',nullif(btrim(_args->>'_discount_code'),''),btrim(_args->>'_disclosure'),
      btrim(_args->>'_match_reason'),_actor) returning id into _id;
    return jsonb_build_object('ok',true,'linkId',_id,'labelVersionId',_id2,'clinicalDataUnchanged',true);
  elsif _operation='revoke_commercial_link' then
    _id:=(_args->>'_link_id')::uuid;
    if char_length(btrim(coalesce(_args->>'_reason',''))) not between 10 and 2000 then
      raise exception using errcode='22023',message='revocation_reason_invalid'; end if;
    update commercial_reference.product_links set revoked_at=clock_timestamp(),revoked_by_person_id=_actor,
      revoked_reason=btrim(_args->>'_reason') where id=_id and organization_id=_org and revoked_at is null;
    if not found then raise exception using errcode='P0002',message='commercial_link_not_active'; end if;
    return jsonb_build_object('ok',true,'linkId',_id,'revoked',true);
  elsif _operation in ('record_warning_resolution','list_warning_resolutions') then
    _subject_type:=_args->>'_subject_type'; _subject_id:=_args->>'_subject_id';
    perform clinical_private.require_import_review_subject(_org,_subject_type,_subject_id);
    if _operation='record_warning_resolution' then
      _status:=_args->>'_disposition';
      if _status not in ('resolved','superseded','accepted_risk','not_applicable')
        or coalesce(btrim(_args->>'_warning_key'),'')='' or coalesce(btrim(_args->>'_reason'),'')='' then
        raise exception using errcode='22023',message='warning_resolution_invalid'; end if;
      insert into clinical_reference.warning_resolutions(organization_id,subject_type,subject_id,warning_key,
        disposition,reason,decided_by_person_id) values(_org,_subject_type,_subject_id,btrim(_args->>'_warning_key'),
        _status,btrim(_args->>'_reason'),_actor) returning id into _id;
      return jsonb_build_object('ok',true,'id',_id,'subjectType',_subject_type,'disposition',_status);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'warningKey',r.warning_key,'disposition',r.disposition,
      'reason',r.reason,'decidedBy',r.decided_by_person_id,'decidedAt',r.decided_at)
      order by r.decided_at desc),'[]'::jsonb) into _rows from clinical_reference.warning_resolutions r
      where r.organization_id=_org and r.subject_type=_subject_type and r.subject_id=_subject_id;
    return jsonb_build_object('subjectType',_subject_type,'subjectId',_subject_id,'resolutions',_rows);
  elsif _operation in ('bulk_apply_org_tag','bulk_assign_reviewer','bulk_mark_duplicate') then
    select array_agg(value::text::uuid) into _ids from jsonb_array_elements_text(_args->'_item_ids');
    if cardinality(_ids) not between 1 and 100 or char_length(btrim(coalesce(_args->>'_reason',''))) not between 10 and 2000 then
      raise exception using errcode='22023',message='bulk_review_invalid'; end if;
    if _operation='bulk_apply_org_tag' then
      update clinical_core.clinical_knowledge_import_items set org_tag=btrim(_args->>'_tag')
        where organization_id=_org and id=any(_ids); get diagnostics _count=row_count;
    elsif _operation='bulk_assign_reviewer' then
      _id:=(_args->>'_assignee')::uuid;
      if not exists(select 1 from clinical_core.organization_memberships where organization_id=_org and person_id=_id and status='active') then
        raise exception using errcode='42501',message='reviewer_not_active_member'; end if;
      update clinical_core.clinical_knowledge_import_items set assigned_reviewer_person_id=_id
        where organization_id=_org and id=any(_ids); get diagnostics _count=row_count;
    else
      _id:=(_args->>'_duplicate_of_item_id')::uuid;
      if not exists(select 1 from clinical_core.clinical_knowledge_import_items where organization_id=_org and id=_id) then
        raise exception using errcode='P0002',message='duplicate_target_not_found'; end if;
      update clinical_core.clinical_knowledge_import_items set duplicate_of_item_id=_id
        where organization_id=_org and id=any(_ids) and id<>_id; get diagnostics _count=row_count;
    end if;
    if _count<>cardinality(_ids) then raise exception using errcode='P0002',message='bulk_review_item_not_found'; end if;
    return jsonb_build_object('ok',true,'updatedCount',_count,'operation',_operation);
  elsif _operation='get_restricted_review_queue' then
    select coalesce(jsonb_agg(jsonb_build_object('subjectType','preview_item','subjectId',i.id,
      'displayName',i.display_name,'restrictedFlags',b.source_restricted_flags,'status',i.status,
      'latestOutcome',(select d.outcome from clinical_reference.restricted_review_decisions d
        where d.organization_id=_org and d.subject_type='preview_item' and d.subject_id=i.id::text
        order by d.decided_at desc limit 1)) order by i.created_at),'[]'::jsonb) into _rows
    from clinical_core.clinical_knowledge_import_items i join clinical_core.clinical_knowledge_import_batches b
      on b.id=i.batch_id where i.organization_id=_org and cardinality(b.source_restricted_flags)>0;
    return jsonb_build_object('items',_rows,'generatedAt',clock_timestamp());
  elsif _operation='get_import_provenance' then
    return jsonb_build_object('entries',coalesce((select jsonb_agg(jsonb_build_object('batchId',b.id,
      'sourceName',b.source_name,'sourceRevision',b.source_revision,'sourceSha256',b.source_sha256,
      'status',b.status,'itemCount',b.item_count,'createdAt',b.created_at) order by b.created_at desc)
      from (select * from clinical_core.clinical_knowledge_import_batches where organization_id=_org
        order by created_at desc limit least(greatest(coalesce(nullif(_args->>'_limit','')::integer,50),1),200)) b),'[]'::jsonb));
  else raise exception using errcode='0A000',message='import_review_operation_refused';
  end if;
end $$;

revoke all on function clinical_private.require_import_review_subject(uuid,text,text) from public;
revoke all on function clinical_core.invoke_import_review_operation(text,jsonb) from public;
grant execute on function clinical_core.invoke_import_review_operation(text,jsonb) to clinical_core_api;
