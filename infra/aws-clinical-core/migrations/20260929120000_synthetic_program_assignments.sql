-- Program assignment as a service. Synthetic-only; no production activation.
--
-- Until now a program could be authored, reviewed and published on Desktop, and
-- V2 had a pure state model and a card, but nothing joined them: no assignment
-- existed, no progress was stored, and the card was never reached from a screen.
-- This is the server side of that join.
--
-- An assignment is an immutable artifact. A practitioner creates it from a
-- PUBLISHED program version in their own organization, and its phases are
-- validated against the consumer contract and pinned by a digest at that moment.
-- Drafts and in-review versions are refused, so nothing unapproved can reach a
-- patient, and the digest is what later mutations re-check: if the artifact the
-- owner reviewed is not the artifact being acted on, the action refuses.
--
-- Safety holds are computed here, never accepted from a client, and phase
-- transitions read the server's own phase order and clock. A client-supplied
-- phase id is evidence of nothing.
create table clinical_core.program_assignments(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 connection_id uuid not null references clinical_core.patient_connections(id),
 consumer_person_id uuid not null references clinical_core.persons(id),
 program_version_id uuid not null,
 assigned_by uuid not null references clinical_core.persons(id),
 title text not null check(char_length(btrim(title)) between 1 and 240),
 content jsonb not null,
 source_digest text not null check(source_digest ~ '^[a-f0-9]{64}$'),
 state text not null default 'offered' check(state in('offered','active','paused','withdrawn')),
 -- Every mutation carries the revision it expected. Two devices cannot both win.
 revision bigint not null default 1 check(revision>0),
 phase_index integer not null default 0 check(phase_index>=0),
 started_at timestamptz, phase_started_at timestamptz,
 finished boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 foreign key (program_version_id, organization_id)
  references clinical_core.synthetic_desktop_program_versions(id, organization_id),
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
-- A check-in and a practitioner release are different authorities for the same
-- gate, so they are recorded separately and neither can be mistaken for the other.
create table clinical_core.program_phase_authorizations(
 assignment_id uuid not null references clinical_core.program_assignments(id),
 phase_id text not null check(phase_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 kind text not null check(kind in('consumer_check_in','practitioner_release')),
 recorded_by uuid not null references clinical_core.persons(id),
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(assignment_id,phase_id,kind)
);
create table clinical_core.program_assignment_audit(
 id uuid primary key default gen_random_uuid(),
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
-- Content and digest are the pinned artifact; nothing may edit them after the fact.
-- State, revision, phase and timestamps are the mutable progress on that artifact.
create function clinical_private.block_program_assignment_content_change() returns trigger
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
revoke all on function clinical_private.block_program_assignment_content_change() from public;
create trigger program_assignment_content_immutable before update on clinical_core.program_assignments
 for each row execute function clinical_private.block_program_assignment_content_change();
create trigger program_assignment_completions_immutable before update or delete on clinical_core.program_assignment_completions
 for each row execute function clinical_private.block_update_delete();
create trigger program_phase_authorizations_immutable before update or delete on clinical_core.program_phase_authorizations
 for each row execute function clinical_private.block_update_delete();
create trigger program_assignment_audit_immutable before update or delete on clinical_core.program_assignment_audit
 for each row execute function clinical_private.block_update_delete();

-- The consumer contract, enforced where it cannot be bypassed. A practitioner UI
-- validates too, but this is the copy that decides.
--
-- Written as a sequence of explicit statements rather than one long boolean, because
-- the first version of this function was wrong in a way a long boolean invites: a
-- missing key makes `jsonb_typeof(x) <> 'number'` evaluate to NULL, NULL is not true,
-- and an `if` on it does not fire. Content with `days` or `items` simply removed was
-- therefore accepted. Every check below first requires the key to be present, and no
-- comparison is relied on to reject an absent value.
create function clinical_private.program_content_valid(_content jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare
 _phase jsonb; _item jsonb; _ids text[]:='{}'; _phase_ids text[]:='{}'; _keys text[]; _product jsonb;
 _phase_keys text[]:=array['id','title','days','transition','items'];
 _item_keys text[]:=array['id','title','kind','instructions','released'];
 _product_keys text[]:=array['id','ingredientKeys','dose','purchaseUrl'];
 _days numeric;
begin
 if _content is null or jsonb_typeof(_content)<>'array' then return false; end if;
 if jsonb_array_length(_content) not between 1 and 52 then return false; end if;
 if octet_length(_content::text)>262144 then return false; end if;
 for _phase in select value from jsonb_array_elements(_content) loop
  if jsonb_typeof(_phase)<>'object' then return false; end if;
  -- Every required key present, and nothing else. Both directions matter: a missing
  -- key is unapproved by omission, an extra one is content nobody reviewed.
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
   if _item->>'kind'='supplement' then
    -- A supplement without a governed product is not reviewable.
    if not (_item ? 'product') then return false; end if;
    if _item-(_item_keys||array['product'])<>'{}'::jsonb then return false; end if;
    _product:=_item->'product';
    if jsonb_typeof(_product)<>'object' then return false; end if;
    if not (_product ?& _product_keys) then return false; end if;
    if _product-_product_keys<>'{}'::jsonb then return false; end if;
    if jsonb_typeof(_product->'id')<>'string' or _product->>'id' !~ '^[A-Za-z0-9_.:-]{1,160}$' then return false; end if;
    if jsonb_typeof(_product->'dose')<>'string' or char_length(_product->>'dose') not between 1 and 240 then return false; end if;
    if jsonb_typeof(_product->'ingredientKeys')<>'array'
     or jsonb_array_length(_product->'ingredientKeys') not between 1 and 40 then return false; end if;
    -- A purchase destination must be an explicit https origin or explicitly absent.
    -- Syntax is not provider approval; it only stops an unusable value being stored.
    if jsonb_typeof(_product->'purchaseUrl')<>'null' then
     if jsonb_typeof(_product->'purchaseUrl')<>'string'
      or _product->>'purchaseUrl' !~ '^https://[A-Za-z0-9._~-]+\.[A-Za-z]{2,}(/[^\s]*)?$' then return false; end if;
    end if;
    if exists(select 1 from jsonb_array_elements(_product->'ingredientKeys') e where jsonb_typeof(e.value)<>'string') then
     return false; end if;
    select array_agg(lower(btrim(value))) into _keys from jsonb_array_elements_text(_product->'ingredientKeys');
    if _keys is null or array_length(_keys,1)<>jsonb_array_length(_product->'ingredientKeys') then return false; end if;
    if exists(select 1 from unnest(_keys) k where k !~ '^[A-Za-z0-9_.:-]{1,160}$') then return false; end if;
    if array_length(_keys,1)<>(select count(distinct k) from unnest(_keys) k) then return false; end if;
   else
    -- A product on a lesson, a diet step or a habit is a claim nobody approved.
    if _item ? 'product' then return false; end if;
    if _item-_item_keys<>'{}'::jsonb then return false; end if;
   end if;
  end loop;
 end loop;
 return true;
end $$;
revoke all on function clinical_private.program_content_valid(jsonb) from public;

-- The patient-facing program a published version actually approved.
--
-- Nothing a caller sends is evidence that content was reviewed. An assignment is
-- compiled from this function's answer and from nothing else, so a request can name
-- a version but cannot describe one. A published version that carries no valid
-- consumer program has approved nothing for patients, and assignment refuses rather
-- than falling back to whatever arrived with the request.
create function clinical_private.program_consumer_content(_version_content jsonb) returns jsonb
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
 if not clinical_private.program_content_valid(_program->'phases') then return null; end if;
 return jsonb_build_object('title',btrim(_program->>'title'),'phases',_program->'phases');
end $$;
revoke all on function clinical_private.program_consumer_content(jsonb) from public;

-- What the account is already taking, as this target can answer it.
--
-- The overlap check below compares ingredient keys, and in THIS database there is
-- no governed catalog to resolve a plan supplement's product id into ingredients:
-- the catalog lives in the production migration family. So the honest answer here
-- is that the inventory is incomplete, which holds every program supplement. That
-- is a refusal to guess, not a placeholder — unknown is not "no overlap", and
-- treating it as absence is how a duplicate dose reaches someone.
--
-- When the catalog exists in the same target, only this function changes. The
-- algorithm it feeds is already complete and tested.
create function clinical_private.program_plan_inventory(_connection uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _revision text;
begin
 -- The plan the owner has in the account, used as the revision the review is bound
 -- to, so a plan change invalidates a review the owner had already seen.
 select coalesce(max(v.received_at)::text,'none') into _revision
 from clinical_core.consumer_clinical_record_versions v
 where v.connection_id=_connection and v.collection='protocols' and not v.deleted;
 return jsonb_build_object('revision',_revision,'products','[]'::jsonb,'inventoryComplete',false,
  'incompleteReason','governed_ingredients_unavailable_in_target');
end $$;
revoke all on function clinical_private.program_plan_inventory(uuid) from public;

-- The safety review: a pure function of the pinned content and the inventory, so
-- it can be exercised directly with any inventory rather than only the one this
-- target can currently produce.
--
-- Deliberately mirrors V2's `reviewProgram`, including resetting the candidate set
-- per phase: a later phase is reviewed against the plan as it stands, not against
-- what earlier phases of the same guide would add.
create function clinical_private.program_review(_content jsonb, _inventory jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare
 _phase jsonb; _item jsonb; _product jsonb; _candidate jsonb; _candidates jsonb; _overlaps jsonb;
 _add text[]:='{}'; _duplicate text[]:='{}'; _held text[]:='{}'; _conflicts text[]:='{}';
 _complete boolean:=coalesce((_inventory->>'inventoryComplete')::boolean,false);
 _keys text[]; _other text[];
begin
 for _phase in select value from jsonb_array_elements(_content) loop
  _candidates:=coalesce(_inventory->'products','[]'::jsonb);
  for _item in select value from jsonb_array_elements(_phase->'items') loop
   if not coalesce((_item->>'released')::boolean,false)
   or (_item->>'kind'='supplement' and not _complete) then
    _held:=_held||(_item->>'id'); continue; end if;
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
   else
    _add:=_add||(_item->>'id');
    _candidates:=_candidates||jsonb_build_array(jsonb_build_object('productId',_product->>'id',
     'ingredientKeys',_product->'ingredientKeys','dose',_product->>'dose'));
   end if;
  end loop;
 end loop;
 return jsonb_build_object('planRevision',coalesce(_inventory->>'revision','none'),
  'inventoryComplete',_complete,'add',to_jsonb(_add),'duplicate',to_jsonb(_duplicate),
  'held',to_jsonb(_held),'conflicts',to_jsonb(_conflicts));
end $$;
revoke all on function clinical_private.program_review(jsonb,jsonb) from public;

create function clinical_core.program_assignment_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _action text:=_request->>'action';
 _connection clinical_core.patient_connections%rowtype; _row clinical_core.program_assignments%rowtype;
 _version clinical_core.synthetic_desktop_program_versions%rowtype;
 _inventory jsonb; _review jsonb; _phase jsonb; _items jsonb; _digest text; _now timestamptz:=clock_timestamp();
 _expected bigint; _elapsed interval; _authorized boolean;
begin
 perform clinical_private.assert_synthetic_context(_org,'clinical_data');
 if _actor is null or _org is null or _pool is null or _pool not in('consumer','workforce')
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool and i.identity_subject=clinical_private.claim('identity_subject')
  and i.status='active' and p.status='active' and i.synthetic_attested)
 or not exists(select 1 from clinical_core.organizations where id=_org and status='active')
 or (_pool='workforce' and not clinical_private.has_clinical_role(_org)) then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>262144
 or _action is null or _action not in('list','read','accept','complete','check_in','advance','pause','resume','withdraw','assign','status','release','connections','programs','preview') then
  raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 if (_action in('assign','status','release','connections','programs','preview')) <> (_pool='workforce') then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;

 if _action in('assign','preview') then
  -- A request may NAME a version. It may not describe one. Nothing about the content,
  -- the title, the released flags, the ingredient keys or the purchase destinations is
  -- taken from the caller, because a digest of a request body proves only that the body
  -- was hashed -- not that it came from anything a clinic approved.
  if _request-array['action','connectionId','programVersionId']<>'{}'::jsonb
  or (_request->>'programVersionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or (_action='assign') <> (_request ? 'connectionId')
  or (_request ? 'connectionId' and (_request->>'connectionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  -- Only a published version may reach a patient. A draft or an in-review version is
  -- unapproved content, and superseded is no longer what the clinic stands behind.
  select * into _version from clinical_core.synthetic_desktop_program_versions
  where id=(_request->>'programVersionId')::uuid and organization_id=_org;
  if _version.id is null or _version.status<>'published' then
   raise exception using errcode='42501',message='program_assignment_unpublished'; end if;
  -- The approved patient-facing program, compiled from the published artifact.
  _items:=clinical_private.program_consumer_content(_version.content);
  if _items is null then
   -- Published, but nothing in it was approved for patients. Falling back to request
   -- content here is exactly the bypass this refuses.
   raise exception using errcode='42501',message='program_assignment_unpublished'; end if;
  _digest:=encode(public.digest(convert_to((_items->'phases')::text,'UTF8'),'sha256'),'hex');
  if _action='preview' then
   _inventory:=clinical_private.program_plan_inventory(null);
   _review:=clinical_private.program_review(_items->'phases',_inventory);
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
   -- The published artifact changed under a version already assigned. The existing
   -- assignment is what the owner reviewed, so this refuses rather than rewriting it.
   raise exception using errcode='40001',message='program_assignment_conflict';
  end if;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'assign');
  return jsonb_build_object('action','assign','enrollmentId',_row.id,'sourceDigest',_row.source_digest,
   'state',_row.state,'revision',_row.revision::text,'duplicate',_row.created_at<_now);
 end if;

 if _action='programs' then
  -- The picker's source: published versions in this organization that actually carry an
  -- approved patient-facing program. One that does not is listed as not assignable with
  -- the reason, rather than left out, so an author can see why it cannot be shared.
  if _request-array['action']<>'{}'::jsonb then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'programVersionId',v.id,'programId',v.program_id,'programVersion',v.version::text,
    'programName',p.name,
    'title',coalesce(clinical_private.program_consumer_content(v.content)->>'title',p.name),
    'phaseCount',coalesce(jsonb_array_length(clinical_private.program_consumer_content(v.content)->'phases'),0),
    'assignable',clinical_private.program_consumer_content(v.content) is not null,
    'publishedAt',v.published_at) order by v.published_at desc nulls last,v.version desc),'[]'::jsonb) into _items
  from (select v.* from clinical_core.synthetic_desktop_program_versions v
   where v.organization_id=_org and v.status='published'
   order by v.published_at desc nulls last,v.version desc limit 50) v
  join clinical_core.synthetic_desktop_programs p on p.id=v.program_id and p.organization_id=_org;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'status');
  return jsonb_build_object('action','programs','programs',_items);
 end if;

 if _action='connections' then
  -- What the workforce already sees through messaging: which patients have a live app
  -- link. A panel needs this to name a patient without inventing an identifier space.
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
  -- No selector means the whole clinic, which is the scope a workforce panel works at.
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
  join clinical_core.synthetic_desktop_program_versions v on v.id=a.program_version_id
  join clinical_core.patient_records r on r.id=c.patient_record_id
  where a.organization_id=_org and c.organization_id=_org and c.state='verified' and r.status='active'
  and c.consumer_person_id=_actor and a.state<>'withdrawn';
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'list');
  return jsonb_build_object('action','list','assignments',_items);
 end if;

 -- Every remaining consumer action addresses one assignment the caller owns.
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
 _inventory:=clinical_private.program_plan_inventory(_row.connection_id);
 _review:=clinical_private.program_review(_row.content,_inventory);

 if _action='read' then
  if _request-array['action','enrollmentId']<>'{}'::jsonb then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'read');
  return jsonb_build_object('action','read','assignment',jsonb_build_object('enrollmentId',_row.id,'title',_row.title,
   'state',_row.state,'revision',_row.revision::text,'sourceDigest',_row.source_digest,
   'programVersion',(select v.version::text from clinical_core.synthetic_desktop_program_versions v where v.id=_row.program_version_id),
   'phases',_row.content,
   'phaseIndex',_row.phase_index,'finished',_row.finished,'startedAt',_row.started_at,'phaseStartedAt',_row.phase_started_at),
   'completed',(select coalesce(jsonb_agg(c.item_id order by c.item_id),'[]'::jsonb) from clinical_core.program_assignment_completions c where c.assignment_id=_row.id),
   'authorizations',(select coalesce(jsonb_agg(jsonb_build_object('phaseId',a.phase_id,'kind',a.kind) order by a.phase_id,a.kind),'[]'::jsonb)
    from clinical_core.program_phase_authorizations a where a.assignment_id=_row.id),
   'review',_review);
 end if;

 -- A mutation states the artifact and the revision it believes it is acting on.
 -- Either both match or nothing happens, so two devices cannot both apply.
 if _request->>'sourceDigest' is distinct from _row.source_digest then
  raise exception using errcode='40001',message='program_assignment_version_changed'; end if;
 _expected:=nullif(_request->>'expectedRevision','')::bigint;
 if _expected is null then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 if _expected<>_row.revision then raise exception using errcode='40001',message='program_assignment_revision_stale'; end if;

 if _action='accept' then
  if _request-array['action','enrollmentId','sourceDigest','expectedRevision','planRevision']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  -- The owner reviewed the guide against a plan. If the plan moved since, the
  -- review they saw is not the review that applies now.
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
  -- Withdrawing removes the guide, never the independent clinical protocol.
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
  -- Only an available step of the CURRENT phase, and never a held or conflicting one.
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
  -- The phase is the server's, not the client's: no phase id is accepted here.
  insert into clinical_core.program_phase_authorizations(assignment_id,phase_id,kind,recorded_by)
  values(_row.id,_phase->>'id','consumer_check_in',_actor) on conflict do nothing;
  update clinical_core.program_assignments set revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'check_in');
  return jsonb_build_object('action','check_in','enrollmentId',_row.id,'revision',_row.revision::text,'phaseId',_phase->>'id');
 end if;

 -- advance
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
 -- A phase carrying a held or conflicting clinical item does not advance. This
 -- mirrors the consumer model exactly and is not softened here: while governed
 -- ingredients cannot be resolved in this target every supplement item is held,
 -- so a guide containing one cannot progress until that is true.
 if exists(select 1 from jsonb_array_elements(_phase->'items') i
  where exists(select 1 from jsonb_array_elements_text(_review->'held') h where h.value=i.value->>'id')
  or exists(select 1 from jsonb_array_elements_text(_review->'conflicts') k where k.value=i.value->>'id')) then
  raise exception using errcode='40001',message='program_clinical_items_held'; end if;
 if _row.phase_index=jsonb_array_length(_row.content)-1 then
  update clinical_core.program_assignments set finished=true,revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
 else
  update clinical_core.program_assignments set phase_index=phase_index+1,phase_started_at=_now,
   revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
 end if;
 insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'advance');
 return jsonb_build_object('action','advance','enrollmentId',_row.id,'revision',_row.revision::text,
  'phaseIndex',_row.phase_index,'finished',_row.finished);
end $$;
revoke all on function clinical_core.program_assignment_request(jsonb) from public;
grant execute on function clinical_core.program_assignment_request(jsonb) to clinical_core_api;
