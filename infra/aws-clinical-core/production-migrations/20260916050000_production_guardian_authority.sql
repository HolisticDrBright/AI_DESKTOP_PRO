-- Reviewed guardian authority evidence. Today every consumer operation derives
-- its owner from the caller's own verified identity; no request may name a
-- ward. This table records a workforce-reviewed authority attestation with
-- evidence digest, basis and expiry so a future, separately reviewed acting-as
-- design can consult it. It grants no access by itself and seeds no rows.

create table clinical_core.guardian_authorities (
  id uuid primary key default gen_random_uuid(),
  ward_person_id uuid not null references clinical_core.persons(id),
  guardian_person_id uuid not null references clinical_core.persons(id),
  authority_basis text not null check (authority_basis in ('parent_of_minor','court_appointed_guardian','healthcare_proxy','power_of_attorney')),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_kind text not null check (evidence_kind in ('birth_record','court_order','proxy_document','power_of_attorney_document')),
  reviewed_by uuid not null references clinical_core.persons(id),
  reviewed_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_by uuid references clinical_core.persons(id),
  revoked_at timestamptz,
  check (ward_person_id<>guardian_person_id),
  check (expires_at>reviewed_at),
  check ((revoked_by is null)=(revoked_at is null))
);
create index guardian_authorities_ward on clinical_core.guardian_authorities(ward_person_id) where revoked_at is null;
alter table clinical_core.guardian_authorities enable row level security;
alter table clinical_core.guardian_authorities force row level security;
create policy guardian_authority_party on clinical_core.guardian_authorities for select to clinical_core_api
  using (guardian_person_id=(select clinical_private.owned_consumer_actor()) or ward_person_id=(select clinical_private.owned_consumer_actor()));

create function clinical_private.review_guardian_authority(_ward uuid,_guardian uuid,_basis text,_evidence_kind text,_evidence_sha256 text,_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare _reviewer uuid:=clinical_private.privacy_operator(); _id uuid;
begin
  if _ward is null or _guardian is null or _ward=_guardian or _expires_at is null or _expires_at<=clock_timestamp() then
    raise exception using errcode='22023',message='guardian_authority_invalid';
  end if;
  if not exists(select 1 from clinical_core.persons where id=_ward and status='active')
    or not exists(select 1 from clinical_core.identities i where i.person_id=_guardian and i.identity_pool='consumer' and i.status='active') then
    raise exception using errcode='22023',message='guardian_authority_invalid';
  end if;
  insert into clinical_core.guardian_authorities(ward_person_id,guardian_person_id,authority_basis,evidence_kind,evidence_sha256,reviewed_by,expires_at)
    values(_ward,_guardian,_basis,_evidence_kind,_evidence_sha256,_reviewer,_expires_at) returning id into _id;
  return _id;
end $$;

create function clinical_private.revoke_guardian_authority(_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare _reviewer uuid:=clinical_private.privacy_operator();
begin
  update clinical_core.guardian_authorities set revoked_by=_reviewer,revoked_at=clock_timestamp() where id=_id and revoked_at is null;
  if not found then raise exception using errcode='22023',message='guardian_authority_invalid'; end if;
end $$;

-- Consumer read of authorities where the caller is guardian or ward. This is
-- information only; it does not let the caller act for the other person.
create function clinical_core.list_my_guardian_authorities()
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'role',case when g.guardian_person_id=_actor then 'guardian' else 'ward' end,
    'authorityBasis',g.authority_basis,'evidenceKind',g.evidence_kind,'reviewedAt',g.reviewed_at,'expiresAt',g.expires_at,
    'active',g.revoked_at is null and g.expires_at>clock_timestamp()) order by g.reviewed_at desc),'[]'::jsonb)
    from clinical_core.guardian_authorities g where g.guardian_person_id=_actor or g.ward_person_id=_actor);
end $$;

revoke all on clinical_core.guardian_authorities from public,clinical_core_api;
grant select on clinical_core.guardian_authorities to clinical_core_api;
revoke all on function clinical_private.review_guardian_authority(uuid,uuid,text,text,text,timestamptz),clinical_private.revoke_guardian_authority(uuid),
  clinical_core.list_my_guardian_authorities() from public;
grant execute on function clinical_private.review_guardian_authority(uuid,uuid,text,text,text,timestamptz),clinical_private.revoke_guardian_authority(uuid),
  clinical_core.list_my_guardian_authorities() to clinical_core_api;
