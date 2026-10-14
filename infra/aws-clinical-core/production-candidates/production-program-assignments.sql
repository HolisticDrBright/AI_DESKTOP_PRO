-- Unreleased production candidate: program assignment as a service for the
-- production-clinical target, DISABLED by default.
--
-- The deployed synthetic service (migrations/20260929120000_synthetic_program_assignments.sql)
-- refuses outside synthetic-staging/synthetic_only, and the Desktop adapter
-- (src/server/clinical-core/program-assignments.ts) keeps that guard. This file is the
-- separate production family: the same consumer contract (src/contracts/programAssignments.ts,
-- mirrored in V2) over the production tables, with every authority re-checked here.
--
-- Parent assumptions: the 106-migration production artifact built by
-- scripts/build-aws-production-clinical-core.mjs, then the two lab candidates beside this file
-- (lab-result-transfer-v2.sql and lab-observation-attestation.sql, in that order: the lab-aware review below
-- reads clinical_private.lab_observation_verified) (clinical_core.program_versions,
-- patient_connections, identities, persons, organizations, owned_consumer_record_versions,
-- owned_consumer_active_plans, consumer_storage_consents, clinical_reference catalog tables,
-- clinical_private.set_request_context/claim/actor_person_id/organization_id/has_clinical_role/
-- owned_consumer_consent/owned_active_plan_json/block_update_delete). Not registered in any
-- manifest; applied nowhere. Registration, preserving integration, the activation row and
-- execution are Codex work after review. No historical migration, ledger, binary, privilege,
-- IAM or custody file is changed by this file. No policy is decided here: the activation row
-- below is disabled and only a separately reviewed change may enable it.
--
-- Authority, in order, for every request:
--   1. activation: clinical_core.production_program_activation.enabled, else production_program_disabled;
--   2. actor: a production-bound, active identity in the claimed pool whose subject matches the
--      claims, in an active organization, with a clinical role for workforce actions;
--   3. consent: a consumer action requires a granted protocols_supplements storage consent;
--   4. connection: the assignment's connection is verified, in this organization, bound to this
--      consumer, with an active patient record (a replaced or revoked connection refuses);
--   5. content: only a PUBLISHED version in the caller's organization whose consumerProgram
--      compiles; the artifact is pinned by digest at assignment and re-checked on every mutation;
--   6. revision: every mutation names the revision it saw; a stale one refuses; a replayed accept
--      is reported as duplicate, never applied twice;
--   7. clinical holds: a supplement step is held unless the owner's adopted plan inventory is
--      complete from verified ingredient releases, and a phase with a held or conflicting step
--      does not advance;
--   8. lab holds (program-lab-review/1): before a supplement step is declared available, the
--      service reads the owner's own saved results itself (their personal lab history under its
--      lab_history consent, and the clinic's readings for the enrolled patient record) and holds the
--      step for clinician review when a reading is above its own printed range, when readings
--      disagree, or, for iron, when no current VERIFIED iron-status result shows it is not high.
--      Only a reviewer's current attestation verifies a reading; a personal copy never does. The
--      review names each lab hold (labHolds) and its plan revision binds the readings it saw, so an
--      accept made against an older view of the results is refused as stale. Nothing releases a lab
--      hold here: that is a clinician's decision, recorded nowhere in this file yet. The device's own
--      rule is a second safeguard, never the authority.
-- The consumer's Core entitlement is not known to this database; the adapter in front of it
-- (production-program-assignments.ts) verifies it against the billing service before any
-- consumer action reaches here.

create table clinical_core.production_program_activation(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
 reviewed_by text check(reviewed_by is null or char_length(btrim(reviewed_by)) between 1 and 200),
 reviewed_at timestamptz,
 updated_at timestamptz not null default clock_timestamp(),
 check(not enabled or (evidence_sha256 is not null and reviewed_by is not null and reviewed_at is not null))
);
insert into clinical_core.production_program_activation(singleton,enabled) values(true,false);
alter table clinical_core.production_program_activation enable row level security;
alter table clinical_core.production_program_activation force row level security;
-- The API role can read the switch through the request function only; it can never flip it.
revoke all on clinical_core.production_program_activation from public,clinical_core_api;

create table clinical_core.program_assignments(
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 connection_id uuid not null references clinical_core.patient_connections(id),
 consumer_person_id uuid not null references clinical_core.persons(id),
 program_version_id uuid not null,
 assigned_by uuid not null references clinical_core.persons(id),
 title text not null check(char_length(btrim(title)) between 1 and 240),
 content jsonb not null,
 source_digest text not null check(source_digest ~ '^[a-f0-9]{64}$'),
 state text not null default 'offered' check(state in('offered','active','paused','withdrawn')),
 revision bigint not null default 1 check(revision>0),
 phase_index integer not null default 0 check(phase_index>=0),
 started_at timestamptz, phase_started_at timestamptz,
 finished boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 foreign key (program_version_id, organization_id) references clinical_core.program_versions(id, organization_id),
 unique(connection_id, program_version_id),
 check (state in('offered','withdrawn') or (started_at is not null and phase_started_at is not null)),
 check (not finished or state='active')
);
create index program_assignments_connection on clinical_core.program_assignments(connection_id,created_at desc);
create table clinical_core.program_assignment_completions(
 assignment_id uuid not null references clinical_core.program_assignments(id),
 item_id text not null check(item_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 completed_at timestamptz not null default clock_timestamp(),
 primary key(assignment_id,item_id)
);
create table clinical_core.program_phase_authorizations(
 assignment_id uuid not null references clinical_core.program_assignments(id),
 phase_id text not null check(phase_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 kind text not null check(kind in('consumer_check_in','practitioner_release')),
 recorded_by uuid not null references clinical_core.persons(id),
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(assignment_id,phase_id,kind)
);
create table clinical_core.program_assignment_audit(
 id uuid primary key default public.gen_random_uuid(),
 actor_id uuid not null references clinical_core.persons(id),
 organization_id uuid not null references clinical_core.organizations(id),
 assignment_id uuid references clinical_core.program_assignments(id),
 action text not null check(action in('list','read','assign','accept','complete','check_in','release','advance','pause','resume','withdraw','status')),
 occurred_at timestamptz not null default clock_timestamp()
);
alter table clinical_core.program_assignments enable row level security;
alter table clinical_core.program_assignment_completions enable row level security;
alter table clinical_core.program_phase_authorizations enable row level security;
alter table clinical_core.program_assignment_audit enable row level security;
revoke all on clinical_core.program_assignments,clinical_core.program_assignment_completions,
 clinical_core.program_phase_authorizations,clinical_core.program_assignment_audit from public,clinical_core_api;

create function clinical_private.block_production_program_assignment_content_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.content is distinct from old.content or new.source_digest is distinct from old.source_digest
 or new.organization_id is distinct from old.organization_id or new.connection_id is distinct from old.connection_id
 or new.consumer_person_id is distinct from old.consumer_person_id
 or new.program_version_id is distinct from old.program_version_id or new.title is distinct from old.title
 or new.assigned_by is distinct from old.assigned_by or new.created_at is distinct from old.created_at
 or new.revision<=old.revision then
  raise exception using errcode='42501',message='program_assignment_immutable'; end if;
 return new;
end $$;
revoke all on function clinical_private.block_production_program_assignment_content_change() from public;
create trigger program_assignment_content_immutable before update on clinical_core.program_assignments
 for each row execute function clinical_private.block_production_program_assignment_content_change();
create trigger program_assignment_completions_immutable before update or delete on clinical_core.program_assignment_completions
 for each row execute function clinical_private.block_update_delete();
create trigger program_phase_authorizations_immutable before update or delete on clinical_core.program_phase_authorizations
 for each row execute function clinical_private.block_update_delete();
create trigger program_assignment_audit_immutable before update or delete on clinical_core.program_assignment_audit
 for each row execute function clinical_private.block_update_delete();
create trigger production_program_activation_append_only before delete on clinical_core.production_program_activation
 for each row execute function clinical_private.block_update_delete();

-- The consumer contract, enforced where it cannot be bypassed. Same body as the synthetic
-- admission candidate (source-candidates/program-education-catalog-admission.sql): base
-- fields, the optional education fields and the optional product catalog binding.
create function clinical_private.production_program_content_valid(_content jsonb) returns boolean
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
    if jsonb_typeof(_product->'purchaseUrl')<>'null' then
     if jsonb_typeof(_product->'purchaseUrl')<>'string' or _product->>'purchaseUrl' !~ _url then return false; end if;
    end if;
    if exists(select 1 from jsonb_array_elements(_product->'ingredientKeys') e where jsonb_typeof(e.value)<>'string') then
     return false; end if;
    select array_agg(lower(btrim(value))) into _keys from jsonb_array_elements_text(_product->'ingredientKeys');
    if _keys is null or array_length(_keys,1)<>jsonb_array_length(_product->'ingredientKeys') then return false; end if;
    if exists(select 1 from unnest(_keys) k where k !~ '^[A-Za-z0-9_.:-]{1,160}$') then return false; end if;
    if array_length(_keys,1)<>(select count(distinct k) from unnest(_keys) k) then return false; end if;
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
    if _item ? 'product' then return false; end if;
    if _item-(_item_keys||_education_keys)<>'{}'::jsonb then return false; end if;
   end if;
  end loop;
 end loop;
 return true;
end $$;
revoke all on function clinical_private.production_program_content_valid(jsonb) from public;

create function clinical_private.production_program_consumer_content(_version_content jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare _program jsonb; _keys text[]:=array['title','phases'];
begin
 if _version_content is null or jsonb_typeof(_version_content)<>'object' then return null; end if;
 if not (_version_content ? 'consumerProgram') then return null; end if;
 _program:=_version_content->'consumerProgram';
 if jsonb_typeof(_program)<>'object' then return null; end if;
 if not (_program ?& _keys) then return null; end if;
 if _program-_keys<>'{}'::jsonb then return null; end if;
 if jsonb_typeof(_program->'title')<>'string' then return null; end if;
 if char_length(btrim(_program->>'title')) not between 1 and 240 then return null; end if;
 if not clinical_private.production_program_content_valid(_program->'phases') then return null; end if;
 return jsonb_build_object('title',btrim(_program->>'title'),'phases',_program->'phases');
end $$;
revoke all on function clinical_private.production_program_consumer_content(jsonb) from public;

-- A verification note that is a complete, V-verified ingredient release for exactly this
-- product version; anything else is null, and null is "unverified", never "no ingredients".
create function clinical_private.production_program_release_note(_note text,_version clinical_reference.catalog_product_versions) returns jsonb
language plpgsql immutable set search_path='' as $$
declare _release jsonb;
begin
 begin _release:=_note::jsonb; exception when others then return null; end;
 if jsonb_typeof(_release)<>'object'
 or _release->>'contract' is distinct from 'production-catalog-ingredient-release/1'
 or _release->>'completeness' is distinct from 'complete' or _release->>'sourceVerification' is distinct from 'V'
 or _release->>'productId' is distinct from _version.product_stable_id
 or _release->'productVersion' is distinct from to_jsonb(_version.version)
 or _release->>'productContentSha256' is distinct from _version.content_sha256
 or _release->>'labelVersionId' is distinct from _version.id::text
 or _release->>'labelSha256' is distinct from _version.label_sha256
 or jsonb_typeof(_release->'ingredientKeys')<>'array' or jsonb_array_length(_release->'ingredientKeys') not between 1 and 40 then
  return null; end if;
 return _release;
end $$;
revoke all on function clinical_private.production_program_release_note(text,clinical_reference.catalog_product_versions) from public;

-- What the owner is already taking, as this target can answer it: the adopted active plan's
-- active supplement entries, each resolved to a verified ingredient release of the governed
-- product it names. Any entry that cannot be resolved makes the inventory incomplete, which
-- holds every program supplement step. Unknown is not "no overlap".
create function clinical_private.production_program_plan_inventory(_owner uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _plan jsonb; _consent integer; _record jsonb; _entry jsonb; _product jsonb; _version clinical_reference.catalog_product_versions;
 _release jsonb; _products jsonb:='[]'::jsonb; _reason text; _revision text;
begin
 if _owner is null then
  return jsonb_build_object('revision','none','products','[]'::jsonb,'inventoryComplete',false,'incompleteReason','plan_not_adopted'); end if;
 _consent:=clinical_private.owned_consumer_consent(_owner,'protocols_supplements');
 _plan:=clinical_private.owned_active_plan_json(_owner)->'current';
 if _plan is null or _plan='null'::jsonb then
  return jsonb_build_object('revision','none','products','[]'::jsonb,'inventoryComplete',false,'incompleteReason','plan_not_adopted'); end if;
 _revision:=(_plan->>'recordId')||':'||(_plan->>'revision')||':'||(_plan->>'contentSha256')||':'||coalesce(_consent::text,'none');
 if _consent is null then
  return jsonb_build_object('revision',_revision,'products','[]'::jsonb,'inventoryComplete',false,'incompleteReason','consent_changed'); end if;
 select v.payload into _record from clinical_core.owned_consumer_record_versions v
 where v.owner_id=_owner and v.collection='protocols' and v.record_id=(_plan->>'recordId')::uuid
  and v.revision=(_plan->>'revision')::integer and not v.deleted;
 if _record is null then
  return jsonb_build_object('revision',_revision,'products','[]'::jsonb,'inventoryComplete',false,'incompleteReason','plan_changed'); end if;
 if jsonb_typeof(_record->'supplements_json')<>'array' then
  return jsonb_build_object('revision',_revision,'products','[]'::jsonb,'inventoryComplete',false,'incompleteReason','plan_shape_unknown'); end if;
 for _entry in select value from jsonb_array_elements(_record->'supplements_json') loop
  if jsonb_typeof(_entry)<>'object' or _entry->>'status' is distinct from 'active' then continue; end if;
  _product:=_entry->'governedProduct';
  if jsonb_typeof(_product)<>'object' or jsonb_typeof(_product->'productId')<>'string' then _reason:=coalesce(_reason,'product_identity_missing'); continue; end if;
  if jsonb_typeof(_entry->'dose')<>'string' or char_length(btrim(_entry->>'dose')) not between 1 and 240 then _reason:=coalesce(_reason,'dose_unknown'); continue; end if;
  select v.* into _version from clinical_reference.catalog_products p
  join clinical_reference.catalog_product_versions v on v.product_stable_id=p.stable_id and v.version=p.active_version
  where p.stable_id=_product->>'productId' and p.review_status='approved' and v.review_status='approved'
   and p.environment='production-clinical' and p.contains_phi=false and v.label_sha256 is not null;
  _release:=null;
  if _version.id is not null then
   select clinical_private.production_program_release_note(q.verification_note,_version) into _release
   from clinical_reference.product_label_verifications q where q.product_version_id=_version.id
   order by q.verified_at desc,q.id desc limit 1;
  end if;
  if _release is null then _reason:=coalesce(_reason,'ingredients_unverified'); continue; end if;
  _products:=_products||jsonb_build_array(jsonb_build_object('productId',_product->>'productId',
   'ingredientKeys',_release->'ingredientKeys','dose',btrim(_entry->>'dose')));
 end loop;
 return jsonb_build_object('revision',_revision,'products',_products,'inventoryComplete',_reason is null,'incompleteReason',_reason);
end $$;
revoke all on function clinical_private.production_program_plan_inventory(uuid) from public;

-- Where a reading stands against its OWN printed range, and nothing else: no functional target, no
-- population range, no recalled source. A lower bound alone cannot show a result is not high, so a
-- value at or above it is 'unknown' here (stricter than the device, which reads it as within).
create function clinical_private.production_program_lab_direction(_value numeric,_low numeric,_high numeric) returns text
language sql immutable set search_path='' as $$
 select case
  when _value is null then 'unknown'
  when _low is not null and _high is not null then case when _high<=_low then 'unknown'
   when _value<_low then 'below' when _value>_high then 'above' else 'within' end
  when _high is not null then case when _value>_high then 'above' else 'within' end
  when _low is not null then case when _value<_low then 'below' else 'unknown' end
  else 'unknown' end
$$;

create function clinical_private.production_program_try_timestamptz(_value text) returns timestamptz
language plpgsql immutable set search_path='' as $$
begin return _value::timestamptz; exception when others then return null; end $$;

-- The owner's saved readings, newest first, as this target can answer them:
--   * their personal lab history (owned lab_observations), read only under a granted lab_history
--     consent, and never verified: a personal copy is the app's import of a report nobody here has
--     compared with it;
--   * the clinic's readings for the enrolled patient record in this organization, not rejected,
--     verified only by a current reviewer attestation (lab-observation-attestation.sql).
-- The digest binds every reading, its revision or attestation, and the consent revision, so the
-- plan revision a person accepts names the results the review was made against.
create function clinical_private.production_program_lab_readings(_owner uuid,_org uuid,_patient uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _consent integer; _readings jsonb;
begin
 if _owner is null then return null; end if;
 _consent:=clinical_private.owned_consumer_consent(_owner,'lab_history');
 with owned as (
  select distinct on (v.record_id) v.record_id,v.revision,v.payload,v.deleted
  from clinical_core.owned_consumer_record_versions v
  where _consent is not null and v.owner_id=_owner and v.collection='lab_observations'
  order by v.record_id,v.revision desc
 ), readings as (
  select 'owned:'||o.record_id::text||':'||o.revision::text as key,o.payload->>'name' as marker,
   clinical_private.production_program_lab_direction((o.payload->>'value')::numeric,
    case when jsonb_typeof(o.payload->'reportedRange'->'low')='number' then (o.payload->'reportedRange'->>'low')::numeric end,
    case when jsonb_typeof(o.payload->'reportedRange'->'high')='number' then (o.payload->'reportedRange'->>'high')::numeric end) as direction,
   false as verified,clinical_private.production_program_try_timestamptz(o.payload->>'drawnAt') as observed
  from owned o
  where not o.deleted and jsonb_typeof(o.payload->'name')='string' and jsonb_typeof(o.payload->'value')='number'
  union all
  select 'clinic:'||l.id::text||':'||coalesce((clinical_private.current_lab_observation_attestation(l.id)).id::text,'none'),
   l.marker_name,clinical_private.production_program_lab_direction(l.value_numeric,l.reference_min,l.reference_max),
   clinical_private.lab_observation_verified(l.id),l.observed_at
  from clinical_core.lab_observations l
  where _patient is not null and l.organization_id=_org and l.patient_record_id=_patient and l.review_status<>'rejected'
 )
 select coalesce(jsonb_agg(jsonb_build_object('key',r.key,'marker',r.marker,'direction',r.direction,'verified',r.verified,
   'observedAt',r.observed) order by r.observed desc nulls last,r.key),'[]'::jsonb) into _readings from readings r;
 return jsonb_build_object('readings',_readings,'digest',encode(public.digest(convert_to(jsonb_build_object(
  'contract','program-lab-review/1','labHistoryConsent',coalesce(_consent::text,'none'),'readings',_readings)::text,'UTF8'),'sha256'),'hex'));
end $$;
revoke all on function clinical_private.production_program_lab_readings(uuid,uuid,uuid) from public;

-- The lab rule (program-lab-review/1), the service half of the device's program-lab-safety/1 and
-- the authority over it. Per supplement step, first matching nutrient wins: a reading above its own
-- range holds (results_disagree when the newest verified reading is not above, measured_above_range
-- otherwise); for iron, a step is also held unless the newest verified iron-status result is below or
-- within a range with an upper bound (status_not_verified). It returns reasons only: never a value,
-- a range, a direction or a classification.
create function clinical_private.production_program_lab_holds(_content jsonb,_labs jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare _phase jsonb; _item jsonb; _rule record; _related jsonb; _verified jsonb; _high boolean; _reason text;
 _holds jsonb:='{}'::jsonb;
begin
 if _labs is null then return _holds; end if;
 for _phase in select value from jsonb_array_elements(_content) loop
  for _item in select value from jsonb_array_elements(_phase->'items') loop
   if _item->>'kind' is distinct from 'supplement' or jsonb_typeof(_item->'product')<>'object' then continue; end if;
   for _rule in select * from (values
     (1,'iron','(^|[-_.:])(iron|ferrous|ferric|heme|carbonyl-iron)([-_.:]|$)','(ferritin|\yiron\y|iron saturation|transferrin saturation)','(binding capacity|\ytibc\y|\yuibc\y)',true),
     (2,'vitamin_d','vitamin-?d|cholecalciferol|ergocalciferol|(^|[-_.:])d3([-_.:]|$)','(vitamin d|cholecalciferol|\yd3\y)',null,false),
     (3,'vitamin_b12','b-?12|cobalamin','(vitamin b12|cobalamin|\yb12\y)',null,false),
     (4,'folate','folate|folic|methylfolate|mthf','(folate|folic acid)',null,false),
     (5,'magnesium','magnesium','magnesium',null,false),
     (6,'zinc','(^|[-_.:])zinc([-_.:]|$)','(^|\s)zinc($|\s)',null,false)
   ) as r(position,nutrient,ingredient,marker,excluded,verified_required) order by position loop
    if not exists(select 1 from jsonb_array_elements_text(_item->'product'->'ingredientKeys') k
     where lower(btrim(k.value)) ~ _rule.ingredient) then continue; end if;
    select coalesce(jsonb_agg(r.value order by r.ordinality),'[]'::jsonb) into _related
    from jsonb_array_elements(_labs->'readings') with ordinality r
    where coalesce(r.value->>'marker','') ~* _rule.marker
     and (_rule.excluded is null or coalesce(r.value->>'marker','') !~* _rule.excluded);
    select r.value into _verified from jsonb_array_elements(_related) with ordinality r
    where (r.value->>'verified')::boolean order by r.ordinality limit 1;
    _high:=exists(select 1 from jsonb_array_elements(_related) r where r.value->>'direction'='above');
    _reason:=null;
    if _high then
     _reason:=case when _verified is not null and _verified->>'direction'<>'above' then 'results_disagree' else 'measured_above_range' end;
    elsif _rule.verified_required and (_verified is null or _verified->>'direction' not in ('below','within')) then
     _reason:='status_not_verified';
    end if;
    if _reason is not null then
     _holds:=_holds||jsonb_build_object(_item->>'id',jsonb_build_object('itemId',_item->>'id','nutrient',_rule.nutrient,
      'reason',_reason,'decision','clinician_review'));
     exit;
    end if;
   end loop;
  end loop;
 end loop;
 return _holds;
end $$;
revoke all on function clinical_private.production_program_lab_holds(jsonb,jsonb) from public;

-- The safety review: identical to the synthetic copy and to V2's reviewProgram, plus the lab rule
-- above when the owner's readings are supplied (a workforce preview has no owner and supplies none).
-- A lab hold can only move a step into `held`; it never releases one.
create function clinical_private.production_program_review(_content jsonb, _inventory jsonb, _labs jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare
 _phase jsonb; _item jsonb; _product jsonb; _candidate jsonb; _candidates jsonb; _overlaps jsonb;
 _add text[]:='{}'; _duplicate text[]:='{}'; _held text[]:='{}'; _conflicts text[]:='{}';
 _complete boolean:=coalesce((_inventory->>'inventoryComplete')::boolean,false);
 _keys text[]; _other text[];
 _lab jsonb:=clinical_private.production_program_lab_holds(_content,_labs); _labHolds jsonb:='[]'::jsonb;
begin
 for _phase in select value from jsonb_array_elements(_content) loop
  _candidates:=coalesce(_inventory->'products','[]'::jsonb);
  for _item in select value from jsonb_array_elements(_phase->'items') loop
   if not coalesce((_item->>'released')::boolean,false)
   or (_item->>'kind'='supplement' and not _complete) then
    _held:=_held||(_item->>'id');
    if _lab ? (_item->>'id') then _labHolds:=_labHolds||jsonb_build_array(_lab->(_item->>'id')); end if;
    continue; end if;
   if _item->>'kind'<>'supplement' then _add:=_add||(_item->>'id'); continue; end if;
   _product:=_item->'product';
   select array_agg(lower(btrim(value)) order by lower(btrim(value))) into _keys
   from jsonb_array_elements_text(_product->'ingredientKeys');
   select coalesce(jsonb_agg(c),'[]'::jsonb) into _overlaps from jsonb_array_elements(_candidates) c
   where c->>'productId'=_product->>'id'
   or exists(select 1 from jsonb_array_elements_text(c->'ingredientKeys') ck
    where lower(btrim(ck.value))=any(_keys));
   if jsonb_array_length(_overlaps)=1 then
    _candidate:=_overlaps->0;
    select array_agg(lower(btrim(value)) order by lower(btrim(value))) into _other
    from jsonb_array_elements_text(_candidate->'ingredientKeys');
    if _candidate->>'productId'=_product->>'id' and _candidate->>'dose'=_product->>'dose' and _other=_keys then
     _duplicate:=_duplicate||(_item->>'id');
    else _conflicts:=_conflicts||(_item->>'id'); end if;
   elsif jsonb_array_length(_overlaps)>0 then _conflicts:=_conflicts||(_item->>'id');
   elsif _lab ? (_item->>'id') then
    _held:=_held||(_item->>'id'); _labHolds:=_labHolds||jsonb_build_array(_lab->(_item->>'id'));
   else
    _add:=_add||(_item->>'id');
    _candidates:=_candidates||jsonb_build_array(jsonb_build_object('productId',_product->>'id',
     'ingredientKeys',_product->'ingredientKeys','dose',_product->>'dose'));
   end if;
  end loop;
 end loop;
 if _labs is null then
  return jsonb_build_object('planRevision',coalesce(_inventory->>'revision','none'),
   'inventoryComplete',_complete,'add',to_jsonb(_add),'duplicate',to_jsonb(_duplicate),
   'held',to_jsonb(_held),'conflicts',to_jsonb(_conflicts));
 end if;
 return jsonb_build_object('planRevision',coalesce(_inventory->>'revision','none')||':labs:'||left(_labs->>'digest',32),
  'inventoryComplete',_complete,'add',to_jsonb(_add),'duplicate',to_jsonb(_duplicate),
  'held',to_jsonb(_held),'conflicts',to_jsonb(_conflicts),'labHolds',_labHolds);
end $$;
revoke all on function clinical_private.production_program_review(jsonb,jsonb,jsonb) from public;

create function clinical_core.production_program_assignment_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _action text:=_request->>'action';
 _connection clinical_core.patient_connections%rowtype; _row clinical_core.program_assignments%rowtype;
 _version clinical_core.program_versions%rowtype;
 _inventory jsonb; _review jsonb; _phase jsonb; _items jsonb; _digest text; _now timestamptz:=clock_timestamp();
 _expected bigint; _elapsed interval; _authorized boolean;
begin
 if not exists(select 1 from clinical_core.production_program_activation where singleton and enabled) then
  raise exception using errcode='42501',message='production_program_disabled'; end if;
 if _actor is null or _org is null or _pool is null or _pool not in('consumer','workforce')
 or clinical_private.claim('purpose') is distinct from 'clinical_data'
 or clinical_private.claim('environment') is distinct from 'production-clinical'
 or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool and i.identity_subject=clinical_private.claim('identity_subject')
  and i.production_bound and i.status='active' and p.status='active')
 or not exists(select 1 from clinical_core.organizations where id=_org and status='active')
 or (_pool='workforce' and not clinical_private.has_clinical_role(_org)) then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>262144
 or _action is null or _action not in('list','read','accept','complete','check_in','advance','pause','resume','withdraw','assign','status','release','connections','programs','preview') then
  raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 if (_action in('assign','status','release','connections','programs','preview')) <> (_pool='workforce') then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 -- A consumer acting on a program is acting on their supplement plan; the storage consent that
 -- covers that scope must be granted now, not merely once.
 if _pool='consumer' and clinical_private.owned_consumer_consent(_actor,'protocols_supplements') is null then
  raise exception using errcode='42501',message='consumer_storage_consent_required'; end if;

 if _action in('assign','preview') then
  if _request-array['action','connectionId','programVersionId']<>'{}'::jsonb
  or (_request->>'programVersionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or (_action='assign') <> (_request ? 'connectionId')
  or (_request ? 'connectionId' and (_request->>'connectionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select * into _version from clinical_core.program_versions
  where id=(_request->>'programVersionId')::uuid and organization_id=_org;
  if _version.id is null or _version.status<>'published' then
   raise exception using errcode='42501',message='program_assignment_unpublished'; end if;
  _items:=clinical_private.production_program_consumer_content(_version.content);
  if _items is null then raise exception using errcode='42501',message='program_assignment_unpublished'; end if;
  _digest:=encode(public.digest(convert_to(_items::text,'UTF8'),'sha256'),'hex');
  if _action='preview' then
   _inventory:=clinical_private.production_program_plan_inventory(null);
   _review:=clinical_private.production_program_review(_items->'phases',_inventory,null);
   insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'status');
   return jsonb_build_object('action','preview','programVersionId',_version.id,
    'programVersion',_version.version::text,'title',_items->>'title','phases',_items->'phases',
    'sourceDigest',_digest,'review',_review);
  end if;
  select * into _connection from clinical_core.patient_connections where id=(_request->>'connectionId')::uuid for update;
  if _connection.id is null or _connection.organization_id<>_org or _connection.state<>'verified'
  or _connection.consumer_person_id is null
  or not exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and organization_id=_org and status='active') then
   raise exception using errcode='42501',message='program_assignment_refused'; end if;
  select * into _row from clinical_core.program_assignments
  where connection_id=_connection.id and program_version_id=_version.id;
  if _row.id is null then
   insert into clinical_core.program_assignments(organization_id,connection_id,consumer_person_id,program_version_id,
    assigned_by,title,content,source_digest)
   values(_org,_connection.id,_connection.consumer_person_id,_version.id,_actor,_items->>'title',_items->'phases',_digest)
   returning * into _row;
  elsif _row.source_digest<>_digest then
   raise exception using errcode='40001',message='program_assignment_conflict';
  end if;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'assign');
  return jsonb_build_object('action','assign','enrollmentId',_row.id,'sourceDigest',_row.source_digest,
   'state',_row.state,'revision',_row.revision::text,'duplicate',_row.created_at<_now);
 end if;

 if _action='programs' then
  if _request-array['action']<>'{}'::jsonb then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'programVersionId',v.id,'programId',v.program_id,'programVersion',v.version::text,
    'programName',p.name,
    'title',coalesce(clinical_private.production_program_consumer_content(v.content)->>'title',p.name),
    'phaseCount',coalesce(jsonb_array_length(clinical_private.production_program_consumer_content(v.content)->'phases'),0),
    'assignable',clinical_private.production_program_consumer_content(v.content) is not null,
    'publishedAt',v.published_at) order by v.published_at desc nulls last,v.version desc),'[]'::jsonb) into _items
  from (select v.* from clinical_core.program_versions v
   where v.organization_id=_org and v.status='published'
   order by v.published_at desc nulls last,v.version desc limit 50) v
  join clinical_core.programs p on p.id=v.program_id and p.organization_id=_org;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'status');
  return jsonb_build_object('action','programs','programs',_items);
 end if;

 if _action='connections' then
  if _request-array['action']<>'{}'::jsonb then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('connectionId',c.id,'patientRecordId',c.patient_record_id,
    'verifiedAt',c.verified_at) order by c.verified_at desc),'[]'::jsonb) into _items
  from (select c.* from clinical_core.patient_connections c join clinical_core.patient_records r on r.id=c.patient_record_id
   where c.organization_id=_org and c.state='verified' and c.consumer_person_id is not null and r.status='active'
   order by c.verified_at desc limit 50) c;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'status');
  return jsonb_build_object('action','connections','connections',_items);
 end if;

 if _action='status' then
  if _request-array['action','connectionId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('enrollmentId',a.id,'title',a.title,'state',a.state,
    'revision',a.revision::text,'patientRecordId',c.patient_record_id,'connectionId',c.id,
    'phaseIndex',a.phase_index,'phaseCount',jsonb_array_length(a.content),
    'finished',a.finished,'completedCount',(select count(*) from clinical_core.program_assignment_completions x where x.assignment_id=a.id),
    'assignedAt',a.created_at,'updatedAt',a.updated_at) order by a.created_at desc),'[]'::jsonb) into _items
  from (select a.* from clinical_core.program_assignments a
   where a.organization_id=_org
   and (_request->>'connectionId' is null or a.connection_id=(_request->>'connectionId')::uuid)
   order by a.created_at desc limit 50) a
  join clinical_core.patient_connections c on c.id=a.connection_id and c.organization_id=_org;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'status');
  return jsonb_build_object('action','status','assignments',_items);
 end if;

 if _action='release' then
  if _request-array['action','enrollmentId','phaseId']<>'{}'::jsonb
  or coalesce(_request->>'phaseId','') !~ '^[A-Za-z0-9_.:-]{1,160}$' then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select * into _row from clinical_core.program_assignments where id=(_request->>'enrollmentId')::uuid and organization_id=_org for update;
  if _row.id is null or not exists(select 1 from jsonb_array_elements(_row.content) p where p.value->>'id'=_request->>'phaseId') then
   raise exception using errcode='42501',message='program_assignment_refused'; end if;
  insert into clinical_core.program_phase_authorizations(assignment_id,phase_id,kind,recorded_by)
  values(_row.id,_request->>'phaseId','practitioner_release',_actor) on conflict do nothing;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'release');
  return jsonb_build_object('action','release','enrollmentId',_row.id,'phaseId',_request->>'phaseId');
 end if;

 if _action='list' then
  if _request-array['action']<>'{}'::jsonb then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('enrollmentId',a.id,'title',a.title,'state',a.state,
    'revision',a.revision::text,'sourceDigest',a.source_digest,'programVersion',v.version::text,'phaseIndex',a.phase_index,
    'phaseCount',jsonb_array_length(a.content),'finished',a.finished,'assignedAt',a.created_at) order by a.created_at desc),'[]'::jsonb)
  into _items from clinical_core.program_assignments a join clinical_core.patient_connections c on c.id=a.connection_id
  join clinical_core.program_versions v on v.id=a.program_version_id
  join clinical_core.patient_records r on r.id=c.patient_record_id
  where a.organization_id=_org and c.organization_id=_org and c.state='verified' and r.status='active'
  and c.consumer_person_id=_actor and a.state<>'withdrawn';
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'list');
  return jsonb_build_object('action','list','assignments',_items);
 end if;

 if _request->>'enrollmentId' is null
 or (_request->>'enrollmentId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 select * into _row from clinical_core.program_assignments where id=(_request->>'enrollmentId')::uuid for update;
 if _row.id is null or _row.organization_id<>_org then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 select * into _connection from clinical_core.patient_connections where id=_row.connection_id;
 if _connection.id is null or _connection.organization_id<>_org or _connection.state<>'verified'
 or _connection.consumer_person_id is distinct from _actor
 or not exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and organization_id=_org and status='active') then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 _inventory:=clinical_private.production_program_plan_inventory(_actor);
 _review:=clinical_private.production_program_review(_row.content,_inventory,
  clinical_private.production_program_lab_readings(_actor,_org,_connection.patient_record_id));

 if _action='read' then
  if _request-array['action','enrollmentId']<>'{}'::jsonb then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'read');
  return jsonb_build_object('action','read','assignment',jsonb_build_object('enrollmentId',_row.id,'title',_row.title,
   'state',_row.state,'revision',_row.revision::text,'sourceDigest',_row.source_digest,
   'programVersion',(select v.version::text from clinical_core.program_versions v where v.id=_row.program_version_id),
   'phases',_row.content,
   'phaseIndex',_row.phase_index,'finished',_row.finished,'startedAt',_row.started_at,'phaseStartedAt',_row.phase_started_at),
   'completed',(select coalesce(jsonb_agg(c.item_id order by c.item_id),'[]'::jsonb) from clinical_core.program_assignment_completions c where c.assignment_id=_row.id),
   'authorizations',(select coalesce(jsonb_agg(jsonb_build_object('phaseId',a.phase_id,'kind',a.kind) order by a.phase_id,a.kind),'[]'::jsonb)
    from clinical_core.program_phase_authorizations a where a.assignment_id=_row.id),
   'review',_review);
 end if;

 if _request->>'sourceDigest' is distinct from _row.source_digest then
  raise exception using errcode='40001',message='program_assignment_version_changed'; end if;
 _expected:=nullif(_request->>'expectedRevision','')::bigint;
 if _expected is null then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 if _expected<>_row.revision then raise exception using errcode='40001',message='program_assignment_revision_stale'; end if;

 if _action='accept' then
  if _request-array['action','enrollmentId','sourceDigest','expectedRevision','planRevision']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  if _request->>'planRevision' is distinct from (_review->>'planRevision') then
   raise exception using errcode='40001',message='program_review_stale'; end if;
  if _row.state='active' then
   insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'accept');
   return jsonb_build_object('action','accept','enrollmentId',_row.id,'revision',_row.revision::text,'state',_row.state,'duplicate',true);
  end if;
  if _row.state<>'offered' then raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;
  update clinical_core.program_assignments set state='active',started_at=_now,phase_started_at=_now,
   phase_index=0,revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'accept');
  return jsonb_build_object('action','accept','enrollmentId',_row.id,'revision',_row.revision::text,'state',_row.state,'duplicate',false);
 end if;

 if _row.state='withdrawn' then raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;

 if _action in('pause','resume') then
  if _request-array['action','enrollmentId','sourceDigest','expectedRevision']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  if (_action='pause' and _row.state<>'active') or (_action='resume' and _row.state<>'paused') then
   raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;
  update clinical_core.program_assignments set state=case when _action='pause' then 'paused' else 'active' end,
   revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,_action);
  return jsonb_build_object('action',_action,'enrollmentId',_row.id,'revision',_row.revision::text,'state',_row.state);
 end if;

 if _action='withdraw' then
  if _request-array['action','enrollmentId','sourceDigest','expectedRevision']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  update clinical_core.program_assignments set state='withdrawn',finished=false,revision=revision+1,updated_at=_now
   where id=_row.id returning * into _row;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'withdraw');
  return jsonb_build_object('action','withdraw','enrollmentId',_row.id,'revision',_row.revision::text,'state',_row.state);
 end if;

 if _row.state<>'active' or _row.finished then
  raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;
 _phase:=_row.content->_row.phase_index;
 if _phase is null then raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;

 if _action='complete' then
  if _request-array['action','enrollmentId','sourceDigest','expectedRevision','itemId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  if not exists(select 1 from jsonb_array_elements(_phase->'items') i where i.value->>'id'=_request->>'itemId')
  or not exists(select 1 from jsonb_array_elements_text(_review->'add') a where a.value=_request->>'itemId') then
   raise exception using errcode='42501',message='program_item_held'; end if;
  insert into clinical_core.program_assignment_completions(assignment_id,item_id)
  values(_row.id,_request->>'itemId') on conflict do nothing;
  update clinical_core.program_assignments set revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'complete');
  return jsonb_build_object('action','complete','enrollmentId',_row.id,'revision',_row.revision::text,'itemId',_request->>'itemId');
 end if;

 if _action='check_in' then
  if _request-array['action','enrollmentId','sourceDigest','expectedRevision']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  insert into clinical_core.program_phase_authorizations(assignment_id,phase_id,kind,recorded_by)
  values(_row.id,_phase->>'id','consumer_check_in',_actor) on conflict do nothing;
  update clinical_core.program_assignments set revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'check_in');
  return jsonb_build_object('action','check_in','enrollmentId',_row.id,'revision',_row.revision::text,'phaseId',_phase->>'id');
 end if;

 if _request-array['action','enrollmentId','sourceDigest','expectedRevision']<>'{}'::jsonb then
  raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 if exists(select 1 from jsonb_array_elements(_phase->'items') i
  where exists(select 1 from jsonb_array_elements_text(_review->'add') a where a.value=i.value->>'id')
  and not exists(select 1 from clinical_core.program_assignment_completions c where c.assignment_id=_row.id and c.item_id=i.value->>'id')) then
  raise exception using errcode='40001',message='program_tasks_remaining'; end if;
 _elapsed:=_now-_row.phase_started_at;
 if _elapsed < ((_phase->>'days')::int * interval '1 day') then
  raise exception using errcode='40001',message='program_phase_not_due'; end if;
 if _phase->>'transition'='check_in' then
  select exists(select 1 from clinical_core.program_phase_authorizations a
   where a.assignment_id=_row.id and a.phase_id=_phase->>'id' and a.kind='consumer_check_in') into _authorized;
  if not _authorized then raise exception using errcode='40001',message='program_check_in_required'; end if;
 elsif _phase->>'transition'='practitioner' then
  select exists(select 1 from clinical_core.program_phase_authorizations a
   where a.assignment_id=_row.id and a.phase_id=_phase->>'id' and a.kind='practitioner_release') into _authorized;
  if not _authorized then raise exception using errcode='40001',message='program_practitioner_review_required'; end if;
 end if;
 if exists(select 1 from jsonb_array_elements(_phase->'items') i
  where exists(select 1 from jsonb_array_elements_text(_review->'held') h where h.value=i.value->>'id')
  or exists(select 1 from jsonb_array_elements_text(_review->'conflicts') x where x.value=i.value->>'id')) then
  raise exception using errcode='40001',message='program_clinical_items_held'; end if;
 if _row.phase_index=jsonb_array_length(_row.content)-1 then
  update clinical_core.program_assignments set finished=true,revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
 else
  update clinical_core.program_assignments set phase_index=phase_index+1,phase_started_at=_now,revision=revision+1,updated_at=_now
   where id=_row.id returning * into _row;
 end if;
 insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'advance');
 return jsonb_build_object('action','advance','enrollmentId',_row.id,'revision',_row.revision::text,
  'phaseIndex',_row.phase_index,'finished',_row.finished);
end $$;
revoke all on function clinical_core.production_program_assignment_request(jsonb) from public;
grant execute on function clinical_core.production_program_assignment_request(jsonb) to clinical_core_api;
