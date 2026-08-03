-- Phase 9E-A.2: extend product_label_versions to a full governed editor.
-- Additive: adds columns for the fields a practitioner actually needs to
-- record from a physical label; adds a trigger enforcing immutability of
-- verified versions (any UPDATE to a verified row raises 55000);
-- adds three governed RPCs: create draft, verify, supersede.
--
-- The lifecycle is:
--   draft (mutable) -> verified (IMMUTABLE) -> supersede (new draft appears,
--   verified original stays, new draft can be verified in turn).
--
-- Unknown information stays unknown. The RPCs never infer facts from names
-- or descriptions. Verification demands exact identity + required fields.

alter table public.product_label_versions
  add column if not exists ingredients jsonb not null default '[]'::jsonb,
  add column if not exists other_ingredients text,
  add column if not exists allergens text,
  add column if not exists contraindications text,
  add column if not exists warnings_text text,
  add column if not exists storage_instructions text,
  add column if not exists serving_size text,
  add column if not exists label_image_ref text,
  add column if not exists observed_date date,
  add column if not exists supersedes_id uuid references public.product_label_versions(id) on delete restrict,
  add column if not exists jurisdiction text;

create index if not exists product_label_versions_supersedes_idx
  on public.product_label_versions(supersedes_id) where supersedes_id is not null;

create or replace function private.enforce_verified_label_immutable()
returns trigger language plpgsql security invoker set search_path to '' as $function$
begin
  if TG_OP = 'UPDATE' and OLD.status = 'verified' then
    if NEW.exact_label is distinct from OLD.exact_label
       or NEW.label_sha256 is distinct from OLD.label_sha256
       or NEW.product_name is distinct from OLD.product_name
       or NEW.brand is distinct from OLD.brand
       or NEW.product_code is distinct from OLD.product_code
       or NEW.version is distinct from OLD.version
       or NEW.source_url is distinct from OLD.source_url
       or NEW.effective_at is distinct from OLD.effective_at
       or NEW.verified_at is distinct from OLD.verified_at
       or NEW.verified_by is distinct from OLD.verified_by
       or NEW.verification_note is distinct from OLD.verification_note
       or NEW.ingredients is distinct from OLD.ingredients
       or NEW.other_ingredients is distinct from OLD.other_ingredients
       or NEW.allergens is distinct from OLD.allergens
       or NEW.contraindications is distinct from OLD.contraindications
       or NEW.warnings_text is distinct from OLD.warnings_text
       or NEW.storage_instructions is distinct from OLD.storage_instructions
       or NEW.serving_size is distinct from OLD.serving_size
       or NEW.label_image_ref is distinct from OLD.label_image_ref
       or NEW.observed_date is distinct from OLD.observed_date
       or NEW.jurisdiction is distinct from OLD.jurisdiction
    then
      raise exception 'a verified label is immutable; open a new draft via supersede_product_label_version'
        using errcode = '55000';
    end if;
  end if;
  if TG_OP = 'DELETE' and OLD.status = 'verified' then
    raise exception 'a verified label cannot be deleted' using errcode = '55000';
  end if;
  return case TG_OP when 'DELETE' then OLD else NEW end;
end;
$function$;

drop trigger if exists product_label_versions_verified_immutable on public.product_label_versions;
create trigger product_label_versions_verified_immutable
  before update or delete on public.product_label_versions
  for each row execute function private.enforce_verified_label_immutable();

-- NOTE: `create_product_label_draft` and `supersede_product_label_version`
-- final bodies live in migration 20260803232219 (fix uses extensions.digest,
-- not pg_catalog.digest which does not exist). This migration installs the
-- placeholder bodies that were superseded.

create or replace function public.create_product_label_draft(
  _organization_id uuid,
  _product_code text,
  _product_name text,
  _brand text,
  _exact_label jsonb,
  _source_url text default null,
  _serving_size text default null,
  _ingredients jsonb default '[]'::jsonb,
  _other_ingredients text default null,
  _allergens text default null,
  _contraindications text default null,
  _warnings_text text default null,
  _storage_instructions text default null,
  _observed_date date default null,
  _jurisdiction text default null,
  _label_image_ref text default null
) returns jsonb language sql security definer set search_path to '' as $function$
  select jsonb_build_object('ok', false,
    'error', 'placeholder — replaced by migration 20260803232219');
$function$;

create or replace function public.verify_product_label_version(
  _organization_id uuid,
  _label_version_id uuid,
  _verification_note text
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid;
  _row public.product_label_versions%rowtype;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_verification_note), '') = '' then
    raise exception 'verification requires a stated note' using errcode = '22023';
  end if;

  select * into _row from public.product_label_versions
  where id = _label_version_id for update;
  if not found then
    raise exception 'label version not found' using errcode = 'P0002';
  end if;
  if _row.organization_id <> _organization_id then
    raise exception 'label version belongs to a different tenant' using errcode = '42501';
  end if;
  if _row.status <> 'pending' then
    raise exception 'only pending drafts can be verified' using errcode = '55000';
  end if;

  if coalesce(btrim(_row.serving_size), '') = '' then
    raise exception 'serving_size is required for verification' using errcode = '22023';
  end if;
  if coalesce(jsonb_array_length(_row.ingredients), 0) = 0 then
    raise exception 'at least one ingredient is required for verification' using errcode = '22023';
  end if;
  if coalesce(btrim(_row.source_url), '') = '' and coalesce(btrim(_row.label_image_ref), '') = '' then
    raise exception 'a label source URL or label image reference is required for verification'
      using errcode = '22023';
  end if;

  update public.product_label_versions
  set status = 'verified',
      verified_at = clock_timestamp(),
      verified_by = _uid,
      verification_note = btrim(_verification_note),
      effective_at = coalesce(effective_at, clock_timestamp())
  where id = _label_version_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'product_label.verified',
     'product_label_version', _label_version_id::text,
     'Label version verified',
     jsonb_build_object('productCode', _row.product_code, 'version', _row.version));

  return jsonb_build_object('ok', true, 'id', _label_version_id, 'status', 'verified');
end;
$function$;

revoke all on function public.create_product_label_draft(uuid,text,text,text,jsonb,text,text,jsonb,text,text,text,text,text,date,text,text) from public, anon;
grant execute on function public.create_product_label_draft(uuid,text,text,text,jsonb,text,text,jsonb,text,text,text,text,text,date,text,text) to authenticated;

revoke all on function public.verify_product_label_version(uuid, uuid, text) from public, anon;
grant execute on function public.verify_product_label_version(uuid, uuid, text) to authenticated;

create or replace function public.supersede_product_label_version(
  _organization_id uuid,
  _supersedes_id uuid,
  _exact_label jsonb,
  _reason text,
  _serving_size text default null,
  _ingredients jsonb default '[]'::jsonb,
  _other_ingredients text default null,
  _allergens text default null,
  _contraindications text default null,
  _warnings_text text default null,
  _storage_instructions text default null,
  _source_url text default null,
  _observed_date date default null
) returns jsonb language sql security definer set search_path to '' as $function$
  select jsonb_build_object('ok', false,
    'error', 'placeholder — replaced by migration 20260803232219');
$function$;

revoke all on function public.supersede_product_label_version(uuid, uuid, jsonb, text, text, jsonb, text, text, text, text, text, text, date) from public, anon;
grant execute on function public.supersede_product_label_version(uuid, uuid, jsonb, text, text, jsonb, text, text, text, text, text, text, date) to authenticated;

create or replace function public.list_product_label_versions(
  _organization_id uuid,
  _product_code text
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _rows jsonb;
begin
  if _uid is null then raise exception 'authentication required' using errcode='28000'; end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id=_organization_id and user_id=_uid and status='active') then
    raise exception 'not a member of this organization' using errcode='42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id, 'version', v.version, 'status', v.status,
    'productName', v.product_name, 'brand', v.brand,
    'exactLabel', v.exact_label, 'labelSha256', v.label_sha256,
    'sourceUrl', v.source_url, 'servingSize', v.serving_size,
    'ingredients', v.ingredients, 'otherIngredients', v.other_ingredients,
    'allergens', v.allergens, 'contraindications', v.contraindications,
    'warningsText', v.warnings_text, 'storageInstructions', v.storage_instructions,
    'observedDate', v.observed_date, 'jurisdiction', v.jurisdiction,
    'labelImageRef', v.label_image_ref, 'supersedesId', v.supersedes_id,
    'verifiedAt', v.verified_at, 'verifiedBy', v.verified_by,
    'verificationNote', v.verification_note, 'createdAt', v.created_at,
    'createdBy', v.created_by
  ) order by v.version desc), '[]'::jsonb) into _rows
  from public.product_label_versions v
  where v.organization_id = _organization_id and v.product_code = _product_code;

  return jsonb_build_object('productCode', _product_code, 'organizationId', _organization_id,
    'versions', _rows);
end;
$function$;

revoke all on function public.list_product_label_versions(uuid, text) from public, anon;
grant execute on function public.list_product_label_versions(uuid, text) to authenticated;
