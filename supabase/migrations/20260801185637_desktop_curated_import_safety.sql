-- Phase 9C: the curated-import safety layer.
--
-- Phase 9B built a pipeline that could stage, hash, dedupe and commit knowledge.
-- It could not yet answer four questions that matter the moment real
-- practitioner material is loaded:
--
--   1. WHICH FILES DID WE ACTUALLY SEE? A file that was never readable has to
--      leave a record saying so. Otherwise "we imported the product database"
--      and "we could not find the product database" look identical afterwards.
--   2. WHAT DID THE SOURCE ACTUALLY SAY? Normalisation is lossy and lossy is
--      fine — as long as the original cell is still there to check against.
--   3. IS THIS PRODUCT SAFE TO USE YET? An imported product is a claim about a
--      bottle nobody in this system has held. It must not be attachable to a
--      patient protocol on the strength of a spreadsheet row.
--   4. IS THIS ITEM RESTRICTED? Prescription drugs, peptides, IV therapy,
--      devices and vaccine-related material are jurisdiction-sensitive. They
--      need a named reviewer, not a default.
--
-- THE INFERENCE BOUNDARY, stated once because everything below depends on it:
--
--   A DECLARED value carries authority. A TEXT SIGNAL does not.
--
-- `private.import_restricted_flags` therefore has two kinds of output. A
-- declared `regulatoryClassification` of `peptide` produces the flag `peptide`.
-- The word "peptide" appearing in a product name produces `suspected_restricted`
-- and NOTHING ELSE — it never writes a regulatory classification, because
-- inferring a legal class from a name is exactly the failure the standing rules
-- forbid. A suspicion can only ever ADD review; it can never grant a capability
-- or settle a fact.
--
-- Nothing here imports content. This migration is the set of refusals that make
-- importing content survivable.

begin;

-- ============================================================ source inventory
--
-- One row per file the operator DECLARED, whether or not it could be read.
--
-- The two check constraints are the point of the table. `available` cannot be
-- claimed without a real digest and a byte size, and `unavailable` cannot be
-- recorded while still carrying a digest — so "we hashed it" and "we never saw
-- it" cannot both be asserted about the same file. An inventory that can be
-- filled in optimistically is not evidence of anything.
--
-- `declared_name` is a FILE NAME, never a path. Where the operator keeps their
-- clinical material is not this system's business and must not end up in a
-- database that gets dumped, replicated or supported.

create table public.clinical_import_source_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  declared_name text not null,
  source_kind text,

  availability text not null check (availability in ('available', 'unavailable')),
  content_sha256 text,
  byte_size bigint,

  /** Required when unavailable. "Not found" and "withheld" are different facts. */
  unavailable_reason text,

  declared_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  declared_by uuid references auth.users(id),

  unique (organization_id, declared_name),

  constraint cisf_name_is_not_a_path check (
    position('/' in declared_name) = 0
    and position('\' in declared_name) = 0
    and declared_name !~ '^[A-Za-z]:'
    and declared_name !~ '^~'
    and char_length(declared_name) between 1 and 260),

  constraint cisf_available_is_evidenced check (
    availability <> 'available'
    or (content_sha256 ~ '^[0-9a-f]{64}$'
        and byte_size is not null and byte_size >= 0)),

  constraint cisf_unavailable_is_honest check (
    availability <> 'unavailable'
    or (coalesce(btrim(unavailable_reason), '') <> ''
        and content_sha256 is null and byte_size is null))
);

create index cisf_org_idx on public.clinical_import_source_files (organization_id);
create index cisf_hash_idx
  on public.clinical_import_source_files (organization_id, content_sha256);

alter table public.clinical_import_source_files enable row level security;

create policy import_source_files_select on public.clinical_import_source_files
  for select to authenticated using (private.is_org_member(organization_id));

revoke insert, update, delete on public.clinical_import_source_files
  from anon, authenticated;

-- ============================================================ provenance ledger
--
-- One row per governed record that an import created, carrying the raw source
-- values beside the normalised ones.
--
-- Append-only. A provenance record that can be edited answers "where did this
-- come from?" with whatever the last writer preferred, which is worse than not
-- recording it at all: it looks like evidence.

create table public.clinical_import_provenance (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  ref_type text not null,
  ref_id uuid not null,

  batch_id uuid not null references public.clinical_knowledge_import_batches(id),
  item_id uuid not null references public.clinical_knowledge_import_items(id),

  source_file_name text,
  source_file_sha256 text,
  source_sheet text,
  source_row_number integer,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),

  /** Verbatim source values. What normalisation had to throw away lives here. */
  raw_values jsonb not null default '{}'::jsonb
    check (jsonb_typeof(raw_values) = 'object'),
  normalized_values jsonb not null default '{}'::jsonb
    check (jsonb_typeof(normalized_values) = 'object'),

  /** Facts the source did not supply. Absence recorded as absence. */
  missing_facts jsonb not null default '[]'::jsonb
    check (jsonb_typeof(missing_facts) = 'array'),
  restricted_flags text[] not null default '{}',

  imported_at timestamptz not null default now(),
  imported_by uuid references auth.users(id),

  unique (ref_type, ref_id, item_id)
);

create index cip_org_idx on public.clinical_import_provenance (organization_id);
create index cip_ref_idx on public.clinical_import_provenance (ref_type, ref_id);
create index cip_batch_idx on public.clinical_import_provenance (batch_id);
create index cip_item_idx on public.clinical_import_provenance (item_id);

alter table public.clinical_import_provenance enable row level security;

create policy import_provenance_select on public.clinical_import_provenance
  for select to authenticated using (private.is_org_member(organization_id));

revoke insert, update, delete on public.clinical_import_provenance
  from anon, authenticated;

create or replace function private.import_provenance_append_only()
returns trigger language plpgsql security definer set search_path = ''
as $fn$
begin
  raise exception 'import provenance is append-only; a record of where content came from cannot be rewritten'
    using errcode = '42501';
end;
$fn$;

create trigger import_provenance_no_update
  before update or delete on public.clinical_import_provenance
  for each row execute function private.import_provenance_append_only();

-- ====================================================== staging item extensions
--
-- `source_raw` is the verbatim row. `payload` stays the normalised view, so
-- every existing reader keeps working and nothing has to trust that
-- normalisation was correct.

alter table public.clinical_knowledge_import_items
  add column if not exists source_raw jsonb not null default '{}'::jsonb,
  add column if not exists restricted_flags text[] not null default '{}',
  add column if not exists restricted_reason text,
  add column if not exists missing_facts jsonb not null default '[]'::jsonb,
  add column if not exists candidate_matches jsonb not null default '[]'::jsonb,
  add column if not exists source_file_id uuid
    references public.clinical_import_source_files(id);

alter table public.clinical_knowledge_import_items
  add constraint ckii_source_raw_is_object
    check (jsonb_typeof(source_raw) = 'object'),
  add constraint ckii_missing_facts_is_array
    check (jsonb_typeof(missing_facts) = 'array'),
  add constraint ckii_candidate_matches_is_array
    check (jsonb_typeof(candidate_matches) = 'array');

create index ckii_source_file_idx
  on public.clinical_knowledge_import_items (source_file_id);
create index ckii_restricted_idx
  on public.clinical_knowledge_import_items (batch_id)
  where restricted_flags <> '{}';

-- `ambiguous` is a change kind of its own. It is NOT `conflict` (two rows of one
-- file claiming one identity) and NOT `add` (a row with no match). It is a row
-- that resembles something already governed closely enough that applying it
-- blind would either duplicate a product or overwrite the wrong one. Both are
-- silent failures, so the row stops and waits for a person.

alter table public.clinical_knowledge_import_items
  drop constraint clinical_knowledge_import_items_change_kind_check,
  add constraint clinical_knowledge_import_items_change_kind_check
    check (change_kind in ('add', 'change', 'unchanged', 'conflict', 'removal',
                           'ambiguous'));

alter table public.clinical_knowledge_import_items
  drop constraint clinical_knowledge_import_items_applied_ref_type_check,
  add constraint clinical_knowledge_import_items_applied_ref_type_check
    check (applied_ref_type in (
      'clinical_pathway_version', 'product_label_version',
      'supplement_product', 'supplement_product_version',
      'clinical_knowledge_source', 'clinical_knowledge_claim',
      'clinical_lab_suggestion', 'clinical_interpretation_rule',
      'clinical_intervention_class', 'protocol_template_version',
      'clinical_graph_edge'));

alter table public.clinical_knowledge_import_batches
  add column if not exists ambiguous_count integer not null default 0,
  add column if not exists restricted_count integer not null default 0;

-- ================================================== product review + restriction
--
-- An imported product enters as `draft`, `incomplete` or `needs_review`.
--
--   draft        — captured, nobody has looked at it
--   incomplete   — looked at, and the source did not supply enough to use it
--   needs_review — complete on its face and waiting for a named reviewer
--
-- The default stays `active`, so every product created before this migration —
-- and every product a practitioner enters by hand, having held the bottle —
-- keeps behaving exactly as it did. Only the import path assigns a review state.

alter table public.supplement_products
  drop constraint supplement_products_status_check,
  add constraint supplement_products_status_check
    check (status in ('active', 'discontinued', 'archived',
                      'draft', 'incomplete', 'needs_review'));

alter table public.supplement_products
  add column if not exists restricted_flags text[] not null default '{}',
  add column if not exists restricted_cleared_at timestamptz,
  add column if not exists restricted_cleared_by uuid references auth.users(id),
  add column if not exists restricted_clearance_note text;

alter table public.supplement_products
  add constraint sp_restriction_clearance_is_attributable check (
    restricted_cleared_at is null
    or (restricted_cleared_by is not null
        and coalesce(btrim(restricted_clearance_note), '') <> ''));

create index sp_review_state_idx on public.supplement_products (status);
create index sp_restricted_idx on public.supplement_products (id)
  where restricted_flags <> '{}';

-- ------------------------------------------------------------- selectability
--
-- One function, so "may this product be used?" has exactly one answer and the
-- surfaces cannot drift apart from the writes.

create or replace function private.catalog_product_is_selectable(_product_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $fn$
  select p.status = 'active'
     and (p.restricted_flags = '{}' or p.restricted_cleared_at is not null)
  from public.supplement_products p
  where p.id = _product_id;
$fn$;

create or replace function private.catalog_product_block_reason(_product_id uuid)
returns text language plpgsql stable security definer set search_path = ''
as $fn$
declare _p public.supplement_products%rowtype;
begin
  select * into _p from public.supplement_products where id = _product_id;
  if not found then
    return null;
  end if;
  if _p.status <> 'active' then
    return format(
      'the catalog product "%s" is in review state "%s". An imported product is '
      || 'a claim about a label nobody here has verified; complete its review '
      || 'before using it in a protocol.', _p.name, _p.status);
  end if;
  if _p.restricted_flags <> '{}' and _p.restricted_cleared_at is null then
    return format(
      'the catalog product "%s" is flagged as restricted (%s) and has not been '
      || 'cleared by a reviewer. Restricted items are jurisdiction-sensitive '
      || 'and require a named clinical decision.',
      _p.name, array_to_string(_p.restricted_flags, ', '));
  end if;
  return null;
end;
$fn$;

-- ------------------------------------------------- enforced on the table itself
--
-- A trigger rather than a check inside `save_protocol_draft`, deliberately. The
-- draft writer is one caller of many — the copilot, a future route and any
-- worker all reach `protocol_items` too, and a rule that lives in one RPC is
-- not a rule, it is a habit.

create or replace function private.protocol_item_catalog_gate()
returns trigger language plpgsql security definer set search_path = ''
as $fn$
declare _reason text;
begin
  if new.catalog_product_id is null then
    return new;
  end if;
  _reason := private.catalog_product_block_reason(new.catalog_product_id);
  if _reason is not null then
    raise exception 'cannot attach this product: %', _reason
      using errcode = '55000';
  end if;
  return new;
end;
$fn$;

create trigger protocol_items_catalog_gate
  before insert or update of catalog_product_id on public.protocol_items
  for each row execute function private.protocol_item_catalog_gate();

-- --------------------------------------------------- search must agree with it
--
-- Restated in full because plpgsql has no way to patch a body. The ONLY change
-- from the previous definition is the `private.catalog_product_is_selectable`
-- predicate in the WHERE clause: a product a practitioner cannot attach must
-- not be offered to them in the first place. Search and attach disagreeing is
-- how a reviewer concludes a product is usable and finds out at approval time.
--
-- No ordering term reads a commercial table. Ranking is by name; an affiliate
-- relationship cannot move a product up this list because nothing here knows
-- one exists.

create or replace function public.search_protocol_catalog(
  _organization_id uuid, _query text default null, _limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare
  _q text;
  _n integer;
  _rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  _q := nullif(btrim(coalesce(_query, '')), '');
  _n := least(greatest(coalesce(_limit, 20), 1), 50);

  select coalesce(jsonb_agg(r order by r->>'name'), '[]'::jsonb) into _rows
  from (
    select jsonb_build_object(
      'productId', p.id,
      'name', p.name,
      'form', p.form,
      'manufacturer', b.name,
      'productVersionId', lv.id,
      'labelVersion', lv.version_label,
      'servingSize', lv.serving_size,
      'effectiveFrom', lv.effective_from,
      'verificationStatus', private.catalog_verification_status(p.id, lv.id),
      'structuredIngredientCount', coalesce(ic.n, 0)
    ) as r
    from public.supplement_products p
    left join public.supplement_brands b on b.id = p.brand_id
    left join lateral (
      select v.id, v.version_label, v.serving_size, v.effective_from
      from public.supplement_product_versions v
      where v.product_id = p.id
      order by v.effective_from desc nulls last, v.created_at desc
      limit 1
    ) lv on true
    left join lateral (
      select count(*)::int as n
      from public.product_ingredient_amounts a
      where a.product_version_id = lv.id and a.ingredient_id is not null
    ) ic on true
    where private.catalog_product_is_selectable(p.id)
      and (_q is null
           or p.name ilike '%' || _q || '%'
           or coalesce(b.name, '') ilike '%' || _q || '%')
    order by p.name
    limit _n
  ) s;

  return jsonb_build_object(
    'products', _rows,
    'query', _q,
    'generatedAt', now()
  );
end;
$fn$;

-- =========================================== label identity gate for approval
--
-- "A product cannot be used in an approved protocol until a reviewer verifies
-- the exact label identity."
--
-- SCOPE, stated plainly: this gate fires for IMPORT-DERIVED products — those
-- carrying a provenance row. A product a practitioner entered by hand was
-- entered by someone looking at the bottle; a product that arrived in a
-- spreadsheet was not. Widening the gate to every catalog product would also be
-- defensible, but it would retroactively invalidate protocols approved under
-- the earlier rule, and inventing a verification event for them is precisely
-- the kind of fabrication the rest of this system exists to prevent.

create or replace function private.protocol_label_identity_gate(_version_id uuid)
returns void language plpgsql security definer set search_path = ''
as $fn$
declare _missing text;
begin
  select string_agg(distinct i.label, ', ') into _missing
  from public.protocol_items i
  join public.supplement_products p on p.id = i.catalog_product_id
  where i.version_id = _version_id
    and i.kind = 'product'
    and exists (
      select 1 from public.clinical_import_provenance pr
      where pr.ref_type = 'supplement_product' and pr.ref_id = p.id)
    and not exists (
      select 1 from public.product_label_versions lv
      where lv.product_code is not null
        and lv.status = 'verified'
        and (lv.product_code = p.sku
             or lv.product_code = p.upc
             or lv.product_code = p.manufacturer_identifier));

  if _missing is not null then
    raise exception 'these imported products have no verified label identity: %. A reviewer must check the exact label against the manufacturer before an imported product is approved for use.', _missing
      using errcode = '55000';
  end if;
end;
$fn$;

-- =============================================== restricted-content classifier
--
-- Read the two halves separately.
--
-- DECLARED (authoritative): the source stated a regulatory classification, a
-- route, or an explicit restriction. That statement is recorded as the flag it
-- is, because someone asserted it.
--
-- SIGNALLED (suspicion only): a word in free text resembles restricted
-- material. The single flag `suspected_restricted` is raised. No class is
-- named, no classification is written, and the only consequence is that a human
-- has to look. Getting this backwards — letting a name decide a legal class —
-- would let a product called "Peptide Support Blend" acquire a regulatory
-- status nobody assigned it, and a product genuinely containing a prescription
-- peptide escape one because its name is "Recovery Formula".

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
  -- ---------------------------------------------------------------- declared
  _declared := lower(btrim(coalesce(_payload ->> 'regulatoryClassification', '')));
  if _declared in ('prescription', 'peptide', 'device') then
    _flags := _flags || _declared;
  end if;

  _route := lower(btrim(coalesce(_payload ->> 'route', '')));
  if _route in ('iv', 'intravenous', 'infusion', 'im', 'intramuscular',
                'subcutaneous', 'injection') then
    _flags := _flags || 'parenteral_therapy';
  end if;

  if coalesce((_payload ->> 'vaccineRelated')::boolean, false) then
    _flags := _flags || 'vaccine_related';
  end if;

  if jsonb_typeof(_payload -> 'restrictedFlags') = 'array' then
    _flags := _flags || coalesce(array(
      select lower(btrim(value))
      from jsonb_array_elements_text(_payload -> 'restrictedFlags')
      where btrim(value) <> ''), '{}');
  end if;

  -- --------------------------------------------------------------- signalled
  --
  -- Concatenated free text, checked for restricted vocabulary. The outcome is
  -- always the same single flag; the vocabulary that matched is deliberately
  -- not recorded as a class.
  _text := lower(concat_ws(' ',
    _payload ->> 'name', _payload ->> 'productName', _payload ->> 'description',
    _payload ->> 'statement', _payload ->> 'proposition', _payload ->> 'title',
    _payload ->> 'category', _payload ->> 'form'));

  if _text ~ '(peptide|bpc-?157|tb-?500|semaglutide|tirzepatide|ipamorelin|sermorelin)'
     or _text ~ '(intravenous|\miv\M|infusion|injectable|injection)'
     or _text ~ '(vaccine|vax|mrna|spike protein)'
     or _text ~ '(prescription|\mrx\M|schedule ii|controlled substance)'
     or _text ~ '(chelation|ozone therapy|stem cell|exosome)' then
    if not ('suspected_restricted' = any(_flags)) then
      _flags := _flags || 'suspected_restricted';
    end if;
  end if;

  return (select coalesce(array_agg(distinct f order by f), '{}')
          from unnest(_flags) f);
end;
$fn$;

-- ------------------------------------------------------------ clearing it
--
-- Restriction is cleared by a named person with a stated reason, or not at all.

create or replace function public.clear_catalog_product_restriction(
  _product_id uuid, _note text)
returns jsonb language plpgsql security definer set search_path = ''
as $fn$
declare _p public.supplement_products%rowtype; _uid uuid;
begin
  select * into _p from public.supplement_products where id = _product_id for update;
  if not found then
    raise exception 'catalog product not found' using errcode = 'P0002';
  end if;
  -- Product rows are org-independent in this schema; clearance is a knowledge
  -- admin act, checked against the caller's own organization membership.
  _uid := auth.uid();
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.user_id = _uid and m.status = 'active'
      and m.role in ('owner', 'admin')) then
    raise exception 'clearing a restricted product requires an owner or admin'
      using errcode = '42501';
  end if;
  if coalesce(btrim(_note), '') = '' then
    raise exception 'clearing a restriction requires a stated reason'
      using errcode = '22023';
  end if;
  if _p.restricted_flags = '{}' then
    raise exception 'this product is not flagged as restricted'
      using errcode = '55000';
  end if;

  update public.supplement_products
  set restricted_cleared_at = now(),
      restricted_cleared_by = _uid,
      restricted_clearance_note = btrim(_note),
      updated_by = _uid,
      updated_at = now()
  where id = _product_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  select m.organization_id, _uid, 'catalog.restriction_cleared',
         'supplement_product', _product_id::text,
         'A restricted catalog product was cleared by a named reviewer',
         jsonb_build_object('flags', to_jsonb(_p.restricted_flags))
  from public.organization_memberships m
  where m.user_id = _uid and m.status = 'active'
    and m.role in ('owner', 'admin')
  limit 1;

  return jsonb_build_object('ok', true, 'productId', _product_id,
    'message', 'Restriction cleared. The product remains subject to its review '
      || 'state; clearance is not approval.');
end;
$fn$;

revoke all on function public.clear_catalog_product_restriction(uuid, text)
  from public, anon;
grant execute on function public.clear_catalog_product_restriction(uuid, text)
  to authenticated;

-- ======================================================= source-file inventory

create or replace function public.record_import_source_file(
  _organization_id uuid,
  _declared_name text,
  _source_kind text default null,
  _availability text default 'unavailable',
  _content_sha256 text default null,
  _byte_size bigint default null,
  _unavailable_reason text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $fn$
declare _uid uuid; _id uuid;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_declared_name), '') = '' then
    raise exception 'a source file needs a declared name' using errcode = '22023';
  end if;
  if _availability not in ('available', 'unavailable') then
    raise exception 'availability must be available or unavailable'
      using errcode = '22023';
  end if;
  if _availability = 'available'
     and coalesce(_content_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'a file recorded as available must carry its sha256 digest; an inventory that can be filled in without reading the file proves nothing'
      using errcode = '22023';
  end if;
  if _availability = 'unavailable'
     and coalesce(btrim(_unavailable_reason), '') = '' then
    raise exception 'a file recorded as unavailable must say why; "not found" and "withheld" are different facts'
      using errcode = '22023';
  end if;

  insert into public.clinical_import_source_files
    (organization_id, declared_name, source_kind, availability,
     content_sha256, byte_size, unavailable_reason, declared_by)
  values
    (_organization_id, btrim(_declared_name), nullif(btrim(_source_kind), ''),
     _availability,
     case when _availability = 'available' then lower(btrim(_content_sha256)) end,
     case when _availability = 'available' then _byte_size end,
     case when _availability = 'unavailable' then btrim(_unavailable_reason) end,
     _uid)
  on conflict (organization_id, declared_name) do update
  set source_kind = coalesce(excluded.source_kind,
                             public.clinical_import_source_files.source_kind),
      availability = excluded.availability,
      content_sha256 = excluded.content_sha256,
      byte_size = excluded.byte_size,
      unavailable_reason = excluded.unavailable_reason,
      last_checked_at = now()
  returning id into _id;

  return jsonb_build_object('ok', true, 'sourceFileId', _id,
    'availability', _availability);
end;
$fn$;

revoke all on function public.record_import_source_file(
  uuid, text, text, text, text, bigint, text) from public, anon;
grant execute on function public.record_import_source_file(
  uuid, text, text, text, text, bigint, text) to authenticated;

create or replace function public.get_import_source_inventory(_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare _files jsonb; _available integer; _unavailable integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id, 'declaredName', f.declared_name, 'sourceKind', f.source_kind,
    'availability', f.availability, 'contentSha256', f.content_sha256,
    'byteSize', f.byte_size, 'unavailableReason', f.unavailable_reason,
    'declaredAt', f.declared_at, 'lastCheckedAt', f.last_checked_at,
    'batchCount', (
      select count(*) from public.clinical_knowledge_import_batches b
      where b.organization_id = f.organization_id
        and b.source_sha256 = f.content_sha256))
    order by f.declared_name), '[]'::jsonb),
    count(*) filter (where f.availability = 'available'),
    count(*) filter (where f.availability = 'unavailable')
  into _files, _available, _unavailable
  from public.clinical_import_source_files f
  where f.organization_id = _organization_id;

  return jsonb_build_object(
    'files', _files,
    'counts', jsonb_build_object(
      'declared', coalesce(_available, 0) + coalesce(_unavailable, 0),
      'available', coalesce(_available, 0),
      'unavailable', coalesce(_unavailable, 0)),
    'emptyStateMessage',
      'No source files have been declared for this organization. Declaring a '
      || 'file records what was looked for, including files that could not be '
      || 'read — an inventory with nothing in it is not the same as an import '
      || 'that found nothing.');
end;
$fn$;

revoke all on function public.get_import_source_inventory(uuid) from public, anon;
grant execute on function public.get_import_source_inventory(uuid) to authenticated;

commit;
