-- ============================================================
-- Demo practice seed — clinical project (urcjiehlxoehievobezf)
--
-- Seeds ONE synthetic practice so first sign-in isn't an empty screen:
-- organization, your practitioner membership+profile, one test patient,
-- the practitioner↔patient access row, one lab document, biomarker
-- definitions + observations (with history, one abnormal, one
-- low-confidence), two review-queue tasks, a reasoning snapshot with two
-- hypotheses, one supplement protocol, and example audit events.
--
-- ALL DATA IS SYNTHETIC — no real PHI. Values/ranges are realistic-looking
-- demo numbers for a fictional patient ("Avery Demo").
--
-- HOW TO RUN (once, ~30 seconds):
--   1. Supabase Dashboard → Authentication → Add user → create your
--      practitioner login (email + password). Copy the user's UUID.
--   2. Replace the two placeholders in the DO block below:
--        practitioner_user_id := '<AUTH-USER-UUID>'
--        practitioner_email   := '<YOUR-EMAIL>'
--   3. Run this whole file in the SQL editor (runs as postgres, so the
--      append-only audit_events inserts are allowed — app roles still can't
--      write it directly).
--
-- IDEMPOTENT: fixed UUIDs + ON CONFLICT DO NOTHING throughout — safe to
-- re-run; it never duplicates and never overwrites edited rows.
-- The desktop app never needs the service role; after seeding, sign in from
-- /login and set CLINICAL_ORG_ID to the organization id below.
-- ============================================================

do $seed$
declare
  -- ─── EDIT THESE TWO LINES ────────────────────────────────────────────────
  practitioner_user_id uuid := '00000000-0000-0000-0000-000000000000'; -- ← auth user UUID from the dashboard
  practitioner_email   text := 'you@example.com';                      -- ← that user's email
  -- ─────────────────────────────────────────────────────────────────────────

  org_id     uuid := 'a0000000-0000-4000-8000-000000000001';
  patient_id uuid := 'a0000000-0000-4000-8000-000000000002';
  doc_id     uuid := 'a0000000-0000-4000-8000-000000000003';
  snap_id    uuid := 'a0000000-0000-4000-8000-000000000004';

  def_crp  uuid := 'a0000000-0000-4000-8000-000000000010';
  def_vitd uuid := 'a0000000-0000-4000-8000-000000000011';
  def_tsh  uuid := 'a0000000-0000-4000-8000-000000000012';
  def_ferr uuid := 'a0000000-0000-4000-8000-000000000013';
  def_a1c  uuid := 'a0000000-0000-4000-8000-000000000014';
begin
  if practitioner_user_id = '00000000-0000-0000-0000-000000000000' then
    raise exception 'Edit the seed first: set practitioner_user_id to your auth user UUID (Dashboard → Authentication).';
  end if;
  if not exists (select 1 from auth.users where id = practitioner_user_id) then
    raise exception 'No auth.users row with id % — create the user in the dashboard first.', practitioner_user_id;
  end if;

  -- Organization + membership + practitioner profile
  insert into public.organizations (id, name, slug, created_by)
  values (org_id, 'Bright Longevity Clinic (Demo)', 'bright-longevity-demo', null)
  on conflict (id) do nothing;

  insert into public.organization_memberships (organization_id, user_id, role, status)
  values (org_id, practitioner_user_id, 'owner', 'active')
  on conflict do nothing;

  insert into public.practitioner_profiles (id, organization_id, user_id, display_name, credentials, specialty, created_by)
  values ('a0000000-0000-4000-8000-000000000005', org_id, practitioner_user_id,
          split_part(practitioner_email, '@', 1), 'Practitioner', 'Functional Medicine', practitioner_user_id)
  on conflict (id) do nothing;

  -- Synthetic test patient + access
  insert into public.patient_profiles (id, organization_id, mrn, first_name, last_name, date_of_birth, sex, status, created_by)
  values (patient_id, org_id, 'DEMO-0001', 'Avery', 'Demo', '1988-03-14', 'female', 'active', practitioner_user_id)
  on conflict (id) do nothing;

  insert into public.practitioner_patient_relationships (organization_id, practitioner_user_id, patient_id, status)
  values (org_id, practitioner_user_id, patient_id, 'active')
  on conflict do nothing;

  -- Lab source document
  insert into public.lab_documents (id, organization_id, patient_id, file_name, file_type, storage_path,
                                    lab_company, panel_name, lab_date, processing_status, uploaded_by, source, created_by)
  values (doc_id, org_id, patient_id, 'demo-panel-2026-07.pdf', 'application/pdf',
          'seed/demo-panel-2026-07.pdf', -- placeholder path; no file exists in storage (synthetic seed)
          'Quest Diagnostics (Demo)', 'Comprehensive wellness panel', current_date - 7, 'extracted',
          practitioner_user_id, 'seed', practitioner_user_id)
  on conflict (id) do nothing;

  -- Biomarker definitions
  insert into public.biomarker_definitions (id, canonical_name, default_unit, biological_system) values
    (def_crp,  'hs-CRP',           'mg/L',   'Inflammation'),
    (def_vitd, 'Vitamin D, 25-OH', 'ng/mL',  'Micronutrient'),
    (def_tsh,  'TSH',              'mIU/L',  'Thyroid'),
    (def_ferr, 'Ferritin',         'ng/mL',  'Iron'),
    (def_a1c,  'Hemoglobin A1c',   '%',      'Metabolic')
  on conflict (id) do nothing;

  -- Observations: current panel (one abnormal, one LOW-CONFIDENCE) + history for trends
  insert into public.biomarker_observations
    (id, organization_id, patient_id, biomarker_definition_id, lab_document_id,
     value_numeric, unit, status, original_reference_interval, confidence, provenance,
     source, review_status, observed_at, created_by) values
    ('a0000000-0000-4000-8000-000000000020', org_id, patient_id, def_crp,  doc_id, 2.8, 'mg/L',  'high',   '<3.0',        0.97, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '7 days',  practitioner_user_id),
    ('a0000000-0000-4000-8000-000000000021', org_id, patient_id, def_crp,  null,   3.4, 'mg/L',  'high',   '<3.0',        0.96, 'lab_pdf_extraction', 'seed', 'accepted',   now() - interval '97 days', practitioner_user_id),
    ('a0000000-0000-4000-8000-000000000022', org_id, patient_id, def_vitd, doc_id, 28,  'ng/mL', 'low',    '30-100',      0.95, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '7 days',  practitioner_user_id),
    ('a0000000-0000-4000-8000-000000000023', org_id, patient_id, def_tsh,  doc_id, 2.1, 'mIU/L', 'normal', '0.4-4.0',     0.98, 'lab_pdf_extraction', 'seed', 'accepted',   now() - interval '7 days',  practitioner_user_id),
    ('a0000000-0000-4000-8000-000000000024', org_id, patient_id, def_ferr, doc_id, 62,  'ng/mL', 'normal', '20-200',      0.55, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '7 days',  practitioner_user_id), -- low confidence → review-gated
    ('a0000000-0000-4000-8000-000000000025', org_id, patient_id, def_a1c,  doc_id, 5.6, '%',     'normal', '4.0-5.6',     0.97, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '7 days',  practitioner_user_id)
  on conflict (id) do nothing;

  -- Review queue: one lab follow-up, one org-level item
  insert into public.review_queue_items (id, organization_id, patient_id, item_type, ref_id, title, priority, status, created_by) values
    ('a0000000-0000-4000-8000-000000000030', org_id, patient_id, 'abnormal_result',
     'a0000000-0000-4000-8000-000000000020', 'Review elevated hs-CRP and plan recheck', 'high', 'open', practitioner_user_id),
    ('a0000000-0000-4000-8000-000000000031', org_id, null, 'assessment',
     null, 'Quarterly demo-practice QA checklist', 'low', 'open', practitioner_user_id)
  on conflict (id) do nothing;

  -- Reasoning snapshot + hypotheses (templated content, practitioner-review-gated)
  insert into public.reasoning_snapshots (id, organization_id, patient_id, trigger, input_record_ids, structured_output, review_status, source)
  values (snap_id, org_id, patient_id, 'seed_demo',
          jsonb_build_array('a0000000-0000-4000-8000-000000000020','a0000000-0000-4000-8000-000000000022'),
          jsonb_build_object('summary','Demo snapshot: low-grade inflammation pattern with suboptimal vitamin D.'),
          'unreviewed', 'seed')
  on conflict (id) do nothing;

  insert into public.clinical_hypotheses (id, organization_id, patient_id, title, status, review_status, source) values
    ('a0000000-0000-4000-8000-000000000040', org_id, patient_id, 'Low-grade inflammatory burden', 'proposed', 'unreviewed', 'seed'),
    ('a0000000-0000-4000-8000-000000000041', org_id, patient_id, 'Vitamin D insufficiency contributing to fatigue', 'proposed', 'unreviewed', 'seed')
  on conflict (id) do nothing;

  -- One supplement protocol (draft, review-gated)
  insert into public.supplement_protocols (id, organization_id, patient_id, name, status, source)
  values ('a0000000-0000-4000-8000-000000000050', org_id, patient_id, 'Foundational anti-inflammatory support (draft)', 'draft', 'seed')
  on conflict (id) do nothing;

  -- Calendar appointments: one upcoming in-person follow-up, one telehealth,
  -- one org-level break (patient-NULL — exercises the 0017 visibility branch).
  -- Times are relative to seeding so they land in the visible week.
  insert into public.appointments (id, organization_id, patient_id, practitioner_user_id,
    appointment_type, location, telehealth_url, status, starts_at, ends_at, source, created_by)
  values
    ('a0000000-0000-4000-8000-000000000070', org_id, patient_id, practitioner_user_id,
     'follow-up', 'Room 1', null, 'confirmed',
     date_trunc('hour', now()) + interval '26 hours',
     date_trunc('hour', now()) + interval '26 hours 45 minutes', 'seed', practitioner_user_id),
    ('a0000000-0000-4000-8000-000000000071', org_id, patient_id, practitioner_user_id,
     'telehealth', 'Telehealth', null, 'scheduled',
     date_trunc('hour', now()) + interval '50 hours',
     date_trunc('hour', now()) + interval '50 hours 30 minutes', 'seed', practitioner_user_id),
    ('a0000000-0000-4000-8000-000000000072', org_id, null, practitioner_user_id,
     'break', 'Admin', null, 'scheduled',
     date_trunc('hour', now()) + interval '28 hours',
     date_trunc('hour', now()) + interval '29 hours', 'seed', practitioner_user_id)
  on conflict (id) do nothing;

  -- Example audit events (seeded as postgres; app-role writes stay RPC-only)
  insert into public.audit_events (id, organization_id, patient_id, actor_user_id, action, resource_type, resource_id, safe_message, metadata) values
    ('a0000000-0000-4000-8000-000000000060', org_id, patient_id, practitioner_user_id, 'seed.import',
     'lab_document', doc_id::text, 'Demo lab document seeded', '{"source":"seed"}'),
    ('a0000000-0000-4000-8000-000000000061', org_id, patient_id, practitioner_user_id, 'biomarker.review',
     'biomarker_observation', 'a0000000-0000-4000-8000-000000000021', 'Biomarker marked accepted',
     '{"decision":"accepted","previous_status":"unreviewed","source":"seed"}'),
    ('a0000000-0000-4000-8000-000000000062', org_id, null, practitioner_user_id, 'seed.setup',
     'organization', 'a0000000-0000-4000-8000-000000000001', 'Demo practice seeded', '{"source":"seed"}')
  on conflict (id) do nothing;

  raise notice 'Seed complete. organization_id=% patient_id=%  → set CLINICAL_ORG_ID=%', org_id, patient_id, org_id;
end
$seed$;
