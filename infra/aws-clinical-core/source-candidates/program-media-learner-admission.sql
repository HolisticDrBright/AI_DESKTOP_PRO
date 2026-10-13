-- BLOCKED source candidate (successor): immutable publication text, curriculum admission of native
-- lesson media, and the learner and staff read authority over it (program-learner-media/1), for
-- Codex's review. Not in migrations/manifest.json; not applied anywhere; not registered; not to be
-- applied until docs/claude-learner-media-delivery-2026-10-13.md and
-- src/server/programs/learner-media-*.ts are reviewed. Learner delivery is DISABLED by the row below
-- and only a separately reviewed change may enable it.
--
-- Parent assumptions (written against exactly these artifacts, applied first in this order, each
-- unchanged; the test refuses to run if any digest has moved):
--   source-candidates/program-education-catalog-admission.sql
--     sha256 eac6f2f1ae0ff2d418da9f7a06b5086d50ba46374f31961726fd52fa0530ba1d
--     (clinical_private.program_content_valid, replaced below with nativeMedia added)
--   source-candidates/program-media-ledger.sql            6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d
--   source-candidates/program-media-settlement.sql        74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04
--   source-candidates/program-media-native-ledger.sql     69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7
--   source-candidates/program-media-multipart.sql         a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092
--     (program_media_artifacts, program_media_publications with its full `reference`,
--      program_media_activation, program_media_authority)
--   source-candidates/program-commerce-runtime-sessions.sql
--     sha256 d2142ad80fead07f83fa23636434274037c87ebad91fa1ce59988ab973b2c037
--     and through it the seven commerce candidates (program_entitlements, program_education_enrollments,
--     caller_consumer_subject, require_activation)
-- No historical migration, earlier candidate, ledger, binary, IAM or custody file is changed by this
-- file. No retention, deletion, staff-visibility or pricing policy is decided here.
--
-- What it holds and refuses:
--   * TEXT. A publication recorded after this file carries the exact caption and transcript text of
--     the version it published, captured in the same transaction as the publication row while the
--     artifact is locked at that version, digest-checked, append-only and never rewritten. A
--     publication recorded before this file has no snapshot and stays text-unavailable: nothing is
--     backfilled from the artifact's current text, which may belong to a later version.
--   * ADMISSION. A curriculum version that carries `nativeMedia` is admitted when it becomes
--     published, item by item and slot by slot, and only when each reference is EXACTLY a recorded
--     publication (same jsonb) of this clinic and this program, whose artifact is still ready at the
--     same version and bytes, with an object version, at the canonical address under the current
--     authoring origin. Any other reference refuses the publish; the version stays unpublished and
--     no admission row survives the rollback. A held, abandoned, retired, replaced (later version),
--     wrong-clinic, cross-program or unrecorded publication is never admitted.
--   * The curriculum version row, its digest and every entitlement pinned to it are untouched.
--   * WITHDRAWAL. An admission can be withdrawn by a program author of its clinic (append-only, with a
--     reason); a withdrawn admission is never served again. Nothing is deleted.
--   * READS. The learner read resolves, at request time and by the database clock, the verified
--     consumer subject, the caller's own active entitlement and active enrollment, the exact pinned
--     version, its re-digested content, the released lesson, the admission for that exact slot and
--     reference, and that it is not withdrawn. Every authority failure answers one identical
--     `refused`, with no content and no object metadata. The staff read requires an active clinical
--     member of the version's own clinic and refuses anyone else the same way. While learner delivery
--     is disabled the learner read answers `held` to every verified consumer; the staff read answers
--     `held` only after its clinician check.
--   * Object key and version are returned to the server that signs; they are never a client value.
--
-- Authority: one new NOLOGIN, NOINHERIT, non-bypass role owns every function here and reads only
-- through policies added for it. clinical_core_api may execute the two read functions and the
-- withdrawal; it gains no table privilege. No login, password or activation is created.

create role program_media_learner_authority nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant usage on schema clinical_core,clinical_private,commercial_education to program_media_learner_authority;
grant execute on function clinical_private.claim(text),clinical_private.actor_person_id(),clinical_private.organization_id(),
 clinical_private.has_clinical_role(uuid),clinical_private.has_program_author_role(uuid),
 commercial_education.caller_consumer_subject(),commercial_education.require_activation() to program_media_learner_authority;

/* -------------------------------------------------------------- learner delivery activation */

create table clinical_core.program_media_learner_delivery(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
 reviewed_by text check(reviewed_by is null or char_length(btrim(reviewed_by)) between 1 and 200),
 reviewed_at timestamptz,
 updated_at timestamptz not null default clock_timestamp(),
 check(not enabled or (evidence_sha256 is not null and reviewed_by is not null and reviewed_at is not null))
);
insert into clinical_core.program_media_learner_delivery(singleton,enabled) values(true,false);
alter table clinical_core.program_media_learner_delivery enable row level security;
alter table clinical_core.program_media_learner_delivery force row level security;
revoke all on clinical_core.program_media_learner_delivery from public,clinical_core_api,program_media_authority,program_media_worker;
create trigger program_media_learner_delivery_no_delete before delete on clinical_core.program_media_learner_delivery
 for each row execute function clinical_private.block_update_delete();

/* -------------------------------------------------------------- immutable publication text */

create table clinical_core.program_media_text_snapshots(
 publication_id uuid not null references clinical_core.program_media_publications(id),
 organization_id uuid not null references clinical_core.organizations(id),
 slot text not null check(slot in('caption','transcript')),
 source text not null check(source in('supplied_by_author','supplied_vendor_file')),
 format text not null check(format in('plain','vtt')),
 body text not null check(char_length(body) between 1 and 200000),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 byte_length integer not null check(byte_length>0),
 captured_at timestamptz not null default clock_timestamp(),
 primary key(publication_id,slot),
 check(sha256=encode(sha256(convert_to(body,'UTF8')),'hex')),
 check(byte_length=octet_length(convert_to(body,'UTF8')))
);
create trigger program_media_text_snapshots_append_only before update or delete on clinical_core.program_media_text_snapshots
 for each row execute function clinical_private.block_update_delete();
alter table clinical_core.program_media_text_snapshots enable row level security;
alter table clinical_core.program_media_text_snapshots force row level security;
revoke all on clinical_core.program_media_text_snapshots from public,clinical_core_api,program_media_worker;
-- The capture runs inside the publication's own transaction as the media authority, scoped to the request's clinic.
grant select,insert on clinical_core.program_media_text_snapshots to program_media_authority;
create policy program_media_authority_text on clinical_core.program_media_text_snapshots to program_media_authority
 using(organization_id=clinical_private.organization_id()) with check(organization_id=clinical_private.organization_id());

-- Runs AFTER the two parent admission triggers, which have already locked the artifact FOR UPDATE and
-- proved that the reference is this artifact at its current version, bytes and text digests. The text
-- copied here is therefore the published version's text; its digest is checked again before it is kept.
create function clinical_private.program_media_capture_text() returns trigger
language plpgsql security definer set search_path='' as $$
declare a clinical_core.program_media_artifacts%rowtype; slot_name text; ref jsonb; body text; src text; fmt text; digest text;
begin
 if new.reference is null then return null; end if;
 select * into a from clinical_core.program_media_artifacts where id=new.artifact_id;
 if a.id is null or a.version<>new.version or a.organization_id<>new.organization_id or a.sha256<>new.sha256 then
  raise exception using errcode='42501',message='program_media_text_capture_refused'; end if;
 foreach slot_name in array array['caption','transcript'] loop
  ref:=new.reference->slot_name;
  if jsonb_typeof(ref)='object' then
   if slot_name='caption' then body:=a.caption_text; src:=a.caption_source; fmt:=a.caption_format; digest:=a.caption_sha256;
   else body:=a.transcript_text; src:=a.transcript_source; fmt:=a.transcript_format; digest:=a.transcript_sha256; end if;
   if body is null or digest is distinct from ref->>'sha256' or src is distinct from ref->>'source'
    or (slot_name='transcript' and fmt is distinct from ref->>'format')
    or encode(sha256(convert_to(body,'UTF8')),'hex')<>digest then
    raise exception using errcode='42501',message='program_media_text_capture_refused'; end if;
   insert into clinical_core.program_media_text_snapshots(publication_id,organization_id,slot,source,format,body,sha256,byte_length)
    values(new.id,new.organization_id,slot_name,src,fmt,body,digest,octet_length(convert_to(body,'UTF8')));
  elsif ref is not null and jsonb_typeof(ref)<>'null' then
   raise exception using errcode='42501',message='program_media_text_capture_refused';
  end if;
 end loop;
 return null;
end $$;
create trigger program_media_capture_text after insert on clinical_core.program_media_publications
 for each row execute function clinical_private.program_media_capture_text();

/* -------------------------------------------------------------- content syntax: nativeMedia */

-- Identical to the parent definition for every artifact without `nativeMedia`, so every existing source
-- digest and consumer program is unchanged. `nativeMedia` is SYNTAX here: the identity is proved against
-- the ledger by the admission below, at publish time, and a reference that is only well-shaped is never served.
create or replace function clinical_private.program_content_valid(_content jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare
 _phase jsonb; _item jsonb; _ids text[]:='{}'; _phase_ids text[]:='{}'; _keys text[]; _product jsonb;
 _catalog jsonb; _ref jsonb; _days numeric; _version numeric; _n numeric; _identities text[];
 _phase_keys text[]:=array['id','title','days','transition','items'];
 _item_keys text[]:=array['id','title','kind','instructions','released'];
 _education_keys text[]:=array['rationale','sources','media','authorship','nativeMedia'];
 _product_keys text[]:=array['id','ingredientKeys','dose','purchaseUrl'];
 _catalog_keys text[]:=array['stableId','version','target'];
 _source_keys text[]:=array['title','url'];
 _media_keys text[]:=array['kind','url','caption'];
 _native_keys text[]:=array['contractVersion','artifactId','version','sha256','kind','contentType','bytes','origin','url','publishedAt','caption','transcript'];
 _uuid text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
 _hex text:='^[a-f0-9]{64}$';
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
   -- Native publication identities (program-media-reference/1): at most five slots together with
   -- `media`, no repeated artifact version, each exactly the published reference's shape.
   if _item ? 'nativeMedia' then
    if jsonb_typeof(_item->'nativeMedia')<>'array' or jsonb_array_length(_item->'nativeMedia') not between 1 and 5 then return false; end if;
    if jsonb_array_length(_item->'nativeMedia')+coalesce(jsonb_array_length((case when jsonb_typeof(_item->'media')='array' then _item->'media' end)),0)>5 then return false; end if;
    _identities:='{}';
    for _ref in select value from jsonb_array_elements(_item->'nativeMedia') loop
     if jsonb_typeof(_ref)<>'object' or not (_ref ?& _native_keys) or _ref-_native_keys<>'{}'::jsonb then return false; end if;
     if _ref->>'contractVersion' is distinct from 'program-media-reference/1' then return false; end if;
     if jsonb_typeof(_ref->'artifactId')<>'string' or _ref->>'artifactId' !~ _uuid then return false; end if;
     if jsonb_typeof(_ref->'version')<>'number' then return false; end if;
     _n:=(_ref->>'version')::numeric;
     if _n<>floor(_n) or _n not between 1 and 9007199254740991 then return false; end if;
     if jsonb_typeof(_ref->'sha256')<>'string' or _ref->>'sha256' !~ _hex then return false; end if;
     if jsonb_typeof(_ref->'kind')<>'string' or _ref->>'kind' not in('video','image') then return false; end if;
     if jsonb_typeof(_ref->'contentType')<>'string' or not (
      (_ref->>'kind'='video' and _ref->>'contentType' in('video/mp4','video/webm'))
      or (_ref->>'kind'='image' and _ref->>'contentType' in('image/png','image/jpeg','image/webp'))) then return false; end if;
     if jsonb_typeof(_ref->'bytes')<>'number' then return false; end if;
     _n:=(_ref->>'bytes')::numeric;
     if _n<>floor(_n) or _n<1 or _n>(case when _ref->>'kind'='image' then 16777216 else 268435456 end) then return false; end if;
     if jsonb_typeof(_ref->'origin')<>'object' or not (_ref->'origin' ?& array['clinic','programId'])
      or (_ref->'origin')-array['clinic','programId']<>'{}'::jsonb
      or jsonb_typeof(_ref->'origin'->'clinic')<>'string' or _ref->'origin'->>'clinic' !~ _uuid
      or jsonb_typeof(_ref->'origin'->'programId')<>'string' or _ref->'origin'->>'programId' !~ _uuid then return false; end if;
     if jsonb_typeof(_ref->'url')<>'string' or char_length(_ref->>'url')>2048 or _ref->>'url' !~ _url then return false; end if;
     if jsonb_typeof(_ref->'publishedAt')<>'string' or char_length(_ref->>'publishedAt') not between 20 and 40 then return false; end if;
     if jsonb_typeof(_ref->'caption')<>'null' then
      if jsonb_typeof(_ref->'caption')<>'object' or not (_ref->'caption' ?& array['source','sha256'])
       or (_ref->'caption')-array['source','sha256']<>'{}'::jsonb
       or _ref->'caption'->>'source' not in('supplied_by_author','supplied_vendor_file')
       or coalesce(_ref->'caption'->>'sha256','') !~ _hex then return false; end if;
     end if;
     if jsonb_typeof(_ref->'transcript')<>'null' then
      if _ref->>'kind'<>'video' or jsonb_typeof(_ref->'transcript')<>'object' or not (_ref->'transcript' ?& array['source','sha256','format'])
       or (_ref->'transcript')-array['source','sha256','format']<>'{}'::jsonb
       or _ref->'transcript'->>'source' not in('supplied_by_author','supplied_vendor_file')
       or coalesce(_ref->'transcript'->>'sha256','') !~ _hex
       or _ref->'transcript'->>'format' not in('plain','vtt') then return false; end if;
     end if;
     if (_ref->>'artifactId')||'/'||(_ref->>'version')=any(_identities) then return false; end if;
     _identities:=_identities||((_ref->>'artifactId')||'/'||(_ref->>'version'));
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
    -- A product on a lesson, a diet step or a habit is a claim nobody approved.
    if _item ? 'product' then return false; end if;
    if _item-(_item_keys||_education_keys)<>'{}'::jsonb then return false; end if;
   end if;
  end loop;
 end loop;
 return true;
end $$;
revoke all on function clinical_private.program_content_valid(jsonb) from public;
grant execute on function clinical_private.program_content_valid(jsonb),clinical_private.program_consumer_content(jsonb) to program_media_learner_authority;

/* -------------------------------------------------------------- curriculum admission */

create table clinical_core.program_curriculum_media_admissions(
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 program_id uuid not null,
 curriculum_version_id uuid not null references clinical_core.synthetic_desktop_program_versions(id),
 curriculum_version integer not null check(curriculum_version>0),
 phase_id text not null check(phase_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 item_id text not null check(item_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 slot smallint not null check(slot between 0 and 4),
 publication_id uuid not null references clinical_core.program_media_publications(id),
 artifact_id uuid not null references clinical_core.program_media_artifacts(id),
 artifact_version bigint not null check(artifact_version>0),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 reference jsonb not null check(jsonb_typeof(reference)='object'),
 admitted_at timestamptz not null default clock_timestamp(),
 foreign key (program_id, organization_id) references clinical_core.synthetic_desktop_programs(id, organization_id),
 unique(curriculum_version_id,phase_id,item_id,slot),
 unique(curriculum_version_id,phase_id,item_id,artifact_id,artifact_version)
);
create trigger program_curriculum_media_admissions_append_only before update or delete on clinical_core.program_curriculum_media_admissions
 for each row execute function clinical_private.block_update_delete();

create table clinical_core.program_curriculum_media_withdrawals(
 admission_id uuid primary key references clinical_core.program_curriculum_media_admissions(id),
 organization_id uuid not null references clinical_core.organizations(id),
 reason text not null check(reason in('content_error','rights_withdrawn','privacy','corrected')),
 withdrawn_by uuid not null references clinical_core.persons(id),
 withdrawn_at timestamptz not null default clock_timestamp()
);
create trigger program_curriculum_media_withdrawals_append_only before update or delete on clinical_core.program_curriculum_media_withdrawals
 for each row execute function clinical_private.block_update_delete();

alter table clinical_core.program_curriculum_media_admissions enable row level security;
alter table clinical_core.program_curriculum_media_admissions force row level security;
alter table clinical_core.program_curriculum_media_withdrawals enable row level security;
alter table clinical_core.program_curriculum_media_withdrawals force row level security;
revoke all on clinical_core.program_curriculum_media_admissions,clinical_core.program_curriculum_media_withdrawals
 from public,clinical_core_api,program_media_authority,program_media_worker;

-- What the owner of the functions below may see. Every read is filtered again in the function body; the
-- policies only let a non-bypass owner see the rows it must examine.
grant select on clinical_core.program_media_learner_delivery,clinical_core.program_media_activation,clinical_core.program_media_artifacts,
 clinical_core.program_media_publications,clinical_core.program_media_text_snapshots,clinical_core.synthetic_desktop_programs,
 clinical_core.synthetic_desktop_program_versions,commercial_education.program_entitlements,commercial_education.program_education_enrollments
 to program_media_learner_authority;
grant select,insert on clinical_core.program_curriculum_media_admissions,clinical_core.program_curriculum_media_withdrawals to program_media_learner_authority;
create policy learner_media_delivery_read on clinical_core.program_media_learner_delivery for select to program_media_learner_authority using(true);
create policy learner_media_activation_read on clinical_core.program_media_activation for select to program_media_learner_authority using(true);
create policy learner_media_artifact_read on clinical_core.program_media_artifacts for select to program_media_learner_authority using(true);
create policy learner_media_publication_read on clinical_core.program_media_publications for select to program_media_learner_authority using(true);
create policy learner_media_text_read on clinical_core.program_media_text_snapshots for select to program_media_learner_authority using(true);
create policy learner_media_program_read on clinical_core.synthetic_desktop_programs for select to program_media_learner_authority using(true);
create policy learner_media_version_read on clinical_core.synthetic_desktop_program_versions for select to program_media_learner_authority using(true);
create policy learner_media_entitlement_read on commercial_education.program_entitlements for select to program_media_learner_authority using(true);
create policy learner_media_enrollment_read on commercial_education.program_education_enrollments for select to program_media_learner_authority using(true);
create policy learner_media_admission_rw on clinical_core.program_curriculum_media_admissions to program_media_learner_authority using(true) with check(true);
create policy learner_media_withdrawal_rw on clinical_core.program_curriculum_media_withdrawals to program_media_learner_authority using(true) with check(true);

-- Fires when a version becomes published (by insert or by the publish command). Each nativeMedia
-- reference must be a recorded publication of this clinic and program, still current; otherwise the
-- whole publish is refused and nothing is admitted.
create function clinical_private.program_curriculum_media_admit() returns trigger
language plpgsql security definer set search_path='' as $$
declare _content jsonb; _phase jsonb; _item jsonb; _ref jsonb; _slot bigint;
 p clinical_core.program_media_publications%rowtype; a clinical_core.program_media_artifacts%rowtype; _origin text;
begin
 if new.status<>'published' or (tg_op='UPDATE' and old.status='published') then return null; end if;
 _content:=clinical_private.program_consumer_content(new.content);
 if _content is null then return null; end if;
 select public_origin into _origin from clinical_core.program_media_activation where singleton;
 for _phase in select value from jsonb_array_elements(_content->'phases') loop
  for _item in select value from jsonb_array_elements(_phase->'items') loop
   if _item ? 'nativeMedia' then
    for _ref,_slot in select value,ordinality-1 from jsonb_array_elements(_item->'nativeMedia') with ordinality loop
     if _ref->'origin'->>'clinic' is distinct from new.organization_id::text or _ref->'origin'->>'programId' is distinct from new.program_id::text then
      raise exception using errcode='42501',message='program_media_admission_foreign'; end if;
     select * into p from clinical_core.program_media_publications
      where artifact_id=(_ref->>'artifactId')::uuid and organization_id=new.organization_id and reference=_ref
      order by published_at limit 1;
     if p.id is null then raise exception using errcode='42501',message='program_media_admission_unrecorded'; end if;
     select * into a from clinical_core.program_media_artifacts where id=p.artifact_id;
     if a.id is null or a.organization_id<>new.organization_id or a.program_id<>new.program_id then
      raise exception using errcode='42501',message='program_media_admission_foreign'; end if;
     if a.state<>'ready' or a.object_version is null then raise exception using errcode='42501',message='program_media_admission_not_ready'; end if;
     if a.version<>p.version or a.sha256<>p.sha256 then raise exception using errcode='42501',message='program_media_admission_stale'; end if;
     if _origin is null or p.url is distinct from _origin||a.object_key then
      raise exception using errcode='42501',message='program_media_admission_address'; end if;
     insert into clinical_core.program_curriculum_media_admissions(organization_id,program_id,curriculum_version_id,curriculum_version,
      phase_id,item_id,slot,publication_id,artifact_id,artifact_version,sha256,reference)
      values(new.organization_id,new.program_id,new.id,new.version,_phase->>'id',_item->>'id',_slot,p.id,a.id,p.version,p.sha256,_ref);
    end loop;
   end if;
  end loop;
 end loop;
 return null;
end $$;
create trigger program_curriculum_media_admit after insert or update of status on clinical_core.synthetic_desktop_program_versions
 for each row execute function clinical_private.program_curriculum_media_admit();

/* -------------------------------------------------------------- read shape */

create function clinical_private.program_learner_media_text(_publication uuid,_reference jsonb,_slot text) returns jsonb
language sql stable security definer set search_path='' as $$
 select case
  when jsonb_typeof(_reference->_slot) is distinct from 'object' then jsonb_build_object('state','none')
  else coalesce((select jsonb_build_object('state','available','source',s.source,'format',s.format,'sha256',s.sha256,'text',s.body)
   from clinical_core.program_media_text_snapshots s where s.publication_id=_publication and s.slot=_slot
    and s.sha256=_reference->_slot->>'sha256'),jsonb_build_object('state','unavailable'))
 end
$$;

-- One admitted slot, after authority has been decided by the caller function. Null when the slot is not
-- servable (withdrawn, or the artifact has no committed object), which callers report as a refusal.
create function clinical_private.program_learner_media_slot(_version clinical_core.synthetic_desktop_program_versions,_phase text,_item text,_slot integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _content jsonb; _ref jsonb; _found jsonb; adm clinical_core.program_curriculum_media_admissions%rowtype;
 p clinical_core.program_media_publications%rowtype; a clinical_core.program_media_artifacts%rowtype;
begin
 if _slot is null or _slot not between 0 and 4 then return null; end if;
 _content:=clinical_private.program_consumer_content(_version.content);
 if _content is null then return null; end if;
 select i.value into _found from jsonb_array_elements(_content->'phases') ph, jsonb_array_elements(ph.value->'items') i
  where ph.value->>'id'=_phase and i.value->>'id'=_item;
 if _found is null or (_found->>'released')::boolean is not true or jsonb_typeof(_found->'nativeMedia') is distinct from 'array' then return null; end if;
 _ref:=_found->'nativeMedia'->_slot;
 if _ref is null then return null; end if;
 select * into adm from clinical_core.program_curriculum_media_admissions
  where curriculum_version_id=_version.id and phase_id=_phase and item_id=_item and slot=_slot and reference=_ref;
 if adm.id is null or exists(select 1 from clinical_core.program_curriculum_media_withdrawals w where w.admission_id=adm.id) then return null; end if;
 select * into p from clinical_core.program_media_publications where id=adm.publication_id and reference=adm.reference;
 select * into a from clinical_core.program_media_artifacts where id=adm.artifact_id;
 -- A retired artifact's committed bytes stay readable for the version that admitted them; nothing else moves.
 if p.id is null or a.id is null or a.state not in('ready','retired') or a.object_version is null or a.sha256<>adm.sha256
  or a.organization_id<>_version.organization_id or a.program_id<>_version.program_id then return null; end if;
 return jsonb_build_object('admissionId',adm.id,'publicationId',p.id,
  'lesson',jsonb_build_object('phaseId',_phase,'itemId',_item),'slot',_slot,
  'media',jsonb_build_object('artifactId',a.id,'version',adm.artifact_version,'sha256',a.sha256,'kind',a.kind,'contentType',a.content_type,'bytes',a.bytes),
  'object',jsonb_build_object('key',a.object_key,'version',a.object_version,'clinic',a.organization_id,'programId',a.program_id),
  'caption',clinical_private.program_learner_media_text(p.id,adm.reference,'caption'),
  'transcript',clinical_private.program_learner_media_text(p.id,adm.reference,'transcript'));
end $$;

/* -------------------------------------------------------------- learner read (consumer host) */

create function commercial_education.education_media_for_caller(_entitlement uuid,_phase text,_item text,_slot integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _subject text; e commercial_education.program_entitlements%rowtype; n commercial_education.program_education_enrollments%rowtype;
 v clinical_core.synthetic_desktop_program_versions%rowtype; _items jsonb; _slot_json jsonb; _now timestamptz:=clock_timestamp();
 _refused constant jsonb:=jsonb_build_object('outcome','refused');
begin
 perform commercial_education.require_activation();
 _subject:=commercial_education.caller_consumer_subject();
 if not coalesce((select enabled from clinical_core.program_media_learner_delivery where singleton),false) then
  return jsonb_build_object('outcome','held'); end if;
 select * into e from commercial_education.program_entitlements where id=_entitlement and subject_kind='claimed' and consumer_subject=_subject;
 if e.id is null or e.state<>'active' or e.window_starts_at>_now or (e.window_ends_at is not null and e.window_ends_at<=_now) then return _refused; end if;
 select * into n from commercial_education.program_education_enrollments where entitlement_id=e.id;
 if n.id is null or n.state<>'active' or n.consumer_subject<>_subject or n.curriculum_version_id<>e.curriculum_version_id
  or n.curriculum_version<>e.curriculum_version or n.curriculum_source_digest<>e.curriculum_source_digest then return _refused; end if;
 select * into v from clinical_core.synthetic_desktop_program_versions
  where id=e.curriculum_version_id and version=e.curriculum_version and organization_id=e.organization_id and program_id=e.program_id;
 if v.id is null then return _refused; end if;
 _items:=clinical_private.program_consumer_content(v.content);
 if _items is null or encode(sha256(convert_to((_items->'phases')::text,'UTF8')),'hex')<>e.curriculum_source_digest then return _refused; end if;
 _slot_json:=clinical_private.program_learner_media_slot(v,_phase,_item,_slot);
 if _slot_json is null then return _refused; end if;
 return jsonb_build_object('outcome','authorized','entitlementId',e.id,
  'curriculum',jsonb_build_object('versionId',e.curriculum_version_id,'version',e.curriculum_version,'sourceDigest',e.curriculum_source_digest))||_slot_json;
end $$;

/* -------------------------------------------------------------- staff read (workforce host) */

create function clinical_core.program_media_admitted_for_staff(_version uuid,_phase text,_item text,_slot integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v clinical_core.synthetic_desktop_program_versions%rowtype; _slot_json jsonb; _org uuid:=clinical_private.organization_id();
 _refused constant jsonb:=jsonb_build_object('outcome','refused');
begin
 -- Someone who is not an active clinician of a clinic gets the same answer as any other refusal.
 if clinical_private.claim('identity_pool') is distinct from 'workforce' or clinical_private.actor_person_id() is null or _org is null
  or not clinical_private.has_clinical_role(_org) then return _refused; end if;
 if not coalesce((select enabled from clinical_core.program_media_learner_delivery where singleton),false) then
  return jsonb_build_object('outcome','held'); end if;
 select * into v from clinical_core.synthetic_desktop_program_versions where id=_version and organization_id=_org and status in('published','superseded');
 if v.id is null then return _refused; end if;
 _slot_json:=clinical_private.program_learner_media_slot(v,_phase,_item,_slot);
 if _slot_json is null then return _refused; end if;
 return jsonb_build_object('outcome','authorized','curriculum',jsonb_build_object('versionId',v.id,'version',v.version))||_slot_json;
end $$;

/* -------------------------------------------------------------- withdrawal */

create function clinical_core.withdraw_curriculum_media(_admission uuid,_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare adm clinical_core.program_curriculum_media_admissions%rowtype; _org uuid:=clinical_private.organization_id(); _actor uuid:=clinical_private.actor_person_id();
begin
 if clinical_private.claim('identity_pool') is distinct from 'workforce' or _actor is null or _org is null
  or not clinical_private.has_program_author_role(_org) then raise exception using errcode='42501',message='program_media_withdrawal_refused'; end if;
 select * into adm from clinical_core.program_curriculum_media_admissions where id=_admission and organization_id=_org;
 if adm.id is null then raise exception using errcode='P0002',message='program_media_admission_not_found'; end if;
 if _reason is null or _reason not in('content_error','rights_withdrawn','privacy','corrected') then
  raise exception using errcode='22023',message='program_media_withdrawal_reason'; end if;
 insert into clinical_core.program_curriculum_media_withdrawals(admission_id,organization_id,reason,withdrawn_by)
  values(adm.id,_org,_reason,_actor) on conflict (admission_id) do nothing;
 return (select jsonb_build_object('admissionId',w.admission_id,'reason',w.reason,'withdrawnAt',w.withdrawn_at)
  from clinical_core.program_curriculum_media_withdrawals w where w.admission_id=adm.id);
end $$;

/* -------------------------------------------------------------- ownership and execution */

grant create on schema clinical_core,clinical_private,commercial_education to program_media_learner_authority;
grant create on schema clinical_core,clinical_private to program_media_authority;
alter function clinical_private.program_media_capture_text() owner to program_media_authority;
alter function clinical_private.program_curriculum_media_admit() owner to program_media_learner_authority;
alter function clinical_private.program_learner_media_text(uuid,jsonb,text) owner to program_media_learner_authority;
alter function clinical_private.program_learner_media_slot(clinical_core.synthetic_desktop_program_versions,text,text,integer) owner to program_media_learner_authority;
alter function commercial_education.education_media_for_caller(uuid,text,text,integer) owner to program_media_learner_authority;
alter function clinical_core.program_media_admitted_for_staff(uuid,text,text,integer) owner to program_media_learner_authority;
alter function clinical_core.withdraw_curriculum_media(uuid,text) owner to program_media_learner_authority;
revoke create on schema clinical_core,clinical_private,commercial_education from program_media_learner_authority;
revoke create on schema clinical_core,clinical_private from program_media_authority;

revoke all on function clinical_private.program_media_capture_text(),clinical_private.program_curriculum_media_admit(),
 clinical_private.program_learner_media_text(uuid,jsonb,text),
 clinical_private.program_learner_media_slot(clinical_core.synthetic_desktop_program_versions,text,text,integer),
 commercial_education.education_media_for_caller(uuid,text,text,integer),
 clinical_core.program_media_admitted_for_staff(uuid,text,text,integer),
 clinical_core.withdraw_curriculum_media(uuid,text) from public;
grant execute on function commercial_education.education_media_for_caller(uuid,text,text,integer),
 clinical_core.program_media_admitted_for_staff(uuid,text,text,integer),
 clinical_core.withdraw_curriculum_media(uuid,text) to clinical_core_api;
