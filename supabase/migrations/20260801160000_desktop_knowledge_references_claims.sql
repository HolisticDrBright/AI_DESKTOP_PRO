-- Phase 9B: governed reference registry and structured claims.
--
-- EXTENDS `clinical_knowledge_sources` rather than adding a third registry. It
-- is the one `differential_questions.knowledge_source_ids` already cites, so it
-- is the governed one; the parallel `knowledge_sources` table retires here.
--
-- Two rules carry this migration:
--
--   1. A claim classified as anything stronger than practitioner experience
--      REQUIRES an exact reference. The check is a constraint, so "evidence-
--      based" cannot be asserted by typing it.
--   2. Unknown stays NULL. Nothing defaults to a plausible value, because a
--      populated field reads as a fact somebody established.
--
-- WHAT IS NOT STORED: no copyrighted document, no long copied passage. The
-- registry holds metadata, a structured summary, a content hash, and — where
-- quoting is genuinely necessary — a short excerpt bounded by a length check.

begin;

-- ------------------------------------------------------- platform authority
--
-- Platform-governed tables carry no organization_id; that is what makes the
-- distinction structural. Until now they had a read policy and NO write policy,
-- so writes were closed but no one could curate either. This is the missing
-- half: an explicit, auditable curator roster.

create table if not exists public.platform_curators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id),
  note text
);

alter table public.platform_curators enable row level security;

create policy platform_curators_select on public.platform_curators
  for select to authenticated using (auth.uid() is not null);

revoke insert, update, delete on public.platform_curators from anon, authenticated;

create or replace function private.is_platform_curator()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.platform_curators c where c.user_id = auth.uid());
$$;

revoke all on function private.is_platform_curator() from public, anon;

-- ------------------------------------------------- governed reference fields

alter table public.clinical_knowledge_sources
  add column if not exists reference_type text check (reference_type in (
    'guideline', 'systematic_review', 'meta_analysis', 'randomized_trial',
    'cohort_study', 'case_series', 'narrative_review', 'textbook', 'monograph',
    'regulatory_label', 'manufacturer_document', 'practitioner_document',
    'conceptual_framework', 'other')),
  add column if not exists title text,
  add column if not exists authors_or_issuer text,
  add column if not exists version_label text,
  add column if not exists doi text,
  add column if not exists pmid text,
  add column if not exists official_url text,
  -- For practitioner-supplied material: an identifier for the document the
  -- practice holds, never the document itself.
  add column if not exists supplied_document_id text,
  add column if not exists jurisdiction text,
  add column if not exists accessed_date date,
  -- sha256 of the source as retrieved, so a later edition is detectable
  -- without keeping a copy of the text.
  add column if not exists content_hash text,
  add column if not exists superseded_by_id uuid references public.clinical_knowledge_sources(id),
  add column if not exists evidence_classification text check (evidence_classification in (
    'high', 'moderate', 'low', 'very_low', 'practitioner_experience', 'unclassified')),
  add column if not exists reviewed_by uuid references auth.users(id),
  add column if not exists review_date date,
  add column if not exists status text not null default 'draft'
    check (status in ('draft', 'approved', 'superseded', 'withdrawn', 'expired')),
  add column if not exists expires_on date,
  -- A SHORT compliant excerpt only. The length cap is the compliance boundary,
  -- enforced here rather than trusted to whoever is typing.
  add column if not exists short_excerpt text
    check (short_excerpt is null or length(short_excerpt) <= 300),
  add column if not exists structured_summary text,
  add column if not exists created_by uuid references auth.users(id);

create index if not exists cks_status_idx on public.clinical_knowledge_sources (status);
create index if not exists cks_superseded_idx on public.clinical_knowledge_sources (superseded_by_id);
create index if not exists cks_reviewed_by_idx on public.clinical_knowledge_sources (reviewed_by);
create index if not exists cks_created_by_idx on public.clinical_knowledge_sources (created_by);
create index if not exists cks_doi_idx on public.clinical_knowledge_sources (doi) where doi is not null;
create index if not exists cks_pmid_idx on public.clinical_knowledge_sources (pmid) where pmid is not null;

-- ------------------------------------------------------- structured claims

create table public.clinical_knowledge_claims (
  id uuid primary key default gen_random_uuid(),
  -- NULL organization_id means platform-governed. A value means the claim is
  -- proprietary to that organization and isolated from every other tenant.
  organization_id uuid references public.organizations(id) on delete cascade,
  reference_id uuid references public.clinical_knowledge_sources(id),

  /** The precise proposition. Not a topic, not a summary — the actual claim. */
  proposition text not null,
  population text,
  context text,
  limitations text,

  evidence_classification text not null default 'unclassified'
    check (evidence_classification in (
      'high', 'moderate', 'low', 'very_low', 'practitioner_experience', 'unclassified')),

  /** Page, section or table within the reference, where one is available. */
  source_location text,

  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  version integer not null default 1,

  safety_status text not null default 'none'
    check (safety_status in ('none', 'caution', 'contraindication', 'urgent')),

  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'superseded', 'withdrawn')),
  superseded_by_id uuid references public.clinical_knowledge_claims(id),

  /**
   * Stamped when the reference behind this claim is superseded or withdrawn.
   * The claim is not deleted and not silently altered — it is marked, so a
   * practitioner reading it knows the ground moved underneath it.
   */
  stale_at timestamptz,
  stale_reason text,

  -- Domains are versioned (PK is code + version), so a claim cites a specific
  -- domain VERSION. Citing a bare code would let the domain's meaning drift
  -- under a claim that had already been approved against it.
  domain_code text,
  domain_version integer,
  paradigm_code text references public.clinical_paradigms(code),
  foreign key (domain_code, domain_version)
    references public.clinical_domains(code, version),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),

  /**
   * THE RULE THIS TABLE EXISTS FOR. Anything stronger than practitioner
   * experience needs an exact reference. A governed claim cannot be asserted
   * by typing a classification into a form.
   */
  constraint claim_graded_needs_reference check (
    evidence_classification in ('practitioner_experience', 'unclassified')
    or reference_id is not null)
);

create index claim_org_idx on public.clinical_knowledge_claims (organization_id);
create index claim_reference_idx on public.clinical_knowledge_claims (reference_id);
create index claim_status_idx on public.clinical_knowledge_claims (status);
create index claim_domain_idx on public.clinical_knowledge_claims (domain_code, domain_version);
create index claim_paradigm_idx on public.clinical_knowledge_claims (paradigm_code);
create index claim_superseded_idx on public.clinical_knowledge_claims (superseded_by_id);
create index claim_reviewed_by_idx on public.clinical_knowledge_claims (reviewed_by);
create index claim_created_by_idx on public.clinical_knowledge_claims (created_by);
create index claim_updated_by_idx on public.clinical_knowledge_claims (updated_by);
create index claim_stale_idx on public.clinical_knowledge_claims (stale_at)
  where stale_at is not null;

-- ------------------------------------------------------- review history

create table public.clinical_knowledge_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  reference_id uuid references public.clinical_knowledge_sources(id) on delete cascade,
  claim_id uuid references public.clinical_knowledge_claims(id) on delete cascade,
  kind text not null,
  from_status text,
  to_status text,
  detail text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (reference_id is not null or claim_id is not null)
);

create index cke_reference_idx on public.clinical_knowledge_events (reference_id, created_at desc);
create index cke_claim_idx on public.clinical_knowledge_events (claim_id, created_at desc);
create index cke_org_idx on public.clinical_knowledge_events (organization_id);
create index cke_actor_idx on public.clinical_knowledge_events (actor_user_id);

-- ------------------------------------------------------------ immutability

create or replace function private.knowledge_append_only()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'append-only: % rows cannot be modified or deleted', tg_table_name
    using errcode = '42501';
end;
$$;

create trigger clinical_knowledge_events_append_only
  before update or delete on public.clinical_knowledge_events
  for each row execute function private.knowledge_append_only();

/**
 * An APPROVED reference is frozen. Its identity, provenance and grading cannot
 * change; only its status may move onward to superseded, withdrawn or expired.
 * A reference that could be edited after approval would let every claim citing
 * it silently change meaning.
 */
create or replace function private.knowledge_reference_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.status in ('approved', 'superseded', 'withdrawn', 'expired') then
    if new.citation is distinct from old.citation
       or new.title is distinct from old.title
       or new.authors_or_issuer is distinct from old.authors_or_issuer
       or new.publisher is distinct from old.publisher
       or new.doi is distinct from old.doi
       or new.pmid is distinct from old.pmid
       or new.content_hash is distinct from old.content_hash
       or new.evidence_classification is distinct from old.evidence_classification
       or new.reference_type is distinct from old.reference_type
       or new.short_excerpt is distinct from old.short_excerpt then
      raise exception 'an approved reference is immutable; supersede it instead'
        using errcode = '42501';
    end if;
    if new.status = 'draft' then
      raise exception 'an approved reference cannot return to draft' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger clinical_knowledge_sources_protect
  before update on public.clinical_knowledge_sources
  for each row execute function private.knowledge_reference_protect();

/** An approved claim is frozen for the same reason. */
create or replace function private.knowledge_claim_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.status in ('approved', 'superseded', 'withdrawn') then
    if new.proposition is distinct from old.proposition
       or new.population is distinct from old.population
       or new.limitations is distinct from old.limitations
       or new.evidence_classification is distinct from old.evidence_classification
       or new.reference_id is distinct from old.reference_id
       or new.safety_status is distinct from old.safety_status then
      raise exception 'an approved claim is immutable; supersede it instead'
        using errcode = '42501';
    end if;
    if new.status in ('draft', 'in_review') then
      raise exception 'an approved claim cannot return to draft' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger clinical_knowledge_claims_protect
  before update on public.clinical_knowledge_claims
  for each row execute function private.knowledge_claim_protect();

/**
 * When a reference is superseded, withdrawn or expired, every claim citing it
 * is marked STALE — not deleted, not edited. A practitioner keeps reading the
 * same words and additionally learns the ground moved.
 */
create or replace function private.knowledge_cascade_stale()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.status in ('superseded', 'withdrawn', 'expired')
     and old.status is distinct from new.status then
    update public.clinical_knowledge_claims
       set stale_at = now(),
           stale_reason = 'The reference behind this claim became ' || new.status || '.'
     where reference_id = new.id and stale_at is null;
  end if;
  return new;
end;
$$;

create trigger clinical_knowledge_sources_cascade_stale
  after update on public.clinical_knowledge_sources
  for each row execute function private.knowledge_cascade_stale();

-- ------------------------------------------------------------------- RLS

alter table public.clinical_knowledge_claims enable row level security;
alter table public.clinical_knowledge_events enable row level security;

/**
 * Platform-governed rows (organization_id is null) are readable by any
 * authenticated member; organization rows are visible only to that tenant.
 */
create policy claims_select on public.clinical_knowledge_claims
  for select to authenticated
  using (organization_id is null or private.is_org_member(organization_id));

create policy knowledge_events_select on public.clinical_knowledge_events
  for select to authenticated
  using (organization_id is null or private.is_org_member(organization_id));

revoke insert, update, delete on
  public.clinical_knowledge_claims,
  public.clinical_knowledge_events,
  public.clinical_knowledge_sources
from anon, authenticated;

revoke all on function private.knowledge_append_only() from public, anon, authenticated;
revoke all on function private.knowledge_reference_protect() from public, anon, authenticated;
revoke all on function private.knowledge_claim_protect() from public, anon, authenticated;
revoke all on function private.knowledge_cascade_stale() from public, anon, authenticated;

-- --------------------------------------------------- retire the duplicate
--
-- `knowledge_sources` is empty, referenced by no foreign key, cited by nothing,
-- and carries a `body text` column intended to hold source text — which this
-- phase forbids. Keeping it would leave a second registry that new code could
-- drift into, and a copyright-shaped hole in the schema.

drop table if exists public.knowledge_sources;

commit;
