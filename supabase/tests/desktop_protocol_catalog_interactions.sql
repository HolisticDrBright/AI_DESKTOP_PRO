-- Catalog picker + deterministic interaction review acceptance tests.
-- Rolled back: the project is unchanged after the final statement.
--
-- Covers: anon/public execution revoked · pinned search_path · membership gate
-- on the catalog picker · catalog search returns real products with exact
-- identity · verification status DERIVED from structured data, never asserted
-- by the client · a pinned label version must belong to the pinned product ·
-- manufacturer + label version are the catalog's values, not client text ·
-- the deterministic interaction check runs only with structured data on BOTH
-- sides · it reports "not completed" with a reason otherwise · a completed
-- check that finds nothing never claims the product is interaction-free ·
-- findings surface real ingredient↔medication rows · practitioner review is a
-- separate explicit audited action · review is refused on approved versions ·
-- role refusal · cross-tenant refusal.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v uuid) on commit drop;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000601','ci-practitioner@verify.local'),
  ('11111111-0000-0000-0000-000000000602','ci-staff@verify.local'),
  ('11111111-0000-0000-0000-000000000603','ci-outsider@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000601','Catalog Org','catalog-0060'),
  ('bbbbbbbb-0000-0000-0000-000000000602','Catalog Other','catalog-other-0060');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000601','11111111-0000-0000-0000-000000000601','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000601','11111111-0000-0000-0000-000000000602','staff','active'),
  ('bbbbbbbb-0000-0000-0000-000000000602','11111111-0000-0000-0000-000000000603','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000601','bbbbbbbb-0000-0000-0000-000000000601','Catalog','Patient');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000601','11111111-0000-0000-0000-000000000601','cccccccc-0000-0000-0000-000000000601','active');

-- A catalog with THREE deliberately different levels of data quality.
insert into public.supplement_brands(id,name) values
  ('99999999-0000-0000-0000-000000000601','Structured Labs'),
  ('99999999-0000-0000-0000-000000000602','Label Only Labs');
insert into public.supplement_products(id,brand_id,name,form) values
  -- structured: has ingredient amount rows → a deterministic check is possible
  ('88888888-0000-0000-0000-000000000601','99999999-0000-0000-0000-000000000601',
   'CI Structured Curcumin','capsule'),
  -- label only: a real version row, but no structured ingredients
  ('88888888-0000-0000-0000-000000000602','99999999-0000-0000-0000-000000000602',
   'CI Label Only Blend','powder'),
  -- no version at all
  ('88888888-0000-0000-0000-000000000603',null,'CI Versionless Product','tablet');
insert into public.supplement_product_versions(id,product_id,version_label,serving_size,effective_from) values
  ('77777777-0000-0000-0000-000000000601','88888888-0000-0000-0000-000000000601','LBL-2026-A','1 capsule','2026-01-01'),
  ('77777777-0000-0000-0000-000000000602','88888888-0000-0000-0000-000000000602','LBL-2026-B','1 scoop','2026-01-01');
insert into public.supplement_ingredients(id,canonical_name,category,unit) values
  ('66666666-0000-0000-0000-000000000601','Curcumin','botanical','mg');
insert into public.product_ingredient_amounts(product_version_id,ingredient_id,amount,unit) values
  ('77777777-0000-0000-0000-000000000601','66666666-0000-0000-0000-000000000601',500,'mg');
-- A real interaction row keyed on an RxNorm code.
insert into public.ingredient_interactions
  (ingredient_id,interacts_with_type,interacts_with_ref,severity,mechanism,source,version) values
  ('66666666-0000-0000-0000-000000000601','medication','855332','moderate',
   'CYP-mediated; may potentiate anticoagulant effect','CI fixture','v1');

-- ===================================================================== gates
insert into _v
select 'catalog + interaction RPCs are revoked from anon',
  not bool_or(has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('search_protocol_catalog','check_protocol_interactions',
     'review_protocol_item_interactions');
insert into _v
select 'catalog + interaction RPCs are revoked from public',
  not bool_or(has_function_privilege('public', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('search_protocol_catalog','check_protocol_interactions',
     'review_protocol_item_interactions');
insert into _v
select 'catalog + interaction RPCs are definer with a pinned empty search_path',
  bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='public' and p.proname in
          ('search_protocol_catalog','check_protocol_interactions',
           'review_protocol_item_interactions'))
     or (n.nspname='private' and p.proname='catalog_verification_status');

-- ================================================== catalog search, as a user
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000601","role":"authenticated"}', true);

do $$
declare _c jsonb; _p jsonb;
begin
  _c := public.search_protocol_catalog('bbbbbbbb-0000-0000-0000-000000000601','CI Structured',10);
  _p := (select e from jsonb_array_elements(_c->'products') e
         where e->>'productId' = '88888888-0000-0000-0000-000000000601');
  insert into _v values('catalog search returns the real product with exact identity',
    _p is not null
    and _p->>'manufacturer' = 'Structured Labs'
    and _p->>'labelVersion' = 'LBL-2026-A'
    and _p->>'productVersionId' = '77777777-0000-0000-0000-000000000601',
    coalesce(_p #>> '{}', 'not found'));
  insert into _v values('a product with structured ingredients is structured_verified',
    _p->>'verificationStatus' = 'structured_verified'
    and (_p->>'structuredIngredientCount')::int = 1,
    coalesce(_p #>> '{}', 'not found'));

  _c := public.search_protocol_catalog('bbbbbbbb-0000-0000-0000-000000000601','CI Label Only',10);
  _p := (select e from jsonb_array_elements(_c->'products') e limit 1);
  insert into _v values('a product with a label but no structured ingredients is label_verified',
    _p->>'verificationStatus' = 'label_verified'
    and (_p->>'structuredIngredientCount')::int = 0,
    coalesce(_p #>> '{}', 'not found'));

  _c := public.search_protocol_catalog('bbbbbbbb-0000-0000-0000-000000000601','CI Versionless',10);
  _p := (select e from jsonb_array_elements(_c->'products') e limit 1);
  insert into _v values('a product with no catalog version is unverified',
    _p->>'verificationStatus' = 'unverified' and _p->>'productVersionId' is null,
    coalesce(_p #>> '{}', 'not found'));
  insert into _v values('a missing manufacturer stays null rather than being invented',
    _p ? 'manufacturer' and _p->>'manufacturer' is null,
    coalesce(_p #>> '{}', 'not found'));

  insert into _v values('catalog search is bounded',
    jsonb_array_length(
      public.search_protocol_catalog('bbbbbbbb-0000-0000-0000-000000000601',null,1000)->'products'
    ) <= 50, 'limit clamped');
end $$;

-- ================================================ verification is not client-set
do $$
declare _r jsonb; _item public.protocol_items%rowtype;
begin
  _r := public.create_protocol_draft(
    'bbbbbbbb-0000-0000-0000-000000000601','cccccccc-0000-0000-0000-000000000601',
    'Catalog slice draft', null);
  insert into _ids values('protocol',(_r->>'protocolId')::uuid),
                          ('draft',(_r->>'versionId')::uuid);

  -- The client LIES on every derivable field: it claims structured
  -- verification for a label-only product and sends its own manufacturer and
  -- label version. The server must ignore all three.
  perform public.save_protocol_draft((select v from _ids where k='draft'),
    jsonb_build_object(
      'title','Catalog slice draft',
      'items', jsonb_build_array(jsonb_build_object(
        'kind','product','label','CI Label Only Blend',
        'catalogProductId','88888888-0000-0000-0000-000000000602',
        'catalogProductVersionId','77777777-0000-0000-0000-000000000602',
        'manufacturer','Totally Different Manufacturer',
        'labelVersion','FORGED-9',
        'verificationStatus','structured_verified',
        'dosageText','1 scoop daily','timingText','morning','route','oral',
        'affiliateUrl','https://example.test/affiliate'))),
    null);

  select * into _item from public.protocol_items
   where version_id=(select v from _ids where k='draft') and kind='product';

  insert into _v values('a client cannot assert structured verification',
    _item.verification_status = 'label_verified', _item.verification_status);
  insert into _v values('manufacturer and label version come from the catalog, not the client',
    _item.manufacturer = 'Label Only Labs' and _item.label_version = 'LBL-2026-B',
    coalesce(_item.manufacturer,'null') || ' / ' || coalesce(_item.label_version,'null'));
  insert into _v values('exact catalog identity, dosage, timing and route are persisted',
    _item.catalog_product_id = '88888888-0000-0000-0000-000000000602'
    and _item.catalog_product_version_id = '77777777-0000-0000-0000-000000000602'
    and _item.dosage_text = '1 scoop daily'
    and _item.timing_text = 'morning'
    and _item.route = 'oral', _item.dosage_text);
  insert into _v values('an affiliate link is stored as commercial metadata only',
    _item.affiliate_url = 'https://example.test/affiliate'
    and _item.verification_status <> 'structured_verified'
    and _item.interaction_review_state = 'not_completed',
    _item.interaction_review_state);
  insert into _v values('a saved item always starts with interaction review not completed',
    _item.interaction_review_state = 'not_completed', _item.interaction_review_state);
end $$;

do $$
begin
  -- A label version that belongs to a DIFFERENT product must be refused, not
  -- quietly stored: a mismatched pin would misattribute a label.
  perform public.save_protocol_draft((select v from _ids where k='draft'),
    jsonb_build_object('title','Mismatch','items', jsonb_build_array(jsonb_build_object(
      'kind','product','label','Mismatched pin',
      'catalogProductId','88888888-0000-0000-0000-000000000601',
      'catalogProductVersionId','77777777-0000-0000-0000-000000000602'))),
    null);
  insert into _v values('a label version from another product is refused',false,'no error');
exception when others then
  insert into _v values('a label version from another product is refused',
    sqlstate='P0002', sqlstate);
end $$;

do $$
begin
  perform public.save_protocol_draft((select v from _ids where k='draft'),
    jsonb_build_object('title','Bad id','items', jsonb_build_array(jsonb_build_object(
      'kind','product','label','Ghost product',
      'catalogProductId','88888888-0000-0000-0000-0000000006ff'))),
    null);
  insert into _v values('an unknown catalog product id is refused',false,'no error');
exception when others then
  insert into _v values('an unknown catalog product id is refused', sqlstate='P0002', sqlstate);
end $$;

-- ============================================ interaction check: not completed
do $$
declare _c jsonb; _e jsonb;
begin
  -- Structured product, but the patient has NO medications recorded.
  perform public.save_protocol_draft((select v from _ids where k='draft'),
    jsonb_build_object('title','Structured item','items', jsonb_build_array(jsonb_build_object(
      'kind','product','label','CI Structured Curcumin',
      'catalogProductId','88888888-0000-0000-0000-000000000601',
      'catalogProductVersionId','77777777-0000-0000-0000-000000000601',
      'dosageText','500 mg daily'))),
    null);
  _c := public.check_protocol_interactions((select v from _ids where k='draft'));
  _e := _c->'items'->0;
  insert into _v values('the item is structured_verified once pinned to structured data',
    _e->>'verificationStatus' = 'structured_verified', _e #>> '{}');
  insert into _v values('with no medications recorded the check is not completed',
    _e->>'state' = 'not_completed'
    and _e->>'reason' like '%No active medications%',
    _e #>> '{}');
  insert into _v values('a not-completed check never claims the product is safe',
    _e->>'reason' like '%not evidence that the product is safe%'
    and (_c->>'disclaimer') like '%not a determination that a product is interaction-free%',
    _c->>'disclaimer');
  insert into _v values('a not-completed check reports no findings',
    jsonb_array_length(_e->'findings') = 0, _e->'findings' #>> '{}');
end $$;

-- Uncoded medication → still not a check.
insert into public.medications(organization_id,patient_id,name,dose,status) values
  ('bbbbbbbb-0000-0000-0000-000000000601','cccccccc-0000-0000-0000-000000000601',
   'Uncoded med','5 mg','active');
do $$
declare _c jsonb; _e jsonb;
begin
  _c := public.check_protocol_interactions((select v from _ids where k='draft'));
  _e := _c->'items'->0;
  insert into _v values('an uncoded medication list cannot support a deterministic check',
    _e->>'state' = 'not_completed'
    and _e->>'reason' like '%no coded identifiers%'
    and (_c->>'medicationsRecorded')::int = 1
    and (_c->>'medicationsCoded')::int = 0,
    _e #>> '{}');
end $$;

-- ================================================ interaction check: completed
insert into public.medications(organization_id,patient_id,name,rxnorm,dose,status) values
  ('bbbbbbbb-0000-0000-0000-000000000601','cccccccc-0000-0000-0000-000000000601',
   'Warfarin','855332','5 mg','active');
do $$
declare _c jsonb; _e jsonb; _f jsonb;
begin
  _c := public.check_protocol_interactions((select v from _ids where k='draft'));
  _e := _c->'items'->0;
  insert into _v values('structured data on both sides produces a real check',
    _e->>'state' = 'checked' and _e->>'reason' is null, _e #>> '{}');
  _f := _e->'findings'->0;
  insert into _v values('the finding names the real ingredient, medication and source',
    jsonb_array_length(_e->'findings') = 1
    and _f->>'ingredient' = 'Curcumin'
    and _f->>'medication' = 'Warfarin'
    and _f->>'severity' = 'moderate'
    and _f->>'source' = 'CI fixture',
    coalesce(_f #>> '{}','none'));
  insert into _v values('a completed check still requires practitioner review',
    _e->>'interactionReviewState' = 'not_completed', _e->>'interactionReviewState');
end $$;

-- A structured product with NO matching interaction row: checked, empty, and
-- still not described as interaction-free.
do $$
declare _c jsonb; _e jsonb;
begin
  update public.medications set rxnorm = '999999'
   where patient_id='cccccccc-0000-0000-0000-000000000601' and name='Warfarin';
  _c := public.check_protocol_interactions((select v from _ids where k='draft'));
  _e := _c->'items'->0;
  insert into _v values('a check with no matching rows is checked-and-empty, not "safe"',
    _e->>'state' = 'checked'
    and jsonb_array_length(_e->'findings') = 0
    and (_c->>'disclaimer') like '%only what the checked sources contain%',
    _e #>> '{}');
  update public.medications set rxnorm = '855332'
   where patient_id='cccccccc-0000-0000-0000-000000000601' and name='Warfarin';
end $$;

-- ===================================================== practitioner review act
do $$
declare _item_id uuid; _r jsonb; _before bigint;
begin
  select id into _item_id from public.protocol_items
   where version_id=(select v from _ids where k='draft') and kind='product' limit 1;
  select count(*) into _before from public.audit_events
   where action='protocol.interaction_reviewed';

  _r := public.review_protocol_item_interactions(_item_id,'Coordinated with prescriber.');
  insert into _v values('a practitioner can record an interaction review',
    (_r->>'ok')::boolean and (_r->>'alreadyReviewed')::boolean = false, _r #>> '{}');
  insert into _v values('the review is persisted with reviewer and timestamp',
    (select interaction_review_state='reviewed_by_practitioner'
            and interaction_reviewed_by='11111111-0000-0000-0000-000000000601'
            and interaction_reviewed_at is not null
       from public.protocol_items where id=_item_id), 'persisted');
  insert into _v values('the review writes exactly one audit event',
    (select count(*) from public.audit_events
      where action='protocol.interaction_reviewed') = _before + 1, 'audited');
  insert into _v values('the review note is recorded on the item',
    (select instructions like '%Interaction review: Coordinated with prescriber.%'
       from public.protocol_items where id=_item_id), 'note recorded');

  -- Repeating the action is reported as already done, not double-audited.
  _r := public.review_protocol_item_interactions(_item_id,'again');
  insert into _v values('repeating the review is idempotent and not re-audited',
    (_r->>'alreadyReviewed')::boolean
    and (select count(*) from public.audit_events
          where action='protocol.interaction_reviewed') = _before + 1,
    _r #>> '{}');

  -- The check now reflects the recorded review.
  insert into _v values('the check reports the recorded review state',
    public.check_protocol_interactions((select v from _ids where k='draft'))
      ->'items'->0->>'interactionReviewState' = 'reviewed_by_practitioner',
    'review surfaced');
end $$;

-- ============================================ approved versions are not editable
do $$
declare _item_id uuid;
begin
  perform public.approve_protocol_version((select v from _ids where k='draft'),'ok');
  select id into _item_id from public.protocol_items
   where version_id=(select v from _ids where k='draft') and kind='product' limit 1;
  begin
    perform public.review_protocol_item_interactions(_item_id,'late edit');
    insert into _v values('interaction review is refused on an approved version',false,'no error');
  exception when others then
    insert into _v values('interaction review is refused on an approved version',
      sqlstate='22023', sqlstate);
  end;
end $$;

-- ======================================================== role + tenant refusal
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000602","role":"authenticated"}', true);
do $$
begin
  perform public.check_protocol_interactions((select v from _ids where k='draft'));
  insert into _v values('staff cannot run an interaction check',false,'no error');
exception when others then
  insert into _v values('staff cannot run an interaction check', sqlstate='42501', sqlstate);
end $$;

select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000603","role":"authenticated"}', true);
do $$
begin
  perform public.search_protocol_catalog('bbbbbbbb-0000-0000-0000-000000000601',null,10);
  insert into _v values('a non-member cannot search another org''s catalog picker',
    false,'no error');
exception when others then
  insert into _v values('a non-member cannot search another org''s catalog picker',
    sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.check_protocol_interactions((select v from _ids where k='draft'));
  insert into _v values('cross-tenant interaction check is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant interaction check is refused', sqlstate='42501', sqlstate);
end $$;

select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$
begin
  perform public.search_protocol_catalog('bbbbbbbb-0000-0000-0000-000000000601',null,10);
  insert into _v values('anonymous catalog search is refused',false,'no error');
exception when others then
  insert into _v values('anonymous catalog search is refused', sqlstate='28000', sqlstate);
end $$;
do $$
begin
  perform public.check_protocol_interactions((select v from _ids where k='draft'));
  insert into _v values('anonymous interaction check is refused',false,'no error');
exception when others then
  insert into _v values('anonymous interaction check is refused', sqlstate='28000', sqlstate);
end $$;

select name, passed, detail from _v order by name;
rollback;
