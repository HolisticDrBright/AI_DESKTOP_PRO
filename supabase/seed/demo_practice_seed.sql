-- ============================================================
-- Demo practice seed v2 — clinical project (urcjiehlxoehievobezf)
--
-- Seeds TWO synthetic practices so tenancy, access rules, and the deployed
-- verification gate can be exercised with real accounts:
--
--   Org A "Bright Longevity Clinic (Demo)"
--     • Practitioner 1 (P1) — owner of Org A
--     • Practitioner 2 (P2) — plain practitioner in Org A (limited access)
--     • Patient 1 "Avery Demo"  — P1 only
--     • Patient 2 "Jordan Sample" — P1 AND P2
--     • Labs: current + historical hs-CRP (trend), one REVIEWED marker (TSH),
--       one UNCLASSIFIED marker (no lab flag → status NULL), one CRITICAL
--       result, one low-confidence extraction (review-gated)
--     • Appointments (in-person, telehealth, org-level break), review tasks,
--       a source lab document, reasoning snapshot, protocol, audit events
--   Org B "Second Practice (Demo)"
--     • P2 — owner of Org B (P2 is the DUAL-ORG practitioner)
--     • Patient 3 "Riley Crosscheck" — P2 only, in Org B
--     • One appointment, one open task, one lab document + observation,
--       audit events
--
-- ACCESS MATRIX (what the deployed gate verifies):
--   P1 → Patient 1 ✓  Patient 2 ✓  Patient 3 ✗ (different org — must fail)
--   P2 → Patient 2 ✓ (Org A)  Patient 3 ✓ (Org B)  Patient 1 ✗
--
-- ALL DATA IS SYNTHETIC — no real PHI. Realistic-looking demo numbers only.
--
-- HOW TO RUN (~2 minutes, development/staging ONLY):
--   1. Supabase Dashboard → Authentication → Add user — create TWO logins
--      (P1 and P2). Copy both UUIDs.
--   2. Edit the five lines marked EDIT below: both UUIDs, both emails, and
--      the explicit override flag.
--   3. Run this whole file in the SQL editor (runs as postgres, so the
--      append-only audit_events inserts are allowed — app roles still can't
--      write audit_events directly).
--
-- PRODUCTION GUARD: the script REFUSES to run unless
--   allow_demo_seed := true   (explicit, edited-by-hand override)
-- and it also refuses when the database already contains organizations other
-- than the two seed orgs — a sign this is NOT a disposable demo environment.
--
-- IDEMPOTENT: fixed UUIDs + ON CONFLICT DO NOTHING throughout — safe to
-- re-run; never duplicates, never overwrites rows you've edited.
-- After seeding: sign in at /login as P1 or P2 — the organization is
-- selected from the account's own memberships (no env var needed).
-- ============================================================

do $seed$
declare
  -- ─── EDIT THESE FIVE LINES ───────────────────────────────────────────────
  p1_user_id uuid := '00000000-0000-0000-0000-000000000000'; -- ← P1 auth user UUID
  p1_email   text := 'p1@example.com';                       -- ← P1 email
  p2_user_id uuid := '00000000-0000-0000-0000-000000000000'; -- ← P2 auth user UUID
  p2_email   text := 'p2@example.com';                       -- ← P2 email
  allow_demo_seed boolean := false;                          -- ← set true to confirm this is a DEMO environment
  -- ─────────────────────────────────────────────────────────────────────────

  org_a uuid := 'a0000000-0000-4000-8000-000000000001';
  org_b uuid := 'b0000000-0000-4000-8000-000000000001';

  patient1 uuid := 'a0000000-0000-4000-8000-000000000002'; -- Org A, P1 only
  patient2 uuid := 'a0000000-0000-4000-8000-000000000006'; -- Org A, P1 + P2
  patient3 uuid := 'b0000000-0000-4000-8000-000000000002'; -- Org B, P2 only

  doc_a uuid := 'a0000000-0000-4000-8000-000000000003';
  doc_b uuid := 'b0000000-0000-4000-8000-000000000003';
  snap_id uuid := 'a0000000-0000-4000-8000-000000000004';

  def_crp  uuid := 'a0000000-0000-4000-8000-000000000010';
  def_vitd uuid := 'a0000000-0000-4000-8000-000000000011';
  def_tsh  uuid := 'a0000000-0000-4000-8000-000000000012';
  def_ferr uuid := 'a0000000-0000-4000-8000-000000000013';
  def_a1c  uuid := 'a0000000-0000-4000-8000-000000000014';
  def_k    uuid := 'a0000000-0000-4000-8000-000000000015'; -- Potassium (critical fixture)
  def_na   uuid := 'a0000000-0000-4000-8000-000000000016'; -- Sodium (unclassified fixture)

  foreign_org_count integer;
begin
  -- ── Guards ────────────────────────────────────────────────────────────────
  if not allow_demo_seed then
    raise exception 'Refusing to seed: this script is for DEMO/DEVELOPMENT databases only. Edit allow_demo_seed := true to confirm.';
  end if;
  select count(*) into foreign_org_count
  from public.organizations where id not in (org_a, org_b);
  if foreign_org_count > 0 then
    raise exception 'Refusing to seed: % organization(s) already exist that this seed did not create — this looks like a real environment, not a disposable demo.', foreign_org_count;
  end if;
  if p1_user_id = '00000000-0000-0000-0000-000000000000'
     or p2_user_id = '00000000-0000-0000-0000-000000000000' then
    raise exception 'Edit the seed first: set p1_user_id and p2_user_id to the auth user UUIDs (Dashboard → Authentication).';
  end if;
  if p1_user_id = p2_user_id then
    raise exception 'P1 and P2 must be two DIFFERENT auth users — the access-rule fixtures depend on it.';
  end if;
  if not exists (select 1 from auth.users where id = p1_user_id) then
    raise exception 'No auth.users row with id % (P1) — create the user in the dashboard first.', p1_user_id;
  end if;
  if not exists (select 1 from auth.users where id = p2_user_id) then
    raise exception 'No auth.users row with id % (P2) — create the user in the dashboard first.', p2_user_id;
  end if;

  -- ── Organizations ─────────────────────────────────────────────────────────
  insert into public.organizations (id, name, slug, created_by) values
    (org_a, 'Bright Longevity Clinic (Demo)', 'bright-longevity-demo', null),
    (org_b, 'Second Practice (Demo)',         'second-practice-demo',  null)
  on conflict (id) do nothing;

  -- ── Memberships: P1 owns Org A; P2 is a plain practitioner in Org A AND
  --    owns Org B (the dual-org fixture) ──────────────────────────────────────
  insert into public.organization_memberships (organization_id, user_id, role, status) values
    (org_a, p1_user_id, 'owner',        'active'),
    (org_a, p2_user_id, 'practitioner', 'active'),
    (org_b, p2_user_id, 'owner',        'active')
  on conflict do nothing;

  insert into public.practitioner_profiles (id, organization_id, user_id, display_name, credentials, specialty, created_by) values
    ('a0000000-0000-4000-8000-000000000005', org_a, p1_user_id, split_part(p1_email, '@', 1), 'Practitioner', 'Functional Medicine', p1_user_id),
    ('a0000000-0000-4000-8000-000000000007', org_a, p2_user_id, split_part(p2_email, '@', 1), 'Practitioner', 'Nutrition', p2_user_id),
    ('b0000000-0000-4000-8000-000000000005', org_b, p2_user_id, split_part(p2_email, '@', 1), 'Practitioner', 'Functional Medicine', p2_user_id)
  on conflict (id) do nothing;

  -- ── Patients + DIFFERENT access rules ────────────────────────────────────
  insert into public.patient_profiles (id, organization_id, mrn, first_name, last_name, date_of_birth, sex, status, created_by) values
    (patient1, org_a, 'DEMO-0001', 'Avery',  'Demo',       '1988-03-14', 'female', 'active', p1_user_id),
    (patient2, org_a, 'DEMO-0002', 'Jordan', 'Sample',     '1975-11-02', 'male',   'active', p1_user_id),
    (patient3, org_b, 'DEMO-1001', 'Riley',  'Crosscheck', '1992-06-21', 'other',  'active', p2_user_id)
  on conflict (id) do nothing;

  insert into public.practitioner_patient_relationships (organization_id, practitioner_user_id, patient_id, status) values
    (org_a, p1_user_id, patient1, 'active'),  -- P1 → Patient 1
    (org_a, p1_user_id, patient2, 'active'),  -- P1 → Patient 2
    (org_a, p2_user_id, patient2, 'active'),  -- P2 → Patient 2 (shared)
    (org_b, p2_user_id, patient3, 'active')   -- P2 → Patient 3 (Org B only)
  on conflict do nothing;

  -- ── Source lab documents (one per org) ────────────────────────────────────
  insert into public.lab_documents (id, organization_id, patient_id, file_name, file_type, storage_path,
                                    lab_company, panel_name, lab_date, processing_status, uploaded_by, source, created_by) values
    (doc_a, org_a, patient1, 'demo-panel-2026-07.pdf', 'application/pdf',
     'seed/demo-panel-2026-07.pdf', -- placeholder path; no file bytes exist (synthetic seed)
     'Quest Diagnostics (Demo)', 'Comprehensive wellness panel', current_date - 7, 'extracted', p1_user_id, 'seed', p1_user_id),
    (doc_b, org_b, patient3, 'demo-metabolic-2026-07.pdf', 'application/pdf',
     'seed/demo-metabolic-2026-07.pdf',
     'Labcorp (Demo)', 'Basic metabolic panel', current_date - 3, 'extracted', p2_user_id, 'seed', p2_user_id)
  on conflict (id) do nothing;

  -- ── Biomarker definitions ────────────────────────────────────────────────
  insert into public.biomarker_definitions (id, canonical_name, default_unit, biological_system) values
    (def_crp,  'hs-CRP',           'mg/L',   'Inflammation'),
    (def_vitd, 'Vitamin D, 25-OH', 'ng/mL',  'Micronutrient'),
    (def_tsh,  'TSH',              'mIU/L',  'Thyroid'),
    (def_ferr, 'Ferritin',         'ng/mL',  'Iron'),
    (def_a1c,  'Hemoglobin A1c',   '%',      'Metabolic'),
    (def_k,    'Potassium',        'mmol/L', 'Electrolytes'),
    (def_na,   'Sodium',           'mmol/L', 'Electrolytes')
  on conflict (id) do nothing;

  -- ── Observations, Patient 1 (Org A) ──────────────────────────────────────
  -- Current panel + history. Deliberate fixtures:
  --   • hs-CRP history → trend          • TSH 'accepted' → the REVIEWED marker
  --   • Potassium 'critical_high'       → the CRITICAL result
  --   • Sodium status NULL              → the UNCLASSIFIED marker (no lab flag;
  --     the app must show "Unclassified", never assume normal)
  --   • Ferritin confidence 0.55        → low-confidence, review-gated
  insert into public.biomarker_observations
    (id, organization_id, patient_id, biomarker_definition_id, lab_document_id,
     value_numeric, unit, status, original_reference_interval, confidence, provenance,
     source, review_status, observed_at, created_by) values
    ('a0000000-0000-4000-8000-000000000020', org_a, patient1, def_crp,  doc_a, 2.8, 'mg/L',   'high',          '<3.0',    0.97, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '7 days',  p1_user_id),
    ('a0000000-0000-4000-8000-000000000021', org_a, patient1, def_crp,  null,  3.4, 'mg/L',   'high',          '<3.0',    0.96, 'lab_pdf_extraction', 'seed', 'accepted',   now() - interval '97 days', p1_user_id),
    ('a0000000-0000-4000-8000-000000000022', org_a, patient1, def_vitd, doc_a, 28,  'ng/mL',  'low',           '30-100',  0.95, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '7 days',  p1_user_id),
    ('a0000000-0000-4000-8000-000000000023', org_a, patient1, def_tsh,  doc_a, 2.1, 'mIU/L',  'normal',        '0.4-4.0', 0.98, 'lab_pdf_extraction', 'seed', 'accepted',   now() - interval '7 days',  p1_user_id),
    ('a0000000-0000-4000-8000-000000000024', org_a, patient1, def_ferr, doc_a, 62,  'ng/mL',  'normal',        '20-200',  0.55, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '7 days',  p1_user_id),
    ('a0000000-0000-4000-8000-000000000025', org_a, patient1, def_a1c,  doc_a, 5.6, '%',      'normal',        '4.0-5.6', 0.97, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '7 days',  p1_user_id),
    ('a0000000-0000-4000-8000-000000000026', org_a, patient1, def_k,    doc_a, 6.2, 'mmol/L', 'critical_high', '3.5-5.2', 0.98, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '7 days',  p1_user_id),
    ('a0000000-0000-4000-8000-000000000027', org_a, patient1, def_na,   doc_a, 141, 'mmol/L', null,            null,      null, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '7 days',  p1_user_id)
  on conflict (id) do nothing;

  -- ── Observations, Patient 2 (Org A, shared P1+P2) ────────────────────────
  insert into public.biomarker_observations
    (id, organization_id, patient_id, biomarker_definition_id, lab_document_id,
     value_numeric, unit, status, original_reference_interval, confidence, provenance,
     source, review_status, observed_at, created_by) values
    ('a0000000-0000-4000-8000-000000000028', org_a, patient2, def_a1c, null, 6.1, '%',     'high',   '4.0-5.6', 0.96, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '30 days', p1_user_id),
    ('a0000000-0000-4000-8000-000000000029', org_a, patient2, def_tsh, null, 3.2, 'mIU/L', 'normal', '0.4-4.0', 0.97, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '30 days', p1_user_id)
  on conflict (id) do nothing;

  -- ── Observations, Patient 3 (Org B) ──────────────────────────────────────
  insert into public.biomarker_observations
    (id, organization_id, patient_id, biomarker_definition_id, lab_document_id,
     value_numeric, unit, status, original_reference_interval, confidence, provenance,
     source, review_status, observed_at, created_by) values
    ('b0000000-0000-4000-8000-000000000020', org_b, patient3, def_na, doc_b, 133, 'mmol/L', 'low', '135-145', 0.94, 'lab_pdf_extraction', 'seed', 'unreviewed', now() - interval '3 days', p2_user_id)
  on conflict (id) do nothing;

  -- ── Review queue (tasks) ─────────────────────────────────────────────────
  insert into public.review_queue_items (id, organization_id, patient_id, item_type, ref_id, title, priority, status, created_by) values
    ('a0000000-0000-4000-8000-000000000030', org_a, patient1, 'abnormal_result',
     'a0000000-0000-4000-8000-000000000026', 'CRITICAL potassium 6.2 — confirm specimen and act today', 'high', 'open', p1_user_id),
    ('a0000000-0000-4000-8000-000000000032', org_a, patient1, 'lab_extraction',
     'a0000000-0000-4000-8000-000000000024', 'Verify low-confidence ferritin extraction against source', 'medium', 'open', p1_user_id),
    ('a0000000-0000-4000-8000-000000000031', org_a, null, 'assessment',
     null, 'Quarterly demo-practice QA checklist', 'low', 'open', p1_user_id),
    ('b0000000-0000-4000-8000-000000000030', org_b, patient3, 'abnormal_result',
     'b0000000-0000-4000-8000-000000000020', 'Low sodium — recheck and review medications', 'medium', 'open', p2_user_id)
  on conflict (id) do nothing;

  -- ── Reasoning snapshot + hypotheses + protocol (Org A, review-gated) ─────
  insert into public.reasoning_snapshots (id, organization_id, patient_id, trigger, input_record_ids, structured_output, review_status, source)
  values (snap_id, org_a, patient1, 'seed_demo',
          jsonb_build_array('a0000000-0000-4000-8000-000000000020','a0000000-0000-4000-8000-000000000022'),
          jsonb_build_object('summary','Demo snapshot: low-grade inflammation pattern with suboptimal vitamin D.'),
          'unreviewed', 'seed')
  on conflict (id) do nothing;

  insert into public.clinical_hypotheses (id, organization_id, patient_id, title, status, review_status, source) values
    ('a0000000-0000-4000-8000-000000000040', org_a, patient1, 'Low-grade inflammatory burden', 'proposed', 'unreviewed', 'seed'),
    ('a0000000-0000-4000-8000-000000000041', org_a, patient1, 'Vitamin D insufficiency contributing to fatigue', 'proposed', 'unreviewed', 'seed')
  on conflict (id) do nothing;

  insert into public.supplement_protocols (id, organization_id, patient_id, name, status, source)
  values ('a0000000-0000-4000-8000-000000000050', org_a, patient1, 'Foundational anti-inflammatory support (draft)', 'draft', 'seed')
  on conflict (id) do nothing;

  -- ── Chart data for the lens engine (Avery, Org A) — ALL SYNTHETIC ────────
  -- Deliberate fixtures so the deterministic differential/lens gate has real
  -- invariant-core output to verify:
  --   • Sertraline (active) + St. John's Wort item → INTERACTION caution
  --   • Penicillin VK (active) + penicillin allergy → deliberate CONFLICTING
  --     chart data (the engine must surface it, never resolve it silently)
  --   • Critical potassium above → critical-lab urgent red flag
  insert into public.medications (id, organization_id, patient_id, name, status, source, created_by) values
    ('a0000000-0000-4000-8000-000000000080', org_a, patient1, 'Sertraline', 'active', 'seed', p1_user_id),
    ('a0000000-0000-4000-8000-000000000081', org_a, patient1, 'Penicillin VK', 'active', 'seed', p1_user_id)
  on conflict (id) do nothing;

  insert into public.allergies (id, organization_id, patient_id, allergen, reaction, severity, status, source, created_by) values
    ('a0000000-0000-4000-8000-000000000082', org_a, patient1, 'penicillin', 'hives', 'moderate', 'active', 'seed', p1_user_id)
  on conflict (id) do nothing;

  insert into public.supplement_products (id, name, form, description)
  values ('a0000000-0000-4000-8000-000000000083', 'St. John''s Wort Extract (Demo)', 'capsule', 'Synthetic demo product for interaction fixtures')
  on conflict (id) do nothing;

  insert into public.supplement_protocol_items (id, organization_id, patient_id, protocol_id, product_id, schedule, timing, purpose, source, created_by)
  values ('a0000000-0000-4000-8000-000000000084', org_a, patient1,
          'a0000000-0000-4000-8000-000000000050', 'a0000000-0000-4000-8000-000000000083',
          'daily', 'morning', 'Demo fixture — interaction caution with sertraline', 'seed', p1_user_id)
  on conflict (id) do nothing;

  -- ── Appointments (relative times → land in the visible week) ─────────────
  insert into public.appointments (id, organization_id, patient_id, practitioner_user_id,
    appointment_type, location, telehealth_url, status, starts_at, ends_at, source, created_by) values
    ('a0000000-0000-4000-8000-000000000070', org_a, patient1, p1_user_id,
     'follow-up', 'Room 1', null, 'confirmed',
     date_trunc('hour', now()) + interval '26 hours',
     date_trunc('hour', now()) + interval '26 hours 45 minutes', 'seed', p1_user_id),
    ('a0000000-0000-4000-8000-000000000071', org_a, patient2, p1_user_id,
     'telehealth', 'Telehealth', null, 'scheduled',
     date_trunc('hour', now()) + interval '50 hours',
     date_trunc('hour', now()) + interval '50 hours 30 minutes', 'seed', p1_user_id),
    ('a0000000-0000-4000-8000-000000000072', org_a, null, p1_user_id,
     'break', 'Admin', null, 'scheduled',
     date_trunc('hour', now()) + interval '28 hours',
     date_trunc('hour', now()) + interval '29 hours', 'seed', p1_user_id),
    ('b0000000-0000-4000-8000-000000000070', org_b, patient3, p2_user_id,
     'initial', 'Room A', null, 'scheduled',
     date_trunc('hour', now()) + interval '30 hours',
     date_trunc('hour', now()) + interval '31 hours', 'seed', p2_user_id)
  on conflict (id) do nothing;

  -- ── Example audit events (seeded as postgres; app writes stay RPC-only) ──
  insert into public.audit_events (id, organization_id, patient_id, actor_user_id, action, resource_type, resource_id, safe_message, metadata) values
    ('a0000000-0000-4000-8000-000000000060', org_a, patient1, p1_user_id, 'seed.import',
     'lab_document', doc_a::text, 'Demo lab document seeded', '{"source":"seed"}'),
    ('a0000000-0000-4000-8000-000000000061', org_a, patient1, p1_user_id, 'biomarker.review',
     'biomarker_observation', 'a0000000-0000-4000-8000-000000000021', 'Biomarker marked accepted',
     '{"decision":"accepted","previous_status":"unreviewed","source":"seed"}'),
    ('a0000000-0000-4000-8000-000000000062', org_a, null, p1_user_id, 'seed.setup',
     'organization', 'a0000000-0000-4000-8000-000000000001', 'Demo practice seeded', '{"source":"seed"}'),
    ('b0000000-0000-4000-8000-000000000060', org_b, patient3, p2_user_id, 'seed.import',
     'lab_document', doc_b::text, 'Demo lab document seeded', '{"source":"seed"}'),
    ('b0000000-0000-4000-8000-000000000061', org_b, null, p2_user_id, 'seed.setup',
     'organization', 'b0000000-0000-4000-8000-000000000001', 'Second demo practice seeded', '{"source":"seed"}')
  on conflict (id) do nothing;

  raise notice 'Seed complete. Org A=% (P1 owner, P2 practitioner) · Org B=% (P2 owner).', org_a, org_b;
  raise notice 'Access matrix: P1→{Avery, Jordan}, P2→{Jordan (Org A), Riley (Org B)}. Sign in at /login — orgs are selected from memberships.';
end
$seed$;
