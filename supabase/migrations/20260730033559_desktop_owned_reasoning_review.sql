-- desktop_owned_reasoning_review
--
-- Phase 1 vertical slice, reasoning side: Desktop-owned reads for the
-- clinical-reasoning workspace and the practitioner review action.
--
--   get_reasoning_workspace(_organization_id, _patient_id) -> jsonb
--     Latest reasoning snapshot metadata (version = count of snapshots up to
--     it; stale = source data changed after generation), hypotheses with
--     supporting / conflicting / missing evidence split apart and every
--     evidence item linked to its source fact, plus the encounter-scoped
--     urgent safety questions (invariant across clinical lenses — they are
--     read directly, never filtered by paradigm).
--
--   review_hypothesis(_hypothesis_id, _action, _note) -> jsonb
--     Practitioner review: accepted / rejected / needs_data. Appends an
--     immutable hypothesis_reviews row, updates the hypothesis review state,
--     and writes the audit_events row IN THE SAME TRANSACTION — the review
--     and its audit either both persist or neither does. Accepting a
--     hypothesis changes review state ONLY: nothing is inserted into a note
--     or care plan.
--
-- Wording guarantee: reasoning_strength is surfaced as an INTERNAL
-- evidence-weighting label, verbatim scale (0–100) — never a probability.
-- Unknown values stay 'Unknown'; the functions never coalesce a missing
-- clinical value into a plausible one.
--
-- Same contract as every desktop-owned function: SECURITY DEFINER, pinned
-- empty search_path, explicit auth + membership + patient-access gates,
-- bounded outputs, anon/public revoked, no PHI in raised messages.

begin;

-- ------------------------------------------------------------------ reviews
-- Append-only record of practitioner decisions on hypotheses. The hypothesis
-- row carries the CURRENT state; this table carries the history.
create table if not exists public.hypothesis_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  hypothesis_id uuid not null references public.clinical_hypotheses(id) on delete cascade,
  action text not null check (action in ('accepted','rejected','needs_data')),
  note text,
  reviewer_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists hypothesis_reviews_hyp_idx
  on public.hypothesis_reviews (hypothesis_id, created_at desc);

comment on table public.hypothesis_reviews is
  'Append-only practitioner reviews of clinical hypotheses. Accepting a hypothesis records the decision ONLY — it never inserts content into a note or care plan.';

alter table public.hypothesis_reviews enable row level security;

create policy hypothesis_reviews_select on public.hypothesis_reviews
  for select using (private.can_access_patient(patient_id));
-- No insert/update/delete policies: writes go through review_hypothesis().

revoke all privileges on table public.hypothesis_reviews from public, anon, authenticated;

-- ------------------------------------------------------- workspace read
create or replace function public.get_reasoning_workspace(
  _organization_id uuid,
  _patient_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _snapshot jsonb;
  _snapshot_at timestamptz;
  _source_changed_at timestamptz;
  _hypotheses jsonb;
  _questions jsonb;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'not an active member of this organization' using errcode = '42501';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;

  -- Latest snapshot + version (ordinal among this patient's snapshots) +
  -- staleness: source data (labs, notes, facts) changed after generation.
  select max(greatest(coalesce(o.updated_at, o.created_at), o.created_at)) into _source_changed_at
  from (
    select updated_at, created_at from public.biomarker_observations
      where patient_id = _patient_id and organization_id = _organization_id and deleted_at is null
    union all
    select updated_at, created_at from public.clinical_notes
      where patient_id = _patient_id and organization_id = _organization_id and deleted_at is null
    union all
    select updated_at, created_at from public.clinical_facts
      where patient_id = _patient_id and organization_id = _organization_id and deleted_at is null
  ) o;

  select jsonb_build_object(
      'id', s.id,
      'version', (select count(*) from public.reasoning_snapshots s2
                  where s2.patient_id = _patient_id
                    and s2.organization_id = _organization_id
                    and s2.created_at <= s.created_at),
      'generatedAt', s.created_at,
      'stale', (_source_changed_at is not null and _source_changed_at > s.created_at),
      'staleReason', case
        when _source_changed_at is not null and _source_changed_at > s.created_at
        then 'Source data changed after this snapshot was generated'
        else null end
    ), s.created_at
  into _snapshot, _snapshot_at
  from public.reasoning_snapshots s
  where s.patient_id = _patient_id
    and s.organization_id = _organization_id
  order by s.created_at desc
  limit 1;

  -- Hypotheses (bounded 20) with evidence split by direction, missing-data
  -- recommendations, and the latest review. Strength is surfaced as the
  -- internal wording, never a probability.
  select coalesce(jsonb_agg(hyp order by hyp_order), '[]'::jsonb) into _hypotheses from (
    select
      case h.status
        when 'supported' then 0 when 'under_review' then 1 when 'proposed' then 2
        when 'weakened' then 3 when 'unresolved' then 4 else 5 end as hyp_order,
      jsonb_build_object(
        'id', h.id,
        'title', h.title,
        'status', h.status,
        'strengthLabel', case
          when h.reasoning_strength is null then 'Unknown'
          else 'Internal evidence weighting ' || h.reasoning_strength || '/100 — not a medical probability'
        end,
        'supporting', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', ev.id,
            'factType', coalesce(f.fact_type, 'missing'),
            'label', coalesce(ev.summary, f.statement, 'Unknown'),
            'observedAt', f.observed_at,
            'source', case when f.source_table is not null and f.source_record_id is not null
              then jsonb_build_object('kind', f.source_table, 'id', f.source_record_id,
                                      'at', coalesce(f.observed_at, f.created_at))
              else null end
          ) order by ev.created_at)
          from public.evidence_items ev
          left join public.clinical_facts f on f.id = ev.fact_id
          where ev.hypothesis_id = h.id and ev.direction = 'supporting'
            and ev.deleted_at is null
          ), '[]'::jsonb),
        'conflicting', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', ev.id,
            'factType', coalesce(f.fact_type, 'conflicting'),
            'label', coalesce(ev.summary, f.statement, 'Unknown'),
            'observedAt', f.observed_at,
            'source', case when f.source_table is not null and f.source_record_id is not null
              then jsonb_build_object('kind', f.source_table, 'id', f.source_record_id,
                                      'at', coalesce(f.observed_at, f.created_at))
              else null end
          ) order by ev.created_at)
          from public.evidence_items ev
          left join public.clinical_facts f on f.id = ev.fact_id
          where ev.hypothesis_id = h.id and ev.direction = 'contradicting'
            and ev.deleted_at is null
          ), '[]'::jsonb),
        'missing', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', md.id, 'label', md.description,
            'recommendation', md.data_type) order by md.priority nulls last)
          from public.missing_data_recommendations md
          where md.hypothesis_id = h.id and md.status = 'open' and md.deleted_at is null
          ), '[]'::jsonb),
        'review', jsonb_build_object(
          'state', case h.review_status
            when 'accepted' then 'accepted'
            when 'rejected' then 'rejected'
            when 'flagged' then 'needs_data'
            else 'unreviewed' end,
          'reviewedAt', h.reviewed_at,
          'reviewedBy', (
            select coalesce(nullif(trim(coalesce(pp.display_name,'')), ''), 'Practitioner')
            from public.practitioner_profiles pp
            where pp.user_id = h.reviewed_by and pp.organization_id = _organization_id
            limit 1),
          'note', (
            select hr.note from public.hypothesis_reviews hr
            where hr.hypothesis_id = h.id
            order by hr.created_at desc limit 1)
        )
      ) as hyp
    from public.clinical_hypotheses h
    where h.patient_id = _patient_id
      and h.organization_id = _organization_id
      and h.deleted_at is null
      and h.status <> 'archived'
    limit 20
  ) hyps;

  -- Urgent safety questions: encounter-scoped differential questions with
  -- priority 'urgent'. Deliberately NOT filtered by paradigm/lens — urgent
  -- safety is invariant across clinical lenses.
  select coalesce(jsonb_agg(q_json order by created_at desc), '[]'::jsonb) into _questions from (
    select q.created_at, jsonb_build_object(
      'id', q.id, 'text', q.question_text, 'status', q.status,
      'createdAt', q.created_at) as q_json
    from public.differential_questions q
    where q.patient_id = _patient_id
      and q.organization_id = _organization_id
      and q.priority = 'urgent'
      and q.status not in ('dismissed','superseded','stale')
    limit 10
  ) qs;

  return jsonb_build_object(
    'patientId', _patient_id,
    'snapshot', _snapshot,
    'hypotheses', _hypotheses,
    'urgentQuestions', _questions,
    'aiGeneration', jsonb_build_object(
      'configured', false,
      'message', 'AI snapshot generation is not configured. Existing snapshots, hypotheses, and evidence are shown from the record; nothing is generated or fabricated.'
    ),
    'generatedAt', now()
  );
end;
$$;

comment on function public.get_reasoning_workspace(uuid, uuid) is
  'Clinical reasoning workspace read: latest snapshot meta (with staleness vs source data), hypotheses as inferences with internal evidence-weighting wording (never probability), evidence split supporting/conflicting/missing with source links, and lens-invariant urgent safety questions.';

revoke all on function public.get_reasoning_workspace(uuid, uuid) from public, anon;
grant execute on function public.get_reasoning_workspace(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------- review action
create or replace function public.review_hypothesis(
  _hypothesis_id uuid,
  _action text,
  _note text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _hyp record;
  _review_id uuid;
  _audit_id uuid;
  _mapped_status text;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if _action not in ('accepted','rejected','needs_data') then
    raise exception 'invalid review action' using errcode = '22023';
  end if;
  if _note is not null and length(_note) > 2000 then
    raise exception 'review note is too long (max 2000 characters)' using errcode = '22023';
  end if;

  select h.id, h.organization_id, h.patient_id, h.title
  into _hyp
  from public.clinical_hypotheses h
  where h.id = _hypothesis_id and h.deleted_at is null
  for update;

  if _hyp.id is null then
    raise exception 'hypothesis not found' using errcode = 'P0002';
  end if;
  if not private.is_org_member(_hyp.organization_id) then
    raise exception 'not an active member of this organization' using errcode = '42501';
  end if;
  if not private.can_access_patient(_hyp.patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;

  _mapped_status := case _action
    when 'accepted' then 'accepted'
    when 'rejected' then 'rejected'
    else 'flagged' end;

  insert into public.hypothesis_reviews
    (organization_id, patient_id, hypothesis_id, action, note, reviewer_user_id)
  values
    (_hyp.organization_id, _hyp.patient_id, _hypothesis_id, _action, _note, _uid)
  returning id into _review_id;

  update public.clinical_hypotheses
  set review_status = _mapped_status,
      reviewed_by = _uid,
      reviewed_at = now(),
      updated_by = _uid,
      updated_at = now()
  where id = _hypothesis_id;

  -- needs_data also opens a missing-data recommendation so the request is
  -- actionable, not just a state.
  if _action = 'needs_data' and _note is not null and trim(_note) <> '' then
    insert into public.missing_data_recommendations
      (organization_id, patient_id, hypothesis_id, description, status, source, created_by)
    values
      (_hyp.organization_id, _hyp.patient_id, _hypothesis_id,
       trim(_note), 'open', 'practitioner', _uid);
  end if;

  -- Audit in the same transaction: the review and its audit event are atomic.
  -- safe_message carries NO clinical content — action + resource ref only.
  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type, resource_id, safe_message, metadata)
  values
    (_hyp.organization_id, _hyp.patient_id, _uid,
     'hypothesis.' || _action, 'clinical_hypothesis', _hypothesis_id::text,
     'Practitioner reviewed a clinical hypothesis (' || _action || ')',
     jsonb_build_object('reviewId', _review_id, 'hadNote', _note is not null))
  returning id into _audit_id;

  return jsonb_build_object(
    'ok', true,
    'hypothesisId', _hypothesis_id,
    'state', _action,
    'auditId', _audit_id,
    'message', case _action
      when 'accepted' then 'Hypothesis accepted as a reviewed inference. Nothing was added to a note or care plan.'
      when 'rejected' then 'Hypothesis rejected. The decision and audit trail are saved to the record.'
      else 'More data requested. The request is saved and linked to this hypothesis.' end
  );
end;
$$;

comment on function public.review_hypothesis(uuid, text, text) is
  'Practitioner review of a clinical hypothesis (accepted/rejected/needs_data). Appends an immutable hypothesis_reviews row, updates hypothesis review state, and writes the audit event atomically. Accepting never inserts content into a note or care plan.';

revoke all on function public.review_hypothesis(uuid, text, text) from public, anon;
grant execute on function public.review_hypothesis(uuid, text, text) to authenticated, service_role;

commit;
