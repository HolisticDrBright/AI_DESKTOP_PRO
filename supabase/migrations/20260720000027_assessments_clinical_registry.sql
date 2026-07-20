-- ============================================================================
-- 0027 — Governed assessments + shared clinical content registry
--
-- One versioned onboarding/assessment system shared by AI Longevity Pro
-- (mobile) and the desktop platform:
--   assessment_definitions      versioned questionnaire/scoring/rule pins
--   assessment_assignments      who was assigned what (full or modules)
--   assessment_responses        autosave working copy (one per assignment)
--   assessment_submissions      IMMUTABLE submitted snapshot + evaluation
--   lab_recommendation_sets/-s  deterministic, rule-derived lab candidates
--   supplement_registry_products versioned product registry mirror (approval
--                               states; authoritative owner list NOT FOUND ⇒
--                               everything seeded pending_verification)
--   protocol_templates          versioned templates (registry IDs only)
--   protocol_drafts/_items      practitioner drafts; DB-enforced approval gate
--   recommendation_decisions    append-only decision trail
--
-- SAFETY INVARIANTS (database-enforced, not just UI):
--   * submissions are append-only; only review fields may change
--   * duplicate submits are idempotent via idempotency_key
--   * every protocol item references a registry product row (FK)
--   * a protocol draft CANNOT become approved while any item's product is
--     not approval_state='approved'  ⇒ with the owner list unfound, nothing
--     can be approved until reconciliation lands
--   * patients (role='member' / patient user) can read their own rows but
--     can never write review/approval fields — those RPCs require an active
--     practitioner/admin/owner membership
--   * screening language: these are symptom-pattern screening scores, never
--     diagnoses; nothing here auto-orders labs or sends plans
--
-- Numbering note: 000026 is intentionally left unused (reserved by an
-- operator hold on a separately-planned diagnostics migration).
-- ============================================================================

-- ---------------------------------------------------------------- registry
create table public.assessment_definitions (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null,
  version          text not null,
  scoring_version  text not null,
  rule_version     text not null,
  registry_version text not null,
  content_hash     text not null,
  title            text not null,
  status           text not null default 'active' check (status in ('active','superseded')),
  effective_date   date not null,
  author           text not null,
  reviewer         text,
  approved_at      timestamptz,
  superseded_at    timestamptz,
  source           text not null,
  change_reason    text not null,
  created_at       timestamptz not null default now(),
  unique (slug, version)
);

comment on table public.assessment_definitions is
  'Versioned assessment pins. Content (questions/wording/scales) ships as the
   registry JSON whose sha256 is content_hash; the backend refuses to serve or
   score any definition whose computed hash differs from this row.';

insert into public.assessment_definitions
  (slug, version, scoring_version, rule_version, registry_version, content_hash,
   title, effective_date, author, source, change_reason)
values
  ('symptom-pattern-screening', 'q.v1', 'scoring.v2', 'labrules.v1', '2026.07.20-v1',
   '44f332df9d33c8cb7247f4e608df76623b2ccd6654928985ea642cdb6eb908d8',
   'Symptom-pattern screening (15 categories, 150 questions)',
   date '2026-07-20',
   'registry generator (expo/scripts/generate-registry-content.mjs)',
   'rork-ai-longevity-coach expo/registry/registry-content.v1.json',
   'Initial registry migration of the legacy 150-question mock questionnaire; IDs and wording preserved verbatim.');

create table public.supplement_registry_products (
  id             text not null,
  version        int  not null default 1,
  name           text not null,
  brand          text not null,
  formulation    text,
  dose_text      text,
  approval_state text not null check (approval_state in ('approved','pending_verification','rejected','superseded')),
  provenance     text not null check (provenance in ('structured-catalog','ai-prompt','owner-list','desktop-mock')),
  source_ref     text not null,
  content        jsonb not null default '{}'::jsonb,
  author         text not null default 'registry generator',
  reviewer       text,
  approved_at    timestamptz,
  superseded_at  timestamptz,
  change_reason  text not null default 'initial registry import (authoritative owner list not found)',
  created_at     timestamptz not null default now(),
  primary key (id, version)
);

comment on table public.supplement_registry_products is
  'Approved-supplement registry (versioned). The product owner''s
   authoritative list was NOT found in either repository; every seeded row is
   pending_verification and the protocol approval gate therefore rejects all
   approvals until the owner list is reconciled (docs/supplement-reconciliation.md).';

insert into public.supplement_registry_products (id, version, name, brand, formulation, dose_text, approval_state, provenance, source_ref) values
  ('prod_proomega_2000',        1, 'ProOmega 2000',                  'Nordic Naturals',        'softgel',           '2 softgels daily with meals',    'pending_verification', 'structured-catalog', 'expo/mocks/curatedProducts.ts'),
  ('prod_glucoprime',           1, 'GlucoPrime',                     'Healthgevity',           'capsule',           '1 capsule 2x daily with meals',  'pending_verification', 'structured-catalog', 'expo/mocks/curatedProducts.ts'),
  ('prod_protect_plus_10',      1, 'Protect+ 10',                    'Healthgevity',           'softgel',           '1 softgel daily with fat',       'pending_verification', 'structured-catalog', 'expo/mocks/curatedProducts.ts'),
  ('prod_liver_sauce',          1, 'Liver Sauce',                    'Quicksilver Scientific', 'liposomal liquid',  '1 tsp daily on empty stomach',   'pending_verification', 'structured-catalog', 'expo/mocks/curatedProducts.ts'),
  ('prod_liposomal_glutathione',1, 'Liposomal Glutathione Complex',  'Quicksilver Scientific', 'liposomal liquid',  '1 tsp daily on empty stomach',   'pending_verification', 'structured-catalog', 'expo/mocks/curatedProducts.ts'),
  ('prod_glutaryl',             1, 'Glutaryl Transdermal Glutathione','Auro Wellness',         'transdermal spray', '4 pumps daily on skin',          'pending_verification', 'structured-catalog', 'expo/mocks/curatedProducts.ts'),
  ('prod_mitocore',             1, 'MitoCore',                       'Orthomolecular',         'capsule',           '4 capsules daily with breakfast','pending_verification', 'structured-catalog', 'expo/mocks/curatedProducts.ts'),
  ('prod_nac_900_plus',         1, 'NAC 900+',                       'Healthgevity',           'capsule',           '1-2 capsules daily',             'pending_verification', 'structured-catalog', 'expo/mocks/curatedProducts.ts'),
  ('prod_gut_shield',           1, 'Gut Shield',                     'Healthgevity',           'powder',            '1 scoop daily',                  'pending_verification', 'ai-prompt',          'expo/providers/LabsProvider.tsx (extraction prompt)'),
  ('prod_probiota_histaminx',   1, 'ProBiota HistaminX',             'Seeking Health',         'capsule',           '1 capsule daily',                'pending_verification', 'ai-prompt',          'expo/providers/LabsProvider.tsx (extraction prompt)'),
  ('prod_sleep_deep',           1, 'Sleep Deep',                     'Healthgevity',           'capsule',           '2 capsules before bed',          'pending_verification', 'ai-prompt',          'expo/providers/LabsProvider.tsx (extraction prompt)'),
  ('prod_magnesium_glycinate_300',1,'Magnesium Glycinate 300',       'Healthgevity',           'capsule',           '1-2 capsules evening',           'pending_verification', 'ai-prompt',          'expo/providers/LabsProvider.tsx (extraction prompt)'),
  ('prod_methyl_b_complex',     1, 'Methyl B Complex',               'Healthgevity',           'capsule',           '1 capsule morning',              'pending_verification', 'ai-prompt',          'expo/providers/LabsProvider.tsx (extraction prompt)'),
  ('prod_d3_k2_5000',           1, 'D3+K2 5000',                     'Healthgevity',           'softgel',           '1 softgel morning with fat',     'pending_verification', 'ai-prompt',          'expo/providers/LabsProvider.tsx (extraction prompt)'),
  ('prod_adrenal_restore',      1, 'Adrenal Restore',                'Healthgevity',           'capsule',           '2 capsules morning',             'pending_verification', 'ai-prompt',          'expo/providers/LabsProvider.tsx (extraction prompt)');

create table public.protocol_templates (
  id            text not null,
  version       int  not null,
  name          text not null,
  status        text not null default 'draft' check (status in ('draft','approved','superseded')),
  purpose       text not null,
  content       jsonb not null,
  author        text not null default 'registry generator',
  reviewer      text,
  approved_at   timestamptz,
  superseded_at timestamptz,
  change_reason text not null default 'initial registry import',
  created_at    timestamptz not null default now(),
  primary key (id, version)
);

insert into public.protocol_templates (id, version, name, status, purpose, content) values
  ('tpl_foundation_v1', 1, 'Foundational support (draft template)', 'draft',
   'Baseline micronutrient + omega-3 foundation while labs are pending',
   '{"items":[{"supplementId":"prod_proomega_2000","doseText":"2 softgels daily with meals","schedule":"daily","durationDays":90,"monitoring":["Recheck lipids/omega-3 index at 90 days"]},{"supplementId":"prod_protect_plus_10","doseText":"1 softgel daily with fat","schedule":"daily","durationDays":90,"monitoring":["25-OH vitamin D at 90 days"]}]}'::jsonb),
  ('tpl_gut_restore_v1', 1, 'Gut restoration starter (draft template)', 'draft',
   'Support intestinal lining and microbiome while awaiting stool panel review',
   '{"items":[{"supplementId":"prod_gut_shield","doseText":"1 scoop daily","schedule":"daily","durationDays":60,"monitoring":["Symptom diary weekly"]},{"supplementId":"prod_probiota_histaminx","doseText":"1 capsule daily","schedule":"daily","durationDays":60,"monitoring":["Histamine symptom check at 2 weeks"]}]}'::jsonb);

-- ------------------------------------------------------------- assignments
create table public.assessment_assignments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id      uuid not null references public.patient_profiles(id) on delete cascade,
  definition_id   uuid not null references public.assessment_definitions(id),
  assigned_by     uuid not null references auth.users(id),
  module_ids      text[],            -- null = the complete assessment
  status          text not null default 'assigned'
                  check (status in ('assigned','in_progress','submitted','reviewed','cancelled')),
  due_at          timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index assessment_assignments_org_idx on public.assessment_assignments (organization_id, status);
create index assessment_assignments_patient_idx on public.assessment_assignments (patient_id, created_at desc);
create trigger assessment_assignments_set_updated_at
  before update on public.assessment_assignments
  for each row execute function public.set_updated_at();

create table public.assessment_responses (
  id              uuid primary key default gen_random_uuid(),
  assignment_id   uuid not null unique references public.assessment_assignments(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id      uuid not null references public.patient_profiles(id) on delete cascade,
  answers         jsonb not null default '[]'::jsonb,
  intake          jsonb not null default '{}'::jsonb,
  progress        jsonb not null default '{}'::jsonb,
  updated_by      uuid not null references auth.users(id),
  updated_at      timestamptz not null default now()
);

create table public.assessment_submissions (
  id                            uuid primary key default gen_random_uuid(),
  assignment_id                 uuid not null unique references public.assessment_assignments(id),
  organization_id               uuid not null references public.organizations(id) on delete cascade,
  patient_id                    uuid not null references public.patient_profiles(id) on delete cascade,
  definition_id                 uuid not null references public.assessment_definitions(id),
  submitted_by                  uuid not null references auth.users(id),
  submitted_at                  timestamptz not null default now(),
  idempotency_key               text not null unique,
  answers                       jsonb not null,
  intake                        jsonb not null default '{}'::jsonb,
  attestation                   jsonb not null,
  questionnaire_version         text not null,
  scoring_version               text not null,
  rule_version                  text not null,
  registry_version              text not null,
  content_hash                  text not null,
  evaluation                    jsonb not null,
  elevated_category_ids         text[] not null default '{}',
  moderate_or_higher_category_ids text[] not null default '{}',
  review_status                 text not null default 'pending_review'
                                check (review_status in ('pending_review','in_review','reviewed')),
  reviewed_by                   uuid references auth.users(id),
  reviewed_at                   timestamptz
);
create index assessment_submissions_org_idx on public.assessment_submissions (organization_id, review_status, submitted_at desc);
create index assessment_submissions_patient_idx on public.assessment_submissions (patient_id, submitted_at desc);

-- Immutability: submissions never change except the review triple, and are
-- never deleted.
create or replace function private.assessment_submission_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'assessment submissions are append-only' using errcode = '22023';
  end if;
  if new.id                  is distinct from old.id
     or new.assignment_id    is distinct from old.assignment_id
     or new.organization_id  is distinct from old.organization_id
     or new.patient_id       is distinct from old.patient_id
     or new.definition_id    is distinct from old.definition_id
     or new.submitted_by     is distinct from old.submitted_by
     or new.submitted_at     is distinct from old.submitted_at
     or new.idempotency_key  is distinct from old.idempotency_key
     or new.answers          is distinct from old.answers
     or new.intake           is distinct from old.intake
     or new.attestation      is distinct from old.attestation
     or new.questionnaire_version is distinct from old.questionnaire_version
     or new.scoring_version  is distinct from old.scoring_version
     or new.rule_version     is distinct from old.rule_version
     or new.registry_version is distinct from old.registry_version
     or new.content_hash     is distinct from old.content_hash
     or new.evaluation       is distinct from old.evaluation
     or new.elevated_category_ids is distinct from old.elevated_category_ids
     or new.moderate_or_higher_category_ids is distinct from old.moderate_or_higher_category_ids
  then
    raise exception 'submitted assessments are immutable (only review status may change)'
      using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger assessment_submissions_immutable
  before update or delete on public.assessment_submissions
  for each row execute function private.assessment_submission_guard();

-- --------------------------------------------------- lab recommendations
create table public.lab_recommendation_sets (
  id              uuid primary key default gen_random_uuid(),
  submission_id   uuid not null unique references public.assessment_submissions(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id      uuid not null references public.patient_profiles(id) on delete cascade,
  rule_version    text not null,
  created_at      timestamptz not null default now()
);

create table public.lab_recommendations (
  id                  uuid primary key default gen_random_uuid(),
  set_id              uuid not null references public.lab_recommendation_sets(id) on delete cascade,
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  patient_id          uuid not null references public.patient_profiles(id) on delete cascade,
  lab_id              text not null,
  panel_name          text not null,
  vendor              text,
  priority            text not null check (priority in ('primary','conditional')),
  source_category_ids text[] not null,
  why                 text not null,
  highest_band        text not null check (highest_band in ('moderate','elevated')),
  status              text not null default 'proposed'
                      check (status in ('proposed','approved','modified','dismissed','data_requested','order_drafted')),
  decision_note       text,
  decided_by          uuid references auth.users(id),
  decided_at          timestamptz,
  created_at          timestamptz not null default now()
);
create index lab_recommendations_set_idx on public.lab_recommendations (set_id);
create index lab_recommendations_patient_idx on public.lab_recommendations (patient_id, created_at desc);

-- -------------------------------------------------------- protocol drafts
create table public.protocol_drafts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  patient_id       uuid not null references public.patient_profiles(id) on delete cascade,
  submission_id    uuid references public.assessment_submissions(id),
  template_id      text,
  template_version int,
  name             text not null,
  purpose          text not null,
  linked_goal      text,
  triggering_source text not null,
  status           text not null default 'draft'
                   check (status in ('draft','pending_approval','approved','superseded','rejected')),
  version          int  not null default 1,
  supersedes       uuid references public.protocol_drafts(id),
  schedule_summary text,
  recheck_plan     text,
  start_criteria   text,
  stop_criteria    text,
  created_by       uuid not null references auth.users(id),
  reviewed_by      uuid references auth.users(id),
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (template_id, template_version) references public.protocol_templates(id, version)
);
create index protocol_drafts_patient_idx on public.protocol_drafts (patient_id, created_at desc);
create trigger protocol_drafts_set_updated_at
  before update on public.protocol_drafts
  for each row execute function public.set_updated_at();

create table public.protocol_draft_items (
  id                     uuid primary key default gen_random_uuid(),
  draft_id               uuid not null references public.protocol_drafts(id) on delete cascade,
  product_id             text not null,
  product_version        int  not null,
  dose_text              text not null,
  schedule               text not null,
  duration_days          int,
  monitoring             text[] not null default '{}',
  contraindication_review jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  -- Every protocol item MUST reference a registry product row. Free-text
  -- supplement names cannot enter a draft at all.
  foreign key (product_id, product_version)
    references public.supplement_registry_products(id, version)
);
create index protocol_draft_items_draft_idx on public.protocol_draft_items (draft_id);

-- DB-enforced approval gate: a draft may only transition to approved when
-- every item's registry product is itself approval_state='approved'.
-- An approved draft can only move to superseded (new versions supersede).
create or replace function private.protocol_draft_approval_guard()
returns trigger language plpgsql as $$
declare _bad int;
begin
  if old.status = 'approved' and new.status not in ('approved','superseded') then
    raise exception 'approved protocols are never edited in place — supersede with a new version'
      using errcode = '22023';
  end if;
  if new.status = 'approved' and old.status is distinct from 'approved' then
    select count(*) into _bad
      from public.protocol_draft_items i
      join public.supplement_registry_products p
        on p.id = i.product_id and p.version = i.product_version
     where i.draft_id = new.id
       and p.approval_state <> 'approved';
    if _bad > 0 then
      raise exception
        'protocol approval blocked: % item(s) reference products that are not approved in the supplement registry (authoritative list pending verification)', _bad
        using errcode = '22023';
    end if;
    if not exists (select 1 from public.protocol_draft_items i where i.draft_id = new.id) then
      raise exception 'protocol approval blocked: draft has no items' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger protocol_drafts_approval_gate
  before update on public.protocol_drafts
  for each row execute function private.protocol_draft_approval_guard();

-- ------------------------------------------------------ decision trail
create table public.recommendation_decisions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id      uuid not null references public.patient_profiles(id) on delete cascade,
  subject_type    text not null check (subject_type in ('lab_recommendation','protocol_draft','assessment_submission')),
  subject_id      uuid not null,
  decision        text not null check (decision in ('approve','modify','dismiss','request_data','create_order_draft','add_to_note','mark_reviewed','reject')),
  note            text,
  decided_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now()
);
create index recommendation_decisions_subject_idx on public.recommendation_decisions (subject_type, subject_id, created_at desc);

create or replace function private.recommendation_decisions_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'recommendation decisions are append-only' using errcode = '22023';
end;
$$;
create trigger recommendation_decisions_guard
  before update or delete on public.recommendation_decisions
  for each row execute function private.recommendation_decisions_append_only();

-- --------------------------------------------------------------------- RLS
alter table public.assessment_definitions       enable row level security;
alter table public.supplement_registry_products enable row level security;
alter table public.protocol_templates           enable row level security;
alter table public.assessment_assignments       enable row level security;
alter table public.assessment_responses         enable row level security;
alter table public.assessment_submissions       enable row level security;
alter table public.lab_recommendation_sets      enable row level security;
alter table public.lab_recommendations          enable row level security;
alter table public.protocol_drafts              enable row level security;
alter table public.protocol_draft_items         enable row level security;
alter table public.recommendation_decisions     enable row level security;

-- Registry reference data: readable by any authenticated user; writable by
-- no one through the API (changes arrive by migration / privileged tooling).
create policy assessment_definitions_read on public.assessment_definitions
  for select to authenticated using (true);
create policy supplement_registry_read on public.supplement_registry_products
  for select to authenticated using (true);
create policy protocol_templates_read on public.protocol_templates
  for select to authenticated using (true);

-- Patient-scoped rows: the same gate the rest of the chart uses.
create policy assessment_assignments_access on public.assessment_assignments
  for select using (private.can_access_patient(patient_id));
create policy assessment_responses_access on public.assessment_responses
  for select using (private.can_access_patient(patient_id));
create policy assessment_submissions_access on public.assessment_submissions
  for select using (private.can_access_patient(patient_id));
create policy lab_recommendation_sets_access on public.lab_recommendation_sets
  for select using (private.can_access_patient(patient_id));
create policy lab_recommendations_access on public.lab_recommendations
  for select using (private.can_access_patient(patient_id));
create policy protocol_drafts_access on public.protocol_drafts
  for select using (private.can_access_patient(patient_id));
create policy protocol_draft_items_access on public.protocol_draft_items
  for select using (exists (
    select 1 from public.protocol_drafts d
    where d.id = draft_id and private.can_access_patient(d.patient_id)));
create policy recommendation_decisions_access on public.recommendation_decisions
  for select using (private.can_access_patient(patient_id));

-- All writes go through the SECURITY DEFINER RPCs below — no direct
-- INSERT/UPDATE/DELETE policies on purpose.

-- ---------------------------------------------------------------- helpers
create or replace function private.is_org_practitioner(_org uuid)
returns boolean language sql stable security definer
set search_path = 'pg_catalog','public' as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _org
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner','admin','practitioner')
  );
$$;
revoke all on function private.is_org_practitioner(uuid) from public;
grant execute on function private.is_org_practitioner(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------- RPCs

-- Assign an assessment (full or selected modules) to a patient.
create or replace function public.assign_assessment(
  _organization_id uuid,
  _patient_id      uuid,
  _slug            text,
  _version         text,
  _module_ids      text[] default null,
  _due_at          timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _def public.assessment_definitions%rowtype;
  _id  uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not private.is_org_practitioner(_organization_id) then
    raise exception 'practitioner role required' using errcode = '42501';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  select * into _def from public.assessment_definitions
   where slug = _slug and version = _version and status = 'active';
  if not found then
    raise exception 'unknown or superseded assessment definition' using errcode = '22023';
  end if;

  insert into public.assessment_assignments
    (organization_id, patient_id, definition_id, assigned_by, module_ids, due_at)
  values (_organization_id, _patient_id, _def.id, _uid, _module_ids, _due_at)
  returning id into _id;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_organization_id, _patient_id, _uid, 'assessment.assign',
    'assessment_assignment', _id::text, 'Assessment assigned',
    jsonb_build_object('slug', _slug, 'version', _version,
      'modules', coalesce(array_length(_module_ids,1), 0), 'full', _module_ids is null));

  return jsonb_build_object('id', _id, 'definitionId', _def.id, 'status', 'assigned');
end;
$$;
revoke all on function public.assign_assessment(uuid,uuid,text,text,text[],timestamptz) from public;
grant execute on function public.assign_assessment(uuid,uuid,text,text,text[],timestamptz) to authenticated;

-- Autosave the working copy (patient self-service or practitioner-assisted).
create or replace function public.autosave_assessment(
  _assignment_id uuid,
  _answers       jsonb,
  _intake        jsonb default '{}'::jsonb,
  _progress      jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _a   public.assessment_assignments%rowtype;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _a from public.assessment_assignments where id = _assignment_id;
  if not found or not private.can_access_patient(_a.patient_id) then
    raise exception 'assignment not found or access denied' using errcode = '42501';
  end if;
  if _a.status in ('submitted','reviewed','cancelled') then
    raise exception 'assignment is % — autosave closed', _a.status using errcode = '22023';
  end if;
  if jsonb_typeof(_answers) <> 'array' then
    raise exception 'answers must be a json array' using errcode = '22023';
  end if;

  insert into public.assessment_responses
    (assignment_id, organization_id, patient_id, answers, intake, progress, updated_by, updated_at)
  values (_assignment_id, _a.organization_id, _a.patient_id, _answers, _intake, _progress, _uid, now())
  on conflict (assignment_id) do update
    set answers = excluded.answers,
        intake = excluded.intake,
        progress = excluded.progress,
        updated_by = excluded.updated_by,
        updated_at = now();

  update public.assessment_assignments
     set status = 'in_progress', updated_at = now()
   where id = _assignment_id and status = 'assigned';

  return jsonb_build_object('assignmentId', _assignment_id, 'savedAt', now());
end;
$$;
revoke all on function public.autosave_assessment(uuid,jsonb,jsonb,jsonb) from public;
grant execute on function public.autosave_assessment(uuid,jsonb,jsonb,jsonb) to authenticated;

-- Immutable, idempotent submission. The EVALUATION is computed by the backend
-- against the pinned definition (content_hash verified there); this RPC
-- re-verifies the version pins against the definitions row so a stale or
-- tampered client cannot submit under a different content version.
create or replace function public.submit_assessment(
  _assignment_id         uuid,
  _idempotency_key       text,
  _answers               jsonb,
  _intake                jsonb,
  _attestation           jsonb,
  _questionnaire_version text,
  _scoring_version       text,
  _rule_version          text,
  _registry_version      text,
  _content_hash          text,
  _evaluation            jsonb,
  _elevated              text[],
  _moderate_or_higher    text[]
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _a   public.assessment_assignments%rowtype;
  _def public.assessment_definitions%rowtype;
  _existing public.assessment_submissions%rowtype;
  _id  uuid;
  _queue uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if _idempotency_key is null or length(btrim(_idempotency_key)) < 8 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  select * into _a from public.assessment_assignments where id = _assignment_id;
  if not found or not private.can_access_patient(_a.patient_id) then
    raise exception 'assignment not found or access denied' using errcode = '42501';
  end if;

  -- Idempotent replay: same key returns the original submission untouched.
  select * into _existing from public.assessment_submissions where idempotency_key = _idempotency_key;
  if found then
    return jsonb_build_object('id', _existing.id, 'replayed', true,
      'reviewStatus', _existing.review_status, 'submittedAt', _existing.submitted_at);
  end if;
  select * into _existing from public.assessment_submissions where assignment_id = _assignment_id;
  if found then
    return jsonb_build_object('id', _existing.id, 'replayed', true,
      'reviewStatus', _existing.review_status, 'submittedAt', _existing.submitted_at);
  end if;

  select * into _def from public.assessment_definitions where id = _a.definition_id;
  if _def.version is distinct from _questionnaire_version
     or _def.scoring_version is distinct from _scoring_version
     or _def.rule_version is distinct from _rule_version
     or _def.registry_version is distinct from _registry_version
     or _def.content_hash is distinct from _content_hash then
    raise exception 'submission version pins do not match the assigned definition'
      using errcode = '22023';
  end if;
  if jsonb_typeof(_answers) <> 'array' then
    raise exception 'answers must be a json array' using errcode = '22023';
  end if;
  if coalesce(btrim(_attestation->>'attestedBy'), '') = '' or (_attestation->>'attestedAt') is null then
    raise exception 'patient attestation required' using errcode = '22023';
  end if;

  insert into public.assessment_submissions
    (assignment_id, organization_id, patient_id, definition_id, submitted_by,
     idempotency_key, answers, intake, attestation,
     questionnaire_version, scoring_version, rule_version, registry_version,
     content_hash, evaluation, elevated_category_ids, moderate_or_higher_category_ids)
  values
    (_assignment_id, _a.organization_id, _a.patient_id, _a.definition_id, _uid,
     _idempotency_key, _answers, _intake, _attestation,
     _questionnaire_version, _scoring_version, _rule_version, _registry_version,
     _content_hash, _evaluation, coalesce(_elevated,'{}'), coalesce(_moderate_or_higher,'{}'))
  returning id into _id;

  update public.assessment_assignments set status = 'submitted', updated_at = now()
   where id = _assignment_id;

  -- Practitioner review-queue item (never a diagnosis, never an order).
  insert into public.review_queue_items
    (organization_id, patient_id, item_type, ref_id, title, priority, created_by)
  values
    (_a.organization_id, _a.patient_id, 'assessment', _id,
     'New assessment submitted — screening review', 'high', _uid)
  returning id into _queue;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_a.organization_id, _a.patient_id, _uid, 'assessment.submit',
    'assessment_submission', _id::text, 'Assessment submitted for practitioner review',
    jsonb_build_object('questionnaireVersion', _questionnaire_version,
      'scoringVersion', _scoring_version, 'ruleVersion', _rule_version,
      'elevatedCount', coalesce(array_length(_elevated,1),0),
      'queueItemId', _queue));

  return jsonb_build_object('id', _id, 'replayed', false,
    'reviewStatus', 'pending_review', 'queueItemId', _queue);
end;
$$;
revoke all on function public.submit_assessment(uuid,text,jsonb,jsonb,jsonb,text,text,text,text,text,jsonb,text[],text[]) from public;
grant execute on function public.submit_assessment(uuid,text,jsonb,jsonb,jsonb,text,text,text,text,text,jsonb,text[],text[]) to authenticated;

-- Store the deterministic, rule-derived lab candidates for a submission.
create or replace function public.record_lab_recommendations(
  _submission_id uuid,
  _rule_version  text,
  _items         jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _s   public.assessment_submissions%rowtype;
  _set uuid;
  _n   int := 0;
  _item jsonb;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _s from public.assessment_submissions where id = _submission_id;
  if not found or not private.can_access_patient(_s.patient_id) then
    raise exception 'submission not found or access denied' using errcode = '42501';
  end if;
  if _rule_version is distinct from _s.rule_version then
    raise exception 'rule version mismatch with submission' using errcode = '22023';
  end if;

  select id into _set from public.lab_recommendation_sets where submission_id = _submission_id;
  if found then
    return jsonb_build_object('setId', _set, 'replayed', true);
  end if;

  insert into public.lab_recommendation_sets (submission_id, organization_id, patient_id, rule_version)
  values (_submission_id, _s.organization_id, _s.patient_id, _rule_version)
  returning id into _set;

  for _item in select * from jsonb_array_elements(coalesce(_items,'[]'::jsonb)) loop
    insert into public.lab_recommendations
      (set_id, organization_id, patient_id, lab_id, panel_name, vendor, priority,
       source_category_ids, why, highest_band)
    values
      (_set, _s.organization_id, _s.patient_id,
       _item->>'labId', _item->>'panelName', _item->>'vendor',
       coalesce(_item->>'priority','primary'),
       coalesce((select array_agg(x) from jsonb_array_elements_text(_item->'sourceCategoryIds') x), '{}'),
       coalesce(_item->>'why',''),
       coalesce(_item->>'highestBand','moderate'));
    _n := _n + 1;
  end loop;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_s.organization_id, _s.patient_id, _uid, 'assessment.lab_recommendations',
    'lab_recommendation_set', _set::text, 'Rule-derived lab candidates recorded (drafts, pending review)',
    jsonb_build_object('count', _n, 'ruleVersion', _rule_version));

  return jsonb_build_object('setId', _set, 'count', _n, 'replayed', false);
end;
$$;
revoke all on function public.record_lab_recommendations(uuid,text,jsonb) from public;
grant execute on function public.record_lab_recommendations(uuid,text,jsonb) to authenticated;

-- Practitioner decision on one recommended lab. Patients cannot execute this
-- (role gate), and it never orders anything — order drafting stays a draft.
create or replace function public.decide_lab_recommendation(
  _recommendation_id uuid,
  _decision          text,
  _note              text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _r   public.lab_recommendations%rowtype;
  _status text;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _r from public.lab_recommendations where id = _recommendation_id;
  if not found then raise exception 'recommendation not found' using errcode = '42501'; end if;
  if not private.is_org_practitioner(_r.organization_id) then
    raise exception 'practitioner role required' using errcode = '42501';
  end if;
  if not private.can_access_patient(_r.patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  _status := case _decision
    when 'approve' then 'approved'
    when 'modify' then 'modified'
    when 'dismiss' then 'dismissed'
    when 'request_data' then 'data_requested'
    when 'create_order_draft' then 'order_drafted'
    else null end;
  if _status is null then
    raise exception 'unknown decision %', _decision using errcode = '22023';
  end if;

  update public.lab_recommendations
     set status = _status, decided_by = _uid, decided_at = now(), decision_note = _note
   where id = _recommendation_id;

  insert into public.recommendation_decisions
    (organization_id, patient_id, subject_type, subject_id, decision, note, decided_by)
  values (_r.organization_id, _r.patient_id, 'lab_recommendation', _recommendation_id, _decision, _note, _uid);

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_r.organization_id, _r.patient_id, _uid, 'assessment.lab_decision',
    'lab_recommendation', _recommendation_id::text, 'Lab recommendation ' || _status,
    jsonb_build_object('labId', _r.lab_id, 'decision', _decision, 'note_present', _note is not null));

  return jsonb_build_object('id', _recommendation_id, 'status', _status);
end;
$$;
revoke all on function public.decide_lab_recommendation(uuid,text,text) from public;
grant execute on function public.decide_lab_recommendation(uuid,text,text) to authenticated;

-- Create a protocol draft. Every item must reference a registry product row
-- (FK); rejected products are refused here; approval is gated by trigger.
create or replace function public.create_protocol_draft(
  _organization_id uuid,
  _patient_id      uuid,
  _submission_id   uuid,
  _template_id     text,
  _template_version int,
  _name            text,
  _purpose         text,
  _triggering_source text,
  _items           jsonb,
  _linked_goal     text default null,
  _schedule_summary text default null,
  _recheck_plan    text default null,
  _start_criteria  text default null,
  _stop_criteria   text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _id  uuid;
  _item jsonb;
  _pid text;
  _pver int;
  _state text;
  _n int := 0;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not private.is_org_practitioner(_organization_id) then
    raise exception 'practitioner role required' using errcode = '42501';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  if jsonb_typeof(_items) <> 'array' or jsonb_array_length(_items) = 0 then
    raise exception 'protocol draft needs at least one item' using errcode = '22023';
  end if;

  -- Validate every product BEFORE creating anything: unknown or rejected
  -- products abort the whole draft (no partial writes, no invented names).
  for _item in select * from jsonb_array_elements(_items) loop
    _pid  := _item->>'productId';
    _pver := coalesce((_item->>'productVersion')::int, 1);
    select approval_state into _state
      from public.supplement_registry_products
     where id = _pid and version = _pver;
    if not found then
      raise exception 'unknown supplement product: % (v%) — not in the registry', _pid, _pver
        using errcode = '22023';
    end if;
    if _state = 'rejected' then
      raise exception 'supplement product % is rejected and cannot be drafted', _pid
        using errcode = '22023';
    end if;
  end loop;

  insert into public.protocol_drafts
    (organization_id, patient_id, submission_id, template_id, template_version,
     name, purpose, linked_goal, triggering_source, schedule_summary,
     recheck_plan, start_criteria, stop_criteria, created_by)
  values
    (_organization_id, _patient_id, _submission_id, _template_id, _template_version,
     _name, _purpose, _linked_goal, _triggering_source, _schedule_summary,
     _recheck_plan, _start_criteria, _stop_criteria, _uid)
  returning id into _id;

  for _item in select * from jsonb_array_elements(_items) loop
    insert into public.protocol_draft_items
      (draft_id, product_id, product_version, dose_text, schedule, duration_days, monitoring, contraindication_review)
    values
      (_id, _item->>'productId', coalesce((_item->>'productVersion')::int, 1),
       coalesce(_item->>'doseText','per registry default'),
       coalesce(_item->>'schedule','daily'),
       nullif(_item->>'durationDays','')::int,
       coalesce((select array_agg(x) from jsonb_array_elements_text(_item->'monitoring') x), '{}'),
       coalesce(_item->'contraindicationReview', '{}'::jsonb));
    _n := _n + 1;
  end loop;

  insert into public.recommendation_decisions
    (organization_id, patient_id, subject_type, subject_id, decision, note, decided_by)
  values (_organization_id, _patient_id, 'protocol_draft', _id, 'create_order_draft',
          'Protocol draft created (' || _n || ' items)', _uid);

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_organization_id, _patient_id, _uid, 'protocol.draft_created',
    'protocol_draft', _id::text, 'Protocol draft created — pending practitioner approval',
    jsonb_build_object('items', _n, 'templateId', _template_id, 'submissionId', _submission_id));

  return jsonb_build_object('id', _id, 'items', _n, 'status', 'draft');
end;
$$;
revoke all on function public.create_protocol_draft(uuid,uuid,uuid,text,int,text,text,text,jsonb,text,text,text,text,text) from public;
grant execute on function public.create_protocol_draft(uuid,uuid,uuid,text,int,text,text,text,jsonb,text,text,text,text,text) to authenticated;

-- Attempt to approve a protocol draft. The trigger enforces the registry
-- approval gate; this RPC adds the role gate + decision trail + audit.
create or replace function public.approve_protocol_draft(
  _draft_id uuid,
  _note     text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _d   public.protocol_drafts%rowtype;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _d from public.protocol_drafts where id = _draft_id;
  if not found then raise exception 'draft not found' using errcode = '42501'; end if;
  if not private.is_org_practitioner(_d.organization_id) then
    raise exception 'practitioner role required' using errcode = '42501';
  end if;
  if not private.can_access_patient(_d.patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;

  update public.protocol_drafts
     set status = 'approved', reviewed_by = _uid, approved_at = now()
   where id = _draft_id;   -- trigger enforces the registry gate

  insert into public.recommendation_decisions
    (organization_id, patient_id, subject_type, subject_id, decision, note, decided_by)
  values (_d.organization_id, _d.patient_id, 'protocol_draft', _draft_id, 'approve', _note, _uid);

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_d.organization_id, _d.patient_id, _uid, 'protocol.approved',
    'protocol_draft', _draft_id::text, 'Protocol draft approved', '{}'::jsonb);

  return jsonb_build_object('id', _draft_id, 'status', 'approved');
end;
$$;
revoke all on function public.approve_protocol_draft(uuid,text) from public;
grant execute on function public.approve_protocol_draft(uuid,text) to authenticated;
