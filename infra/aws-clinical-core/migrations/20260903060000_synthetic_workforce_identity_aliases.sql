-- Allow an explicitly reviewed synthetic workforce login to resolve to an
-- existing synthetic practitioner identity. This is intentionally limited to
-- workforce identities; consumer identity linking remains one subject per
-- person and aliases cannot be created by the API role.

create table clinical_core.synthetic_workforce_identity_aliases (
  id uuid primary key default gen_random_uuid(),
  canonical_identity_id uuid not null references clinical_core.identities(id),
  alias_identity_subject text not null unique
    check (alias_identity_subject ~ '^[A-Za-z0-9:_-]{8,128}$'),
  synthetic_attested boolean not null check (synthetic_attested = true),
  status text not null default 'active' check (status in ('active','disabled')),
  reviewed_by_person_id uuid not null references clinical_core.persons(id),
  reviewed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (canonical_identity_id, alias_identity_subject)
);

create index synthetic_workforce_identity_aliases_identity_idx
  on clinical_core.synthetic_workforce_identity_aliases(canonical_identity_id);

revoke all on clinical_core.synthetic_workforce_identity_aliases from public, clinical_core_api;
grant all privileges on clinical_core.synthetic_workforce_identity_aliases to clinical_core_migrator;

create or replace function clinical_private.set_request_context(
  _actor_person_id uuid,
  _organization_id uuid,
  _identity_pool text,
  _identity_subject text,
  _purpose text,
  _environment text,
  _data_classification text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if _identity_pool not in ('workforce','consumer')
    or _purpose not in ('identity_link','consent_management','clinical_data')
    or _environment <> 'synthetic-staging'
    or _data_classification <> 'synthetic_only'
    or not exists (
      select 1
      from clinical_core.identities i
      join clinical_core.persons p on p.id = i.person_id
      where i.person_id = _actor_person_id
        and i.identity_pool = _identity_pool
        and i.synthetic_attested = true
        and i.status = 'active'
        and p.status = 'active'
        and p.contains_phi = false
        and (
          i.identity_subject = _identity_subject
          or (
            _identity_pool = 'workforce'
            and exists (
              select 1
              from clinical_core.synthetic_workforce_identity_aliases alias
              where alias.canonical_identity_id = i.id
                and alias.alias_identity_subject = _identity_subject
                and alias.synthetic_attested = true
                and alias.status = 'active'
                and alias.reviewed_at is not null
            )
          )
        )
    ) then
    raise exception using errcode = '42501', message = 'request_context_refused';
  end if;
  perform set_config('clinical.claim.actor_person_id', _actor_person_id::text, true);
  perform set_config('clinical.claim.organization_id', _organization_id::text, true);
  perform set_config('clinical.claim.identity_pool', _identity_pool, true);
  perform set_config('clinical.claim.identity_subject', _identity_subject, true);
  perform set_config('clinical.claim.purpose', _purpose, true);
  perform set_config('clinical.claim.environment', _environment, true);
  perform set_config('clinical.claim.data_classification', _data_classification, true);
end
$$;

revoke all on function clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)
  from public;
grant execute on function clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)
  to clinical_core_api;

