-- 0024 — Differential questions + clinical lens engine (Milestone 2).
--
-- Modeling rules enforced here (paired with the backend rules engine):
--   * PARADIGMS (how a practitioner frames care) are separate from DOMAINS
--     (what the engine evaluates). The practitioner selects a paradigm; the
--     engine evaluates relevant domains.
--   * Every evaluation persists an INVARIANT CLINICAL CORE (objective facts,
--     provenance, missing info, conflicts, allergies, interactions, critical
--     labs, red flags, emergency considerations, evidence quality, known
--     limitations). A lens may re-frame or re-rank non-urgent material; the
--     core is IMMUTABLE once written (guard trigger) and identical across
--     paradigms for the same inputs (enforced by the deterministic backend,
--     asserted by tests).
--   * Questions have a full lifecycle (suggested → accepted → asked →
--     answered / deferred / skipped / dismissed / superseded / stale) with a
--     validated, logged transition map. Answers are VERSIONED observations —
--     corrections append; the original is never mutated.
--   * Every evaluation snapshots its inputs, exact source versions, rule-set/
--     knowledge/model/prompt/schema versions, output hash and validation
--     result. When a supporting lab, transcript, medication, allergy or
--     supplement record changes, affected output is marked STALE — never
--     silently recomputed or replaced.
--   * Deterministic rules and AI output must cite the governed KNOWLEDGE
--     REGISTRY; an unknown source code is a hard rejection (models cannot
--     invent references). Unknown registry attributes stay NULL and display
--     as "unknown".
--   * This milestone is QUESTION-FOCUSED: outputs are questions to consider,
--     considerations, missing information, conflicts, safety observations
--     and lens framing — never autonomous diagnoses, prescriptions, dosages,
--     treatment plans or patient-facing recommendations. Accepting a question
--     never touches a note; adding content to a note is a separate explicit
--     practitioner action (audited).
--   * A failed safety rule BLOCKS the evaluation (zero questions persisted)
--     and creates a reviewable failure row — it never silently removes the
--     concerning content.
--
-- Errcodes: 28000 unauthenticated · 42501 forbidden · P0002 not found ·
-- 22023 invalid · 55000 precondition · 40003 invalid state transition.

begin;

-- note provenance can now reference lens artifacts (explicit add-to-note).
alter table public.note_provenance_refs drop constraint if exists note_provenance_refs_ref_type_check;
alter table public.note_provenance_refs add constraint note_provenance_refs_ref_type_check
  check (ref_type in ('appointment','encounter','lab_observation','lab_document',
                      'patient_form','chart_item','practitioner_entered','transcript',
                      'differential_question','lens_evaluation'));

-- ==================================================================== req 1
create table public.clinical_paradigms (
  code        text primary key,
  name        text not null,
  description text not null,
  -- 'best synergistic mix' is a transparent composition of the others, never
  -- a hidden seventh model — composite paradigms carry their member list.
  is_composite boolean not null default false,
  composed_of  text[] not null default '{}',
  created_at  timestamptz not null default now()
);

create table public.clinical_domains (
  code       text not null,
  version    integer not null default 1,
  name       text not null,
  description text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (code, version)
);

-- ==================================================================== req 5
-- Governed clinical knowledge registry. Rows are immutable; a revision is a
-- NEW row. NULL attributes mean "unknown" and must display as unknown.
create table public.clinical_knowledge_sources (
  id                        uuid primary key default gen_random_uuid(),
  code                      text not null,
  revision                  integer not null default 1,
  citation                  text not null,
  publisher                 text,
  release_date              date,
  revision_date             date,
  intended_purpose          text,
  intended_population       text,
  required_inputs           text,
  data_quality_expectations text,
  logic_summary             text,
  known_limitations         text,
  out_of_scope_uses         text,
  validation_status         text not null default 'unknown'
                              check (validation_status in ('validated','partially_validated','unvalidated','unknown')),
  funding_conflicts         text,
  created_at                timestamptz not null default now(),
  unique (code, revision)
);

-- ==================================================================== req 4
create table public.lens_evaluations (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  patient_id              uuid not null references public.patient_profiles(id) on delete cascade,
  encounter_id            uuid not null references public.encounters(id) on delete cascade,
  paradigm_code           text not null references public.clinical_paradigms(code),
  status                  text not null check (status in ('complete','blocked')),
  input_snapshot          jsonb not null,     -- gathered facts w/ per-record source refs
  input_cutoff_at         timestamptz not null,
  source_versions         jsonb not null,     -- exact source record ids + updated_at versions
  rule_set_version        text not null,
  knowledge_versions      jsonb not null,     -- registry codes+revisions consulted
  model                   text,               -- null for purely deterministic runs
  provider                text,
  prompt_template_version text,
  output_schema_version   text not null,
  output_sha256           text not null,
  -- req 2: the invariant clinical core — immutable, identical across lenses.
  invariant_core          jsonb not null,
  -- lens framing: ranking/terminology/optional extras. NEVER core content.
  lens_framing            jsonb not null default '{}'::jsonb,
  validation_result       jsonb,
  stale                   boolean not null default false,
  stale_reason            text,
  superseded_by           uuid references public.lens_evaluations(id),
  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users(id)
);
create index lens_eval_encounter_idx on public.lens_evaluations (encounter_id, paradigm_code, created_at desc);
create index lens_eval_patient_stale_idx on public.lens_evaluations (patient_id) where stale = false;

-- Reviewable safety failures (req 7): a blocked run's evidence, for humans.
create table public.lens_safety_blocks (
  id            uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references public.lens_evaluations(id) on delete cascade,
  rule_code     text not null,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  reviewed_by   uuid references auth.users(id),
  reviewed_at   timestamptz,
  resolution    text
);
create index lens_safety_eval_idx on public.lens_safety_blocks (evaluation_id);

-- ==================================================================== req 3
create table public.differential_questions (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  patient_id               uuid not null references public.patient_profiles(id) on delete cascade,
  encounter_id             uuid not null references public.encounters(id) on delete cascade,
  evaluation_id            uuid not null references public.lens_evaluations(id) on delete cascade,
  paradigm_code            text not null references public.clinical_paradigms(code),
  domain_code              text not null,
  question_text            text not null,
  rationale                text not null,          -- practitioner-facing
  distinguishes            jsonb not null default '[]'::jsonb, -- considerations it may help distinguish
  safety_relation          text,                   -- red-flag / safety relationship, when any
  priority                 text not null check (priority in ('urgent','high','medium','low')),
  answer_type              text not null check (answer_type in ('free_text','yes_no','numeric','choice','scale')),
  patient_sources          jsonb not null default '[]'::jsonb, -- patient-specific provenance (record ids + versions)
  knowledge_source_ids     uuid[] not null default '{}',
  missing_data_assumptions jsonb not null default '[]'::jsonb,
  generation_method        text not null check (generation_method in ('deterministic_rules','ai_assisted')),
  generation_version       text not null,
  dedupe_key               text not null,
  status                   text not null default 'suggested' check (status in
                             ('suggested','accepted','asked','answered','deferred','skipped',
                              'dismissed','superseded','stale')),
  status_reason            text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  updated_by               uuid references auth.users(id)
);
create index diffq_encounter_idx on public.differential_questions (encounter_id, status);
create index diffq_eval_idx on public.differential_questions (evaluation_id);
-- duplicate suppression: one live copy of a question per encounter.
create unique index diffq_dedupe_idx on public.differential_questions (encounter_id, dedupe_key)
  where status not in ('dismissed','superseded','stale');
create trigger differential_questions_set_updated_at
  before update on public.differential_questions for each row execute function public.set_updated_at();

create table public.question_status_transitions (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.differential_questions(id) on delete cascade,
  from_status text not null,
  to_status   text not null,
  reason      text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);
create index qst_question_idx on public.question_status_transitions (question_id, created_at);

-- Answers are versioned encounter observations. Corrections append a new
-- version referencing the one they correct; originals are never mutated.
create table public.question_answers (
  id               uuid primary key default gen_random_uuid(),
  question_id      uuid not null references public.differential_questions(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  patient_id       uuid not null references public.patient_profiles(id) on delete cascade,
  encounter_id     uuid not null references public.encounters(id) on delete cascade,
  version          integer not null,
  answer_value     jsonb not null,
  corrects_version integer,
  correction_reason text,
  answered_at      timestamptz not null default now(),
  answered_by      uuid not null references auth.users(id),
  unique (question_id, version)
);

create table public.question_feedback (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.differential_questions(id) on delete cascade,
  kind        text not null check (kind in ('helpful','not_relevant','unsafe','incorrect','duplicate','other')),
  comment     text,
  created_at  timestamptz not null default now(),
  created_by  uuid not null references auth.users(id)
);

-- ------------------------------------------------------------------ guards
-- Registry + transition + answer + feedback rows are append-only.
create trigger clinical_knowledge_sources_immutable
  before update or delete on public.clinical_knowledge_sources for each row execute function private.forbid_mutation();
create trigger question_status_transitions_append_only
  before update or delete on public.question_status_transitions for each row execute function private.forbid_mutation();
create trigger question_answers_append_only
  before update or delete on public.question_answers for each row execute function private.forbid_mutation();
create trigger question_feedback_append_only
  before update or delete on public.question_feedback for each row execute function private.forbid_mutation();

-- Evaluations: snapshot fields and the invariant core can never change.
-- Only stale marking and supersede links may be written after the fact.
create or replace function private.lens_evaluation_guard()
returns trigger language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'lens evaluations are append-only' using errcode = '22023';
  end if;
  if new.invariant_core is distinct from old.invariant_core
     or new.input_snapshot is distinct from old.input_snapshot
     or new.source_versions is distinct from old.source_versions
     or new.output_sha256 is distinct from old.output_sha256
     or new.lens_framing is distinct from old.lens_framing
     or new.paradigm_code is distinct from old.paradigm_code
     or new.status is distinct from old.status
     or new.rule_set_version is distinct from old.rule_set_version
     or new.knowledge_versions is distinct from old.knowledge_versions then
    raise exception 'evaluation snapshots and the invariant core are immutable' using errcode = '22023';
  end if;
  return new;
end; $$;
create trigger lens_evaluations_guard
  before update or delete on public.lens_evaluations for each row execute function private.lens_evaluation_guard();

-- Safety blocks: evidence is immutable; only the human review may be added.
create or replace function private.lens_safety_block_guard()
returns trigger language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'safety blocks are append-only' using errcode = '22023';
  end if;
  if new.rule_code is distinct from old.rule_code or new.detail is distinct from old.detail
     or new.evaluation_id is distinct from old.evaluation_id then
    raise exception 'safety-block evidence is immutable' using errcode = '22023';
  end if;
  return new;
end; $$;
create trigger lens_safety_blocks_guard
  before update or delete on public.lens_safety_blocks for each row execute function private.lens_safety_block_guard();

-- --------------------------------------------------------------------- RLS
alter table public.clinical_paradigms      enable row level security;
alter table public.clinical_domains        enable row level security;
alter table public.clinical_knowledge_sources      enable row level security;
alter table public.lens_evaluations       enable row level security;
alter table public.lens_safety_blocks     enable row level security;
alter table public.differential_questions enable row level security;
alter table public.question_status_transitions enable row level security;
alter table public.question_answers       enable row level security;
alter table public.question_feedback      enable row level security;

-- Reference data is org-independent and non-PHI: readable by any signed-in user.
create policy paradigms_select on public.clinical_paradigms for select using (auth.uid() is not null);
create policy domains_select on public.clinical_domains for select using (auth.uid() is not null);
create policy knowledge_select on public.clinical_knowledge_sources for select using (auth.uid() is not null);

create policy lens_eval_select on public.lens_evaluations
  for select using (private.can_access_patient(patient_id));
create policy lens_safety_select on public.lens_safety_blocks
  for select using (exists (select 1 from public.lens_evaluations e
    where e.id = evaluation_id and private.can_access_patient(e.patient_id)));
create policy diffq_select on public.differential_questions
  for select using (private.can_access_patient(patient_id));
create policy qst_select on public.question_status_transitions
  for select using (exists (select 1 from public.differential_questions q
    where q.id = question_id and private.can_access_patient(q.patient_id)));
create policy qa_select on public.question_answers
  for select using (private.can_access_patient(patient_id));
create policy qf_select on public.question_feedback
  for select using (exists (select 1 from public.differential_questions q
    where q.id = question_id and private.can_access_patient(q.patient_id)));

-- --------------------------------------------------- question transition map
create or replace function private.question_transition_ok(_from text, _to text)
returns boolean language sql immutable set search_path = ''
as $$
  select (_from, _to) in (
    ('suggested','accepted'),('suggested','dismissed'),('suggested','superseded'),('suggested','stale'),
    ('accepted','asked'),('accepted','deferred'),('accepted','skipped'),('accepted','dismissed'),
    ('accepted','superseded'),('accepted','stale'),
    ('asked','answered'),('asked','deferred'),('asked','superseded'),
    ('answered','superseded'),
    ('deferred','asked'),('deferred','accepted'),('deferred','skipped'),('deferred','dismissed'),
    ('deferred','superseded'),('deferred','stale'),
    ('skipped','accepted'),('skipped','superseded'),
    ('stale','accepted'),('stale','dismissed'),('stale','superseded'));
$$;
revoke all on function private.question_transition_ok(text, text) from public, anon;
grant execute on function private.question_transition_ok(text, text) to authenticated;

create or replace function private.transition_question(_question_id uuid, _to text, _reason text, _uid uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _from text;
begin
  select status into _from from public.differential_questions where id = _question_id for update;
  if _from is null then raise exception 'question not found' using errcode = 'P0002'; end if;
  if _from = _to then return; end if;
  if not private.question_transition_ok(_from, _to) then
    raise exception 'invalid question transition % -> %', _from, _to using errcode = '40003';
  end if;
  update public.differential_questions
     set status = _to, status_reason = _reason, updated_by = _uid where id = _question_id;
  insert into public.question_status_transitions (question_id, from_status, to_status, reason, created_by)
  values (_question_id, _from, _to, _reason, _uid);
end; $$;
revoke all on function private.transition_question(uuid, text, text, uuid) from public, anon;
grant execute on function private.transition_question(uuid, text, text, uuid) to authenticated;

-- ------------------------------------------------------- stale propagation
-- When a supporting source changes, mark affected evaluations stale and move
-- their not-yet-asked questions to 'stale'. Asked/answered questions are
-- historical clinical facts and keep their state; nothing is recomputed.
create or replace function private.mark_lens_stale_for_patient(_patient_id uuid, _kind text)
returns void language plpgsql security definer set search_path = ''
as $$
declare _q record;
begin
  update public.lens_evaluations
     set stale = true, stale_reason = left(_kind, 120)
   where patient_id = _patient_id and stale = false and superseded_by is null;
  for _q in select q.id from public.differential_questions q
             where q.patient_id = _patient_id and q.status in ('suggested','accepted','deferred') loop
    perform private.transition_question(_q.id, 'stale', 'supporting source changed: ' || _kind, null);
  end loop;
end; $$;
revoke all on function private.mark_lens_stale_for_patient(uuid, text) from public, anon;
grant execute on function private.mark_lens_stale_for_patient(uuid, text) to authenticated;

create or replace function private.lens_stale_biomarker() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform private.mark_lens_stale_for_patient(new.patient_id, 'lab observation changed'); return new; end; $$;
create or replace function private.lens_stale_medication() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform private.mark_lens_stale_for_patient(new.patient_id, 'medication changed'); return new; end; $$;
create or replace function private.lens_stale_allergy() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform private.mark_lens_stale_for_patient(new.patient_id, 'allergy changed'); return new; end; $$;
create or replace function private.lens_stale_transcript_correction() returns trigger
language plpgsql security definer set search_path = '' as $$
declare _pid uuid;
begin
  select t.patient_id into _pid from public.encounter_transcripts t where t.id = new.transcript_id;
  if _pid is not null then perform private.mark_lens_stale_for_patient(_pid, 'transcript corrected'); end if;
  return new;
end; $$;
create or replace function private.lens_stale_segment_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare _pid uuid;
begin
  select t.patient_id into _pid
    from public.transcript_segments s join public.encounter_transcripts t on t.id = s.transcript_id
   where s.id = new.segment_id;
  if _pid is not null then perform private.mark_lens_stale_for_patient(_pid, 'transcript revised'); end if;
  return new;
end; $$;

create trigger lens_stale_on_biomarker after insert or update on public.biomarker_observations
  for each row execute function private.lens_stale_biomarker();
create trigger lens_stale_on_medication after insert or update on public.medications
  for each row execute function private.lens_stale_medication();
create trigger lens_stale_on_allergy after insert or update on public.allergies
  for each row execute function private.lens_stale_allergy();
create trigger lens_stale_on_transcript_correction after insert on public.transcript_corrections
  for each row execute function private.lens_stale_transcript_correction();
create trigger lens_stale_on_segment_revision after insert on public.transcript_segment_revisions
  for each row execute function private.lens_stale_segment_revision();

-- ================================================== RPC: persist an evaluation
-- The backend rules engine computes the core + questions deterministically
-- (under the caller's RLS view) and persists them atomically here. Safety
-- failures BLOCK: the evaluation is recorded as 'blocked' with reviewable
-- failure rows and ZERO questions. Unknown knowledge sources are a hard
-- rejection — references cannot be invented.
create or replace function public.run_lens_evaluation(
  _encounter_id uuid, _paradigm text, _input_snapshot jsonb, _input_cutoff timestamptz,
  _source_versions jsonb, _rule_set_version text, _knowledge_versions jsonb,
  _model text, _provider text, _prompt_template_version text,
  _output_schema_version text, _output_sha256 text,
  _invariant_core jsonb, _lens_framing jsonb, _questions jsonb,
  _safety_failures jsonb default '[]'::jsonb, _validation_result jsonb default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _e public.encounters%rowtype; _eval uuid; _q jsonb; _qid uuid;
        _inserted integer := 0; _deduped integer := 0; _core_keys text[] :=
          array['objectiveFacts','provenance','missingInformation','conflicts','allergies',
                'interactions','criticalLabs','redFlags','emergencyConsiderations',
                'evidenceQuality','limitations'];
        _k text; _ks uuid[]; _ksid uuid; _prev record; _fail jsonb;
begin
  select * into _e from public.encounters where id = _encounter_id and deleted_at is null;
  if not found then raise exception 'encounter not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_e.organization_id, _e.patient_id);
  if not exists (select 1 from public.clinical_paradigms p where p.code = _paradigm) then
    raise exception 'unknown paradigm' using errcode = '22023'; end if;
  foreach _k in array _core_keys loop
    if not (_invariant_core ? _k) then
      raise exception 'invariant core is missing required section %', _k using errcode = '22023';
    end if;
  end loop;
  if _output_sha256 is null or length(_output_sha256) <> 64 then
    raise exception 'an output hash is required' using errcode = '22023'; end if;
  if jsonb_typeof(_questions) <> 'array' then
    raise exception 'questions must be an array' using errcode = '22023'; end if;
  if jsonb_typeof(_safety_failures) <> 'array' then
    raise exception 'safety failures must be an array' using errcode = '22023'; end if;

  -- Safety gate (req 7): failures block the whole output, reviewably.
  if jsonb_array_length(_safety_failures) > 0 then
    insert into public.lens_evaluations
      (organization_id, patient_id, encounter_id, paradigm_code, status, input_snapshot, input_cutoff_at,
       source_versions, rule_set_version, knowledge_versions, model, provider, prompt_template_version,
       output_schema_version, output_sha256, invariant_core, lens_framing, validation_result, created_by)
    values (_e.organization_id, _e.patient_id, _encounter_id, _paradigm, 'blocked', _input_snapshot, _input_cutoff,
            _source_versions, _rule_set_version, _knowledge_versions, _model, _provider, _prompt_template_version,
            _output_schema_version, _output_sha256, _invariant_core, _lens_framing, _validation_result, _uid)
    returning id into _eval;
    for _fail in select * from jsonb_array_elements(_safety_failures) loop
      insert into public.lens_safety_blocks (evaluation_id, rule_code, detail)
      values (_eval, coalesce(_fail->>'ruleCode','unspecified'), coalesce(_fail->'detail','{}'::jsonb));
    end loop;
    insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
      resource_type, resource_id, safe_message, metadata)
    values (_e.organization_id, _e.patient_id, _uid, 'lens.evaluation_blocked', 'lens_evaluation', _eval::text,
      'Lens evaluation blocked by safety rules',
      jsonb_build_object('paradigm', _paradigm, 'failures', jsonb_array_length(_safety_failures)));
    return jsonb_build_object('evaluationId', _eval, 'status', 'blocked',
      'blockedRules', jsonb_array_length(_safety_failures));
  end if;

  -- Supersede the previous live evaluation for this encounter + paradigm.
  insert into public.lens_evaluations
    (organization_id, patient_id, encounter_id, paradigm_code, status, input_snapshot, input_cutoff_at,
     source_versions, rule_set_version, knowledge_versions, model, provider, prompt_template_version,
     output_schema_version, output_sha256, invariant_core, lens_framing, validation_result, created_by)
  values (_e.organization_id, _e.patient_id, _encounter_id, _paradigm, 'complete', _input_snapshot, _input_cutoff,
          _source_versions, _rule_set_version, _knowledge_versions, _model, _provider, _prompt_template_version,
          _output_schema_version, _output_sha256, _invariant_core, _lens_framing, _validation_result, _uid)
  returning id into _eval;
  for _prev in select id from public.lens_evaluations
                where encounter_id = _encounter_id and paradigm_code = _paradigm
                  and id <> _eval and superseded_by is null loop
    update public.lens_evaluations set superseded_by = _eval where id = _prev.id;
    perform private.transition_question(q.id, 'superseded', 'newer evaluation', _uid)
      from public.differential_questions q
     where q.evaluation_id = _prev.id and q.status in ('suggested','accepted','deferred','stale');
  end loop;

  for _q in select * from jsonb_array_elements(_questions) loop
    if coalesce(btrim(_q->>'questionText'),'') = '' or coalesce(btrim(_q->>'rationale'),'') = '' then
      raise exception 'every question needs text and a practitioner-facing rationale' using errcode = '22023';
    end if;
    if not exists (select 1 from public.clinical_domains d
                   where d.code = _q->>'domainCode' and d.active) then
      raise exception 'unknown clinical domain %', _q->>'domainCode' using errcode = '22023';
    end if;
    -- citation validation: every knowledge code must exist in the registry.
    _ks := '{}';
    for _k in select * from jsonb_array_elements_text(coalesce(_q->'knowledgeSourceCodes','[]'::jsonb)) loop
      select id into _ksid from public.clinical_knowledge_sources
       where code = _k order by revision desc limit 1;
      if _ksid is null then
        raise exception 'unknown knowledge source % — references cannot be invented', _k using errcode = '22023';
      end if;
      _ks := array_append(_ks, _ksid);
    end loop;
    if array_length(_ks, 1) is null then
      raise exception 'every question must cite at least one registry source' using errcode = '22023';
    end if;
    -- duplicate suppression: skip when a live copy already exists.
    if exists (select 1 from public.differential_questions q
               where q.encounter_id = _encounter_id and q.dedupe_key = _q->>'dedupeKey'
                 and q.status not in ('dismissed','superseded','stale')) then
      _deduped := _deduped + 1;
      continue;
    end if;
    insert into public.differential_questions
      (organization_id, patient_id, encounter_id, evaluation_id, paradigm_code, domain_code,
       question_text, rationale, distinguishes, safety_relation, priority, answer_type,
       patient_sources, knowledge_source_ids, missing_data_assumptions,
       generation_method, generation_version, dedupe_key, status, updated_by)
    values (_e.organization_id, _e.patient_id, _encounter_id, _eval, _paradigm, _q->>'domainCode',
            _q->>'questionText', _q->>'rationale', coalesce(_q->'distinguishes','[]'::jsonb),
            nullif(_q->>'safetyRelation',''),
            coalesce(_q->>'priority','medium'), coalesce(_q->>'answerType','free_text'),
            coalesce(_q->'patientSources','[]'::jsonb), _ks,
            coalesce(_q->'missingDataAssumptions','[]'::jsonb),
            coalesce(_q->>'generationMethod','deterministic_rules'),
            coalesce(_q->>'generationVersion', _rule_set_version),
            coalesce(nullif(_q->>'dedupeKey',''), encode(sha256((_q->>'questionText')::bytea),'hex')),
            'suggested', _uid)
    returning id into _qid;
    insert into public.question_status_transitions (question_id, from_status, to_status, reason, created_by)
    values (_qid, 'suggested', 'suggested', 'generated', _uid);
    _inserted := _inserted + 1;
  end loop;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_e.organization_id, _e.patient_id, _uid, 'lens.evaluation_completed', 'lens_evaluation', _eval::text,
    'Lens evaluation completed',
    jsonb_build_object('paradigm', _paradigm, 'questions', _inserted, 'deduped', _deduped,
                       'ruleSet', _rule_set_version));
  return jsonb_build_object('evaluationId', _eval, 'status', 'complete',
    'questionsInserted', _inserted, 'questionsDeduped', _deduped);
end; $$;

-- ============================================== RPCs: question lifecycle
create or replace function public.set_question_status(_question_id uuid, _to text, _reason text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _q public.differential_questions%rowtype;
begin
  select * into _q from public.differential_questions where id = _question_id;
  if not found then raise exception 'question not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_q.organization_id, _q.patient_id);
  if _to not in ('accepted','asked','deferred','skipped') then
    raise exception 'use the dedicated functions for that transition' using errcode = '22023'; end if;
  perform private.transition_question(_question_id, _to, _reason, _uid);
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_q.organization_id, _q.patient_id, _uid, 'lens.question_' || _to, 'differential_question', _q.id::text,
    'Question status updated', jsonb_build_object('to', _to));
end; $$;

create or replace function public.dismiss_question(_question_id uuid, _feedback_kind text, _comment text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _q public.differential_questions%rowtype;
begin
  select * into _q from public.differential_questions where id = _question_id;
  if not found then raise exception 'question not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_q.organization_id, _q.patient_id);
  if _feedback_kind not in ('helpful','not_relevant','unsafe','incorrect','duplicate','other') then
    raise exception 'invalid feedback kind' using errcode = '22023'; end if;
  perform private.transition_question(_question_id, 'dismissed', _comment, _uid);
  insert into public.question_feedback (question_id, kind, comment, created_by)
  values (_question_id, _feedback_kind, _comment, _uid);
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_q.organization_id, _q.patient_id, _uid, 'lens.question_dismissed', 'differential_question', _q.id::text,
    'Question dismissed with feedback', jsonb_build_object('kind', _feedback_kind));
end; $$;

-- Answering: version 1..n; the question moves to 'answered'.
create or replace function public.answer_question(_question_id uuid, _answer jsonb)
returns integer language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _q public.differential_questions%rowtype; _v integer;
begin
  select * into _q from public.differential_questions where id = _question_id;
  if not found then raise exception 'question not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_q.organization_id, _q.patient_id);
  if _answer is null then raise exception 'an answer value is required' using errcode = '22023'; end if;
  if _q.status <> 'asked' then
    raise exception 'only an asked question can be answered' using errcode = '55000'; end if;
  select coalesce(max(version),0)+1 into _v from public.question_answers where question_id = _question_id;
  insert into public.question_answers
    (question_id, organization_id, patient_id, encounter_id, version, answer_value, answered_by)
  values (_question_id, _q.organization_id, _q.patient_id, _q.encounter_id, _v, _answer, _uid);
  perform private.transition_question(_question_id, 'answered', 'answer recorded', _uid);
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_q.organization_id, _q.patient_id, _uid, 'lens.question_answered', 'differential_question', _q.id::text,
    'Question answered', jsonb_build_object('version', _v));
  return _v;
end; $$;

-- Correction appends a NEW version referencing its predecessor. The original
-- answer row is never mutated (append-only trigger enforces it for any role).
create or replace function public.correct_question_answer(_question_id uuid, _answer jsonb, _reason text default null)
returns integer language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _q public.differential_questions%rowtype; _v integer; _prev integer;
begin
  select * into _q from public.differential_questions where id = _question_id;
  if not found then raise exception 'question not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_q.organization_id, _q.patient_id);
  if _q.status <> 'answered' then
    raise exception 'only an answered question can be corrected' using errcode = '55000'; end if;
  select max(version) into _prev from public.question_answers where question_id = _question_id;
  if _prev is null then raise exception 'no answer exists to correct' using errcode = '55000'; end if;
  _v := _prev + 1;
  insert into public.question_answers
    (question_id, organization_id, patient_id, encounter_id, version, answer_value,
     corrects_version, correction_reason, answered_by)
  values (_question_id, _q.organization_id, _q.patient_id, _q.encounter_id, _v, _answer, _prev, _reason, _uid);
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_q.organization_id, _q.patient_id, _uid, 'lens.answer_corrected', 'differential_question', _q.id::text,
    'Answer corrected (original preserved)', jsonb_build_object('version', _v, 'corrects', _prev));
  return _v;
end; $$;

-- Explicit practitioner action: record that question content was added to a
-- note (the note write itself goes through save_note_draft — nothing is ever
-- inserted into a note automatically, and signed notes stay immutable).
create or replace function public.record_question_note_use(_question_id uuid, _note_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _q public.differential_questions%rowtype; _n record;
begin
  select * into _q from public.differential_questions where id = _question_id;
  if not found then raise exception 'question not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_q.organization_id, _q.patient_id);
  select id, encounter_id, status into _n from public.clinical_notes
   where id = _note_id and deleted_at is null;
  if _n.id is null then raise exception 'note not found' using errcode = 'P0002'; end if;
  if _n.encounter_id is distinct from _q.encounter_id then
    raise exception 'the note belongs to a different encounter' using errcode = '42501'; end if;
  if _n.status not in ('draft','ready_for_review') then
    raise exception 'signed notes cannot receive new content — use an addendum' using errcode = '55000'; end if;
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_q.organization_id, _q.patient_id, _uid, 'lens.question_added_to_note', 'differential_question', _q.id::text,
    'Question content explicitly added to a draft note', jsonb_build_object('note', _note_id::text));
end; $$;

create or replace function public.submit_question_feedback(_question_id uuid, _kind text, _comment text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _q public.differential_questions%rowtype;
begin
  select * into _q from public.differential_questions where id = _question_id;
  if not found then raise exception 'question not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_q.organization_id, _q.patient_id);
  if _kind not in ('helpful','not_relevant','unsafe','incorrect','duplicate','other') then
    raise exception 'invalid feedback kind' using errcode = '22023'; end if;
  insert into public.question_feedback (question_id, kind, comment, created_by)
  values (_question_id, _kind, _comment, _uid);
end; $$;

create or replace function public.review_safety_block(_block_id uuid, _resolution text)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _b public.lens_safety_blocks%rowtype; _e public.lens_evaluations%rowtype;
begin
  select * into _b from public.lens_safety_blocks where id = _block_id;
  if not found then raise exception 'safety block not found' using errcode = 'P0002'; end if;
  select * into _e from public.lens_evaluations where id = _b.evaluation_id;
  _uid := private.require_clinical_actor(_e.organization_id, _e.patient_id);
  if _resolution is null or btrim(_resolution) = '' then
    raise exception 'a resolution note is required' using errcode = '22023'; end if;
  update public.lens_safety_blocks
     set reviewed_by = _uid, reviewed_at = now(), resolution = _resolution where id = _block_id;
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_e.organization_id, _e.patient_id, _uid, 'lens.safety_block_reviewed', 'lens_evaluation', _e.id::text,
    'Safety block reviewed', jsonb_build_object('rule', _b.rule_code));
end; $$;

-- ------------------------------------------------------------------ grants
revoke all on function public.run_lens_evaluation(uuid, text, jsonb, timestamptz, jsonb, text, jsonb, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon;
revoke all on function public.set_question_status(uuid, text, text) from public, anon;
revoke all on function public.dismiss_question(uuid, text, text) from public, anon;
revoke all on function public.answer_question(uuid, jsonb) from public, anon;
revoke all on function public.correct_question_answer(uuid, jsonb, text) from public, anon;
revoke all on function public.record_question_note_use(uuid, uuid) from public, anon;
revoke all on function public.submit_question_feedback(uuid, text, text) from public, anon;
revoke all on function public.review_safety_block(uuid, text) from public, anon;
grant execute on function public.run_lens_evaluation(uuid, text, jsonb, timestamptz, jsonb, text, jsonb, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.set_question_status(uuid, text, text) to authenticated;
grant execute on function public.dismiss_question(uuid, text, text) to authenticated;
grant execute on function public.answer_question(uuid, jsonb) to authenticated;
grant execute on function public.correct_question_answer(uuid, jsonb, text) to authenticated;
grant execute on function public.record_question_note_use(uuid, uuid) to authenticated;
grant execute on function public.submit_question_feedback(uuid, text, text) to authenticated;
grant execute on function public.review_safety_block(uuid, text) to authenticated;

-- ------------------------------------------------------------------- seeds
insert into public.clinical_paradigms (code, name, description, is_composite, composed_of) values
  ('western_conventional','Western / conventional','Guideline-oriented biomedical framing. Always shown alongside any selected lens.', false, '{}'),
  ('functional','Functional medicine','Systems-biology framing emphasizing root-cause exploration. Paradigm-specific concepts are considerations, not diagnoses.', false, '{}'),
  ('naturopathic','Naturopathic','Naturopathic framing emphasizing lifestyle and least-invasive-first exploration. Considerations only.', false, '{}'),
  ('tcm','Traditional Chinese Medicine','TCM pattern framing. Patterns are paradigm-specific concepts and are never equivalent to biomedical diagnoses.', false, '{}'),
  ('biohacking','Biohacking / performance','Performance-optimization framing over the same objective data. Considerations only.', false, '{}'),
  ('synergistic','Best synergistic mix','Transparent composition of the other paradigms with per-item source-lens attribution and explicit conflict resolution. Urgent biomedical concerns always rank first; nothing is blended untraceably.', true,
   '{western_conventional,functional,naturopathic,tcm,biohacking}');

insert into public.clinical_domains (code, version, name, description) values
  ('cardiometabolic',1,'Cardiometabolic','Blood pressure, lipids, glucose regulation, cardiovascular risk.'),
  ('inflammatory_immune',1,'Inflammatory / immune','Inflammatory markers, immune symptoms, autoimmunity signals.'),
  ('sleep',1,'Sleep','Sleep quality, duration, apnea risk, circadian factors.'),
  ('gastrointestinal',1,'Gastrointestinal','Digestive symptoms, absorption, microbiome-adjacent factors.'),
  ('endocrine',1,'Endocrine','Thyroid, adrenal, metabolic and reproductive hormone axes.'),
  ('neurologic',1,'Neurologic','Cognition, headache, neuropathy, mood-adjacent neurologic signals.'),
  ('reproductive',1,'Reproductive','Reproductive health, pregnancy status and safety implications.'),
  ('toxicologic_environmental',1,'Toxicologic / environmental','Exposures, environmental and occupational factors.'),
  ('medication_supplement_safety',1,'Medication and supplement safety','Interactions, contraindications, duplications, adherence.');

-- Registry seeds: real, inspectable sources for the deterministic rule set.
-- Unknown attributes are left NULL and must display as "unknown".
insert into public.clinical_knowledge_sources
  (code, revision, citation, publisher, release_date, intended_purpose, intended_population,
   required_inputs, logic_summary, known_limitations, out_of_scope_uses, validation_status, funding_conflicts) values
  ('aha_acc_chest_pain_2021', 1,
   'Gulati M, et al. 2021 AHA/ACC/ASE/CHEST/SAEM/SCCT/SCMR Guideline for the Evaluation and Diagnosis of Chest Pain. Circulation. 2021;144:e368–e454.',
   'American Heart Association / American College of Cardiology', '2021-10-28',
   'Evaluation and triage framing for chest pain presentations.',
   'Adults presenting with acute or stable chest pain.',
   'Symptom description; vital signs; risk factors; ECG and troponin where available.',
   'Deterministic keyword and finding triggers map chest-pain signals to urgent evaluation questions.',
   'Guideline-derived triggers only; no risk score is computed; not a substitute for clinical evaluation.',
   'Diagnosis, disposition, or treatment decisions.',
   'validated', null),
  ('acc_aha_htn_2017', 1,
   'Whelton PK, et al. 2017 ACC/AHA Guideline for the Prevention, Detection, Evaluation, and Management of High Blood Pressure in Adults. Hypertension. 2018;71:e13–e115.',
   'American College of Cardiology / American Heart Association', '2017-11-13',
   'Blood-pressure category thresholds used to frame follow-up questions.',
   'Adults without pregnancy-specific modification.',
   'At least one measured blood pressure with cuff context.',
   'BP readings are categorized against guideline thresholds to trigger measurement-quality and history questions.',
   'Single-encounter readings; no out-of-office confirmation logic in this slice.',
   'Medication selection or dosing.',
   'validated', null),
  ('aha_cdc_crp_2003', 1,
   'Pearson TA, et al. Markers of Inflammation and Cardiovascular Disease: Application to Clinical and Public Health Practice. A Statement for Healthcare Professionals From the CDC and the AHA. Circulation. 2003;107:499–511.',
   'American Heart Association / Centers for Disease Control and Prevention', '2003-01-28',
   'Interpretation bands for hs-CRP used to frame inflammation questions.',
   'Adults undergoing cardiovascular risk assessment.',
   'An hs-CRP observation with units.',
   'hs-CRP values are banded (<1, 1–3, >3 mg/L; >10 suggests non-cardiovascular inflammation) to trigger repeat-testing and infection-history questions.',
   'A 2003 statement; banding is stable but downstream risk framing has evolved.',
   'Treatment decisions based on hs-CRP alone.',
   'validated', null),
  ('nih_nccih_sjw', 1,
   'National Center for Complementary and Integrative Health. St. John''s Wort and Depression: In Depth. NIH.',
   'NIH / NCCIH', null,
   'Interaction cautions for St. John''s Wort with prescription medications.',
   'Adults using or considering St. John''s Wort.',
   'Current medication and supplement lists.',
   'Deterministic interaction pairs (e.g. serotonergic antidepressants, anticoagulants, oral contraceptives) trigger safety questions.',
   'Not an exhaustive interaction compendium.',
   'Dosing or discontinuation advice.',
   'partially_validated', null),
  ('who_tcm_terminology_2022', 1,
   'WHO International Standard Terminologies on Traditional Chinese Medicine. World Health Organization. 2022.',
   'World Health Organization', '2022-03-01',
   'Standardized terminology for expressing TCM pattern framing.',
   'Practitioners applying TCM framing.',
   'Symptom and constitutional observations.',
   'Provides the vocabulary used when the TCM lens frames considerations; patterns are explicitly labeled as paradigm-specific concepts, not biomedical diagnoses.',
   'Terminology standard only — it validates naming, not clinical efficacy.',
   'Treating TCM patterns as biomedical diagnoses.',
   'unknown', null),
  ('ifm_matrix_framework', 1,
   'Institute for Functional Medicine. The Functional Medicine Matrix model (conceptual framework).',
   'Institute for Functional Medicine', null,
   'Conceptual organizing framework used by the functional-medicine lens for framing and ranking of non-urgent considerations.',
   'Practitioners applying functional-medicine framing.',
   'General history, lifestyle and laboratory context.',
   'Organizes non-urgent considerations by antecedents/triggers/mediators framing. Never alters the invariant core.',
   'A conceptual framework; not an externally validated clinical decision instrument.',
   'Risk stratification, diagnosis, or treatment selection.',
   'unvalidated', 'unknown — professional education organization; specific funding not assessed'),
  ('aasm_sleep_questions', 1,
   'American Academy of Sleep Medicine. Clinical Practice Guideline for Diagnostic Testing for Adult Obstructive Sleep Apnea. J Clin Sleep Med. 2017;13(3):479–504.',
   'American Academy of Sleep Medicine', '2017-03-15',
   'Framing for sleep-history questions when sleep complaints are present.',
   'Adults reporting sleep complaints.',
   'Sleep-related symptoms from history or transcript.',
   'Sleep complaints trigger structured history questions (snoring, witnessed apneas, daytime sleepiness).',
   'Question framing only; no screening score is computed in this slice.',
   'Ordering or interpreting sleep studies.',
   'validated', null);

commit;
