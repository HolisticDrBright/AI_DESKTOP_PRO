-- Clinical Knowledge Registry foundation.
--
-- Organization-authored pathways are versioned and approval-gated. Approved
-- versions and verified product labels are immutable; changes always create a
-- new draft/version. Copilot runs snapshot both input and output and point to
-- the exact approved pathway version used. Patient-facing actions remain in
-- the existing review/sign workflows.

begin;

alter table public.patient_profiles
  add constraint patient_profiles_id_organization_unique unique (id, organization_id);

create table public.clinical_pathways (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code            text not null,
  name            text not null,
  domain_code     text not null,
  description     text not null default '',
  created_at      timestamptz not null default now(),
  created_by      uuid not null references auth.users(id),
  retired_at      timestamptz,
  retired_by      uuid references auth.users(id),
  unique (organization_id, code),
  unique (id, organization_id)
);

create table public.clinical_pathway_versions (
  id                uuid primary key default gen_random_uuid(),
  pathway_id        uuid not null,
  organization_id   uuid not null,
  version           integer not null check (version > 0),
  status            text not null default 'draft'
                    check (status in ('draft','approved','superseded','retired')),
  content           jsonb not null,
  source_refs       jsonb not null default '[]'::jsonb,
  content_sha256    text not null check (length(content_sha256) = 64),
  change_summary    text,
  created_at        timestamptz not null default now(),
  created_by        uuid not null references auth.users(id),
  approved_at       timestamptz,
  approved_by       uuid references auth.users(id),
  superseded_by     uuid references public.clinical_pathway_versions(id),
  retired_at        timestamptz,
  retired_by        uuid references auth.users(id),
  foreign key (pathway_id, organization_id)
    references public.clinical_pathways(id, organization_id) on delete cascade,
  unique (pathway_id, version),
  unique (id, organization_id),
  check (jsonb_typeof(content) = 'object'),
  check (jsonb_typeof(source_refs) = 'array'),
  check (
    (status = 'approved' and approved_at is not null and approved_by is not null)
    or status <> 'approved'
  )
);
create unique index clinical_pathway_one_approved_idx
  on public.clinical_pathway_versions(pathway_id) where status = 'approved';
create index clinical_pathway_versions_org_idx
  on public.clinical_pathway_versions(organization_id, status, created_at desc);

create table public.product_label_versions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  product_code      text not null,
  version           integer not null check (version > 0),
  product_name      text not null,
  brand             text not null,
  exact_label       jsonb not null,
  label_sha256      text not null check (length(label_sha256) = 64),
  source_url        text,
  affiliate_url     text,
  status            text not null default 'pending'
                    check (status in ('pending','verified','expired','retired')),
  effective_at      timestamptz,
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid not null references auth.users(id),
  verified_at       timestamptz,
  verified_by       uuid references auth.users(id),
  verification_note text,
  unique (organization_id, product_code, version),
  unique (id, organization_id),
  check (jsonb_typeof(exact_label) = 'object'),
  check (
    (status = 'verified' and verified_at is not null and verified_by is not null)
    or status <> 'verified'
  )
);
create unique index product_label_one_verified_idx
  on public.product_label_versions(organization_id, product_code) where status = 'verified';
create index product_label_org_status_idx
  on public.product_label_versions(organization_id, status, product_name);

create table public.clinical_copilot_runs (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  patient_id            uuid not null,
  encounter_id          uuid references public.encounters(id),
  pathway_version_id    uuid not null,
  status                text not null default 'draft'
                        check (status in ('draft','reviewed','superseded','blocked')),
  input_snapshot        jsonb not null,
  input_sha256          text not null check (length(input_sha256) = 64),
  output_snapshot       jsonb not null,
  output_sha256         text not null check (length(output_sha256) = 64),
  safety_status         text not null
                        check (safety_status in ('clear','incomplete','blocked')),
  model                 text,
  provider              text,
  prompt_version        text,
  output_schema_version text not null,
  created_at            timestamptz not null default now(),
  created_by            uuid not null references auth.users(id),
  reviewed_at           timestamptz,
  reviewed_by           uuid references auth.users(id),
  review_note           text,
  superseded_by         uuid references public.clinical_copilot_runs(id),
  foreign key (organization_id) references public.organizations(id) on delete cascade,
  foreign key (patient_id, organization_id)
    references public.patient_profiles(id, organization_id) on delete cascade,
  foreign key (pathway_version_id, organization_id)
    references public.clinical_pathway_versions(id, organization_id),
  check (jsonb_typeof(input_snapshot) = 'object'),
  check (jsonb_typeof(output_snapshot) = 'object')
);
create index clinical_copilot_patient_idx
  on public.clinical_copilot_runs(patient_id, created_at desc);

create or replace function private.require_knowledge_editor(_organization_id uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid();
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _organization_id
      and m.user_id = _uid
      and m.status = 'active'
      and m.role in ('owner','admin','practitioner')
  ) then
    raise exception 'knowledge editor role required' using errcode = '42501';
  end if;
  return _uid;
end;
$$;

create or replace function private.require_knowledge_admin(_organization_id uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid();
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _organization_id
      and m.user_id = _uid
      and m.status = 'active'
      and m.role in ('owner','admin')
  ) then
    raise exception 'knowledge administrator role required' using errcode = '42501';
  end if;
  return _uid;
end;
$$;

revoke all on function private.require_knowledge_editor(uuid) from public, anon;
revoke all on function private.require_knowledge_admin(uuid) from public, anon;
grant execute on function private.require_knowledge_editor(uuid) to authenticated;
grant execute on function private.require_knowledge_admin(uuid) to authenticated;

create or replace function private.clinical_pathway_version_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'clinical pathway versions are append-only' using errcode = '22023';
  end if;
  if old.status <> 'draft' and (
    new.content is distinct from old.content
    or new.source_refs is distinct from old.source_refs
    or new.content_sha256 is distinct from old.content_sha256
    or new.pathway_id is distinct from old.pathway_id
    or new.organization_id is distinct from old.organization_id
    or new.version is distinct from old.version
  ) then
    raise exception 'approved clinical pathway content is immutable' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger clinical_pathway_version_guard
  before update or delete on public.clinical_pathway_versions
  for each row execute function private.clinical_pathway_version_guard();

create or replace function private.product_label_version_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'product label versions are append-only' using errcode = '22023';
  end if;
  if old.status <> 'pending' and (
    new.exact_label is distinct from old.exact_label
    or new.label_sha256 is distinct from old.label_sha256
    or new.product_name is distinct from old.product_name
    or new.brand is distinct from old.brand
    or new.product_code is distinct from old.product_code
    or new.organization_id is distinct from old.organization_id
    or new.version is distinct from old.version
  ) then
    raise exception 'verified product label content is immutable' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger product_label_version_guard
  before update or delete on public.product_label_versions
  for each row execute function private.product_label_version_guard();

create or replace function private.clinical_copilot_run_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'clinical copilot runs are append-only' using errcode = '22023';
  end if;
  if new.organization_id is distinct from old.organization_id
     or new.patient_id is distinct from old.patient_id
     or new.encounter_id is distinct from old.encounter_id
     or new.pathway_version_id is distinct from old.pathway_version_id
     or new.input_snapshot is distinct from old.input_snapshot
     or new.input_sha256 is distinct from old.input_sha256
     or new.output_snapshot is distinct from old.output_snapshot
     or new.output_sha256 is distinct from old.output_sha256
     or new.safety_status is distinct from old.safety_status
     or new.model is distinct from old.model
     or new.provider is distinct from old.provider
     or new.prompt_version is distinct from old.prompt_version
     or new.output_schema_version is distinct from old.output_schema_version
     or new.created_by is distinct from old.created_by then
    raise exception 'clinical copilot snapshots are immutable' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger clinical_copilot_runs_guard
  before update or delete on public.clinical_copilot_runs
  for each row execute function private.clinical_copilot_run_guard();

alter table public.clinical_pathways enable row level security;
alter table public.clinical_pathway_versions enable row level security;
alter table public.product_label_versions enable row level security;
alter table public.clinical_copilot_runs enable row level security;

create policy clinical_pathways_select on public.clinical_pathways
  for select to authenticated using (private.is_org_member(organization_id));
create policy clinical_pathway_versions_select on public.clinical_pathway_versions
  for select to authenticated using (private.is_org_member(organization_id));
create policy product_label_versions_select on public.product_label_versions
  for select to authenticated using (private.is_org_member(organization_id));
create policy clinical_copilot_runs_select on public.clinical_copilot_runs
  for select to authenticated using (private.can_access_patient(patient_id));

create or replace function public.create_clinical_pathway(
  _organization_id uuid, _code text, _name text, _domain_code text,
  _description text, _content jsonb, _source_refs jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _pathway_id uuid; _version_id uuid; _hash text;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_code),'') = '' or coalesce(btrim(_name),'') = ''
     or coalesce(btrim(_domain_code),'') = '' then
    raise exception 'code, name, and domain are required' using errcode = '22023';
  end if;
  if jsonb_typeof(_content) <> 'object' or jsonb_typeof(_source_refs) <> 'array' then
    raise exception 'content must be an object and sources must be an array' using errcode = '22023';
  end if;
  insert into public.clinical_pathways
    (organization_id, code, name, domain_code, description, created_by)
  values (_organization_id, lower(btrim(_code)), btrim(_name), lower(btrim(_domain_code)),
          coalesce(_description,''), _uid)
  returning id into _pathway_id;
  _hash := private.sha256_hex(_content::text);
  insert into public.clinical_pathway_versions
    (pathway_id, organization_id, version, content, source_refs, content_sha256, created_by)
  values (_pathway_id, _organization_id, 1, _content, _source_refs, _hash, _uid)
  returning id into _version_id;
  insert into public.audit_events (organization_id, actor_user_id, action, resource_type,
    resource_id, safe_message, metadata)
  values (_organization_id, _uid, 'knowledge.pathway_created', 'clinical_pathway',
    _pathway_id::text, 'Clinical pathway draft created', jsonb_build_object('version', 1));
  return jsonb_build_object('pathwayId', _pathway_id, 'versionId', _version_id, 'version', 1);
end;
$$;

create or replace function public.create_clinical_pathway_draft(
  _pathway_id uuid, _content jsonb, _source_refs jsonb default '[]'::jsonb,
  _change_summary text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _p public.clinical_pathways%rowtype; _uid uuid; _version integer; _version_id uuid;
begin
  select * into _p from public.clinical_pathways
  where id = _pathway_id and retired_at is null
  for update;
  if not found then raise exception 'clinical pathway not found' using errcode = 'P0002'; end if;
  _uid := private.require_knowledge_editor(_p.organization_id);
  if jsonb_typeof(_content) <> 'object' or jsonb_typeof(_source_refs) <> 'array' then
    raise exception 'content must be an object and sources must be an array' using errcode = '22023';
  end if;
  select coalesce(max(version), 0) + 1 into _version
  from public.clinical_pathway_versions where pathway_id = _pathway_id;
  insert into public.clinical_pathway_versions
    (pathway_id, organization_id, version, content, source_refs, content_sha256,
     change_summary, created_by)
  values (_pathway_id, _p.organization_id, _version, _content, _source_refs,
          private.sha256_hex(_content::text), _change_summary, _uid)
  returning id into _version_id;
  insert into public.audit_events (organization_id, actor_user_id, action, resource_type,
    resource_id, safe_message, metadata)
  values (_p.organization_id, _uid, 'knowledge.pathway_draft_created',
    'clinical_pathway_version', _version_id::text, 'New clinical pathway draft created',
    jsonb_build_object('version', _version));
  return jsonb_build_object('versionId', _version_id, 'version', _version);
end;
$$;

create or replace function public.approve_clinical_pathway_version(_version_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _v public.clinical_pathway_versions%rowtype; _uid uuid;
begin
  select * into _v from public.clinical_pathway_versions where id = _version_id for update;
  if not found then raise exception 'clinical pathway version not found' using errcode = 'P0002'; end if;
  _uid := private.require_knowledge_admin(_v.organization_id);
  if _v.status <> 'draft' then
    raise exception 'only a draft version can be approved' using errcode = '55000';
  end if;
  update public.clinical_pathway_versions
    set status = 'superseded', superseded_by = _version_id
    where pathway_id = _v.pathway_id and status = 'approved';
  update public.clinical_pathway_versions
    set status = 'approved', approved_at = now(), approved_by = _uid
    where id = _version_id;
  insert into public.audit_events (organization_id, actor_user_id, action, resource_type,
    resource_id, safe_message, metadata)
  values (_v.organization_id, _uid, 'knowledge.pathway_approved',
    'clinical_pathway_version', _version_id::text, 'Clinical pathway version approved',
    jsonb_build_object('version', _v.version));
end;
$$;

create or replace function public.save_product_label_version(
  _organization_id uuid, _product_code text, _product_name text, _brand text,
  _exact_label jsonb, _source_url text default null, _affiliate_url text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _version integer; _id uuid;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_product_code),'') = '' or coalesce(btrim(_product_name),'') = ''
     or coalesce(btrim(_brand),'') = '' or jsonb_typeof(_exact_label) <> 'object' then
    raise exception 'product identity and exact label object are required' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      _organization_id::text || ':product-label:' || lower(btrim(_product_code)),
      0
    )
  );
  select coalesce(max(version),0)+1 into _version from public.product_label_versions
    where organization_id = _organization_id and product_code = lower(btrim(_product_code));
  insert into public.product_label_versions
    (organization_id, product_code, version, product_name, brand, exact_label,
     label_sha256, source_url, affiliate_url, created_by)
  values (_organization_id, lower(btrim(_product_code)), _version, btrim(_product_name),
          btrim(_brand), _exact_label, private.sha256_hex(_exact_label::text),
          _source_url, _affiliate_url, _uid)
  returning id into _id;
  return jsonb_build_object('labelVersionId', _id, 'version', _version);
end;
$$;

create or replace function public.verify_product_label_version(
  _label_version_id uuid, _verification_note text default null
) returns void language plpgsql security definer set search_path = ''
as $$
declare _v public.product_label_versions%rowtype; _uid uuid;
begin
  select * into _v from public.product_label_versions where id = _label_version_id for update;
  if not found then raise exception 'product label version not found' using errcode = 'P0002'; end if;
  _uid := private.require_knowledge_admin(_v.organization_id);
  if _v.status <> 'pending' then
    raise exception 'only a pending label can be verified' using errcode = '55000';
  end if;
  update public.product_label_versions set status = 'expired'
    where organization_id = _v.organization_id and product_code = _v.product_code
      and status = 'verified';
  update public.product_label_versions
    set status = 'verified', verified_at = now(), verified_by = _uid,
        verification_note = _verification_note, effective_at = coalesce(effective_at, now())
    where id = _label_version_id;
  insert into public.audit_events (organization_id, actor_user_id, action, resource_type,
    resource_id, safe_message, metadata)
  values (_v.organization_id, _uid, 'knowledge.product_label_verified',
    'product_label_version', _label_version_id::text, 'Product label version verified',
    jsonb_build_object('productCode', _v.product_code, 'version', _v.version));
end;
$$;

create or replace function public.record_clinical_copilot_run(
  _patient_id uuid, _encounter_id uuid, _pathway_version_id uuid,
  _input_snapshot jsonb, _output_snapshot jsonb, _safety_status text,
  _model text default null, _provider text default null,
  _prompt_version text default null, _output_schema_version text default 'clinical-copilot-v1'
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _patient public.patient_profiles%rowtype; _pathway public.clinical_pathway_versions%rowtype;
        _uid uuid; _id uuid;
begin
  select * into _patient from public.patient_profiles where id = _patient_id and deleted_at is null;
  if not found then raise exception 'patient not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_patient.organization_id, _patient_id);
  select * into _pathway from public.clinical_pathway_versions
    where id = _pathway_version_id and organization_id = _patient.organization_id;
  if not found or _pathway.status <> 'approved' then
    raise exception 'an approved pathway version from this organization is required' using errcode = '55000';
  end if;
  if _encounter_id is not null and not exists (
    select 1 from public.encounters e where e.id = _encounter_id
      and e.patient_id = _patient_id and e.organization_id = _patient.organization_id
  ) then
    raise exception 'encounter does not belong to this patient' using errcode = '42501';
  end if;
  if _safety_status not in ('clear','incomplete','blocked') then
    raise exception 'invalid safety status' using errcode = '22023';
  end if;
  insert into public.clinical_copilot_runs
    (organization_id, patient_id, encounter_id, pathway_version_id, input_snapshot,
     input_sha256, output_snapshot, output_sha256, safety_status, model, provider,
     prompt_version, output_schema_version, created_by,
     status)
  values (_patient.organization_id, _patient_id, _encounter_id, _pathway_version_id,
          _input_snapshot, private.sha256_hex(_input_snapshot::text), _output_snapshot,
          private.sha256_hex(_output_snapshot::text), _safety_status, _model, _provider,
          _prompt_version, _output_schema_version, _uid,
          case when _safety_status = 'blocked' then 'blocked' else 'draft' end)
  returning id into _id;
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_patient.organization_id, _patient_id, _uid, 'knowledge.copilot_run_recorded',
    'clinical_copilot_run', _id::text, 'Clinical copilot draft recorded',
    jsonb_build_object('pathwayVersion', _pathway.version, 'safetyStatus', _safety_status));
  return _id;
end;
$$;

create or replace function public.review_clinical_copilot_run(
  _run_id uuid, _review_note text default null
) returns void language plpgsql security definer set search_path = ''
as $$
declare _run public.clinical_copilot_runs%rowtype; _uid uuid;
begin
  select * into _run from public.clinical_copilot_runs where id = _run_id for update;
  if not found then raise exception 'clinical copilot run not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_run.organization_id, _run.patient_id);
  if _run.status not in ('draft', 'blocked') then
    raise exception 'only a draft or safety-blocked copilot run can be reviewed' using errcode = '55000';
  end if;
  update public.clinical_copilot_runs
    set status = 'reviewed', reviewed_at = now(), reviewed_by = _uid,
        review_note = _review_note
    where id = _run_id;
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message)
  values (_run.organization_id, _run.patient_id, _uid, 'knowledge.copilot_run_reviewed',
    'clinical_copilot_run', _run_id::text, 'Clinical copilot draft reviewed');
end;
$$;

revoke all on table public.clinical_pathways from anon, authenticated;
revoke all on table public.clinical_pathway_versions from anon, authenticated;
revoke all on table public.product_label_versions from anon, authenticated;
revoke all on table public.clinical_copilot_runs from anon, authenticated;
grant select on table public.clinical_pathways to authenticated;
grant select on table public.clinical_pathway_versions to authenticated;
grant select on table public.product_label_versions to authenticated;
grant select on table public.clinical_copilot_runs to authenticated;

revoke all on function public.create_clinical_pathway(uuid,text,text,text,text,jsonb,jsonb) from public, anon;
revoke all on function public.create_clinical_pathway_draft(uuid,jsonb,jsonb,text) from public, anon;
revoke all on function public.approve_clinical_pathway_version(uuid) from public, anon;
revoke all on function public.save_product_label_version(uuid,text,text,text,jsonb,text,text) from public, anon;
revoke all on function public.verify_product_label_version(uuid,text) from public, anon;
revoke all on function public.record_clinical_copilot_run(uuid,uuid,uuid,jsonb,jsonb,text,text,text,text,text) from public, anon;
revoke all on function public.review_clinical_copilot_run(uuid,text) from public, anon;
grant execute on function public.create_clinical_pathway(uuid,text,text,text,text,jsonb,jsonb) to authenticated;
grant execute on function public.create_clinical_pathway_draft(uuid,jsonb,jsonb,text) to authenticated;
grant execute on function public.approve_clinical_pathway_version(uuid) to authenticated;
grant execute on function public.save_product_label_version(uuid,text,text,text,jsonb,text,text) to authenticated;
grant execute on function public.verify_product_label_version(uuid,text) to authenticated;
grant execute on function public.record_clinical_copilot_run(uuid,uuid,uuid,jsonb,jsonb,text,text,text,text,text) to authenticated;
grant execute on function public.review_clinical_copilot_run(uuid,text) to authenticated;

commit;
