---
title: "AI Longevity Pro Clinical Intelligence — Backend Prompt Enhancement Addendum (for Claude Code)"
type: engineering-spec
date: 2026-07-14
business: "[[AI Longevity Pro App]]"
tags: [backend, claude-code, prompt, ALP, schema, biocanic, enhancement]
related: ["[[2026-07-14 ALP Clinical Intelligence — Deep Dive & Enhancement Blueprint]]"]
---

# BACKEND PROMPT — ENHANCEMENT ADDENDUM

## HOW TO USE THIS FILE
Give Claude Code the **original backend prompt unchanged**, then append this addendum below it.
This is an ADDENDUM, not a replacement. The original prompt's constraints still apply in full:
do not rewrite from scratch, do not remove working mobile features, do not create a second
isolated backend, preserve the core stack, RLS on every tenant/patient table, deterministic
safety outside the LLM, no PHI in logs. This addendum only ADDS to the domain model, routers,
services, and phase order. Where this addendum conflicts with the original, prefer the original's
security posture and add the new capability behind a feature flag.

Rationale: a competitive deep dive (Biocanic, Jane App, Practice Better) confirmed the original
prompt's clinical-intelligence architecture is ahead of all three, but is missing the
practice-operations "system of record" layer every competitor treats as core, plus a
population/outcomes layer a competitor (Biocanic Nexus) is actively marketing. Close those gaps
without diluting the reasoning depth.

---

## A. NEW DOMAIN ENTITIES

Add these to the multi-tenant domain model. Every new patient- or org-specific table follows the
SAME required-column rules already defined (id, organization_id, patient_id where applicable,
source, source_record_id, created_at, updated_at, created_by, updated_by, deleted_at/superseded_at).
Financial and operational tables must also carry the same RLS, audit, and tenant-isolation rules
as clinical tables. Do NOT weaken RLS for "business" tables — billing data is still PHI-adjacent.

### Billing & Payments (highest priority — currently absent)
* products_services            (billable items: visits, programs, packages, labs)
* fee_schedules
* invoices
* invoice_line_items
* payments
* payment_methods              (tokenized via processor; never store raw PAN)
* refunds
* credits
* superbills
* insurance_payers
* insurance_policies
* insurance_claims
* claim_line_items
* claim_status_events
* eras                         (electronic remittance advice)
* packages                     (prepaid session bundles)
* package_redemptions
* memberships
* subscriptions
* subscription_invoices
* ledger_entries               (immutable double-entry style audit of money movement)

Requirements:
* Use a proven payment processor (Stripe) and a clearinghouse (Claim.MD or equivalent) via the
  connector framework in section D. Do NOT build a card processor or a clearinghouse.
* All monetary amounts stored as integer minor units + ISO currency; never floats.
* ledger_entries and claim_status_events are append-only; never mutate historical financial rows.
* Idempotency keys required on: payment capture, refund, claim submission, webhook ingestion.
* Support an unlimited-clients / per-seat + per-intelligence-tier pricing model at the org level
  (billing is per practitioner seat and plan tier, NOT per patient).

### Operations — Telehealth & Automations
* telehealth_sessions          (integration record only — see below)
* automation_rules
* automation_triggers          (e.g., new_abnormal_lab, adherence_below_threshold, lab_uploaded,
                                intake_completed, appointment_booked, experiment_completed)
* automation_conditions
* automation_actions           (create_task, notify, send_message, enroll_program, flag_review)
* automation_runs              (audit of every fired automation, append-only)

Requirements:
* Telehealth is an INTEGRATION, not a build. Wire to a proven provider (Zoom / Daily / Whereby).
  telehealth_sessions stores provider, external session id, join links, status, timestamps —
  never raw media. Competitor lesson: self-built video is Practice Better's #1 complaint.
* Automation rules are deterministic, versioned, sourced, and testable — SAME discipline as the
  safety engine. An LLM may DRAFT an automation, but only versioned deterministic rules execute.
* Every automation_run is audited. No automation may auto-send patient-facing clinical content
  without passing through practitioner review when the original prompt requires review.

### Outcomes & Evidence Registry (the E-E-A-T moat)
* outcome_measures             (validated instruments + custom: PHQ-9, GAD-7, symptom scores, etc.)
* outcome_observations
* outcome_snapshots            (longitudinal, per patient, per program)
* research_cohorts             (consented, de-identified groupings)
* cohort_memberships
* protocol_effectiveness       (derived: intervention -> biomarker/outcome deltas across cohort)

Requirements:
* Cohort/population data must be built ONLY from consented records; enforce via consents table +
  data_sharing_authorizations already in the model.
* De-identification for any cross-patient/aggregate view is a hard requirement; aggregates must
  suppress small cells (e.g., n < a configurable minimum) to prevent re-identification.

### Migration & Import
* import_jobs                  (new background-job type; mirrors extraction_jobs pattern)
* import_field_mappings
* import_review_items

Requirements:
* Build importers for Practice Better, Biocanic, and Jane exports (clients, notes, labs, protocols).
* Imports are staged, field-mapped, and human-reviewed before commit — never silent bulk insert.
* Preserve source + source_record_id so imported data keeps provenance.

---

## B. NEW / EXPANDED tRPC ROUTERS

Add to the domain-router split already specified:
* billing            (invoices, payments, packages, memberships, subscriptions, ledger)
* claims             (insurance policies, claim submission, status, ERAs)
* automations        (rules CRUD, test/dry-run, run history)
* telehealth         (session create/join via provider connector)
* population          (cohort + practice analytics; see section C)
* outcomes           (measures, observations, snapshots)
* imports            (migration jobs, mappings, review)

All new routers use the SAME authorization helpers already defined (organizationProcedure,
practitionerProcedure, patientAccessProcedure, adminProcedure). Financial mutations require
practitioner or admin role and full audit events. Never accept organization_id, patient
ownership, or invoice ownership from the client without server-side authorization.

---

## C. POPULATION / PRACTICE INTELLIGENCE SERVICE (Nexus-parity, done more rigorously)

Add a populationAnalyticsService alongside the existing AI services. It aggregates the SAME
clinical_facts, biomarker_observations, supplement_exposures, experiment_conclusions, and
outcome_observations across a practitioner's authorized panel or a consented cohort.

Capabilities:
* Cohort outcome reporting (which interventions moved which biomarkers/outcomes, with effect
  direction and data completeness — never a causal claim, same "not a probability" discipline).
* Protocol effectiveness rollups.
* Panel-level review load, risk distribution, adherence distribution.
* Practice operations analytics (revenue, unbilled sessions, claim aging) from the billing tables.

Hard rules:
* Aggregates are computed ONLY over records the requesting practitioner is authorized to access,
  or over consented de-identified cohorts. RLS still applies to the underlying rows.
* Suppress small cells; never expose a single patient through an "aggregate."
* Population inference is labeled as inference with the same provenance and evidence-grade tags
  as per-patient reasoning. It must NOT emit population-level medical probabilities.
* This is a differentiator against Biocanic Nexus — win on provenance and honesty, not hype.

---

## D. VERSIONED CONNECTOR FRAMEWORK ("connects to your apps")

Elevate the existing integrations tables into a first-class connector framework. Each connector
record carries: provider, kind, scopes, auth_reference (secrets never client-exposed),
sync_status, last_sync_at, next_sync_at, error_state, safe_error_message, webhook_secret_ref,
and a versioned adapter id.

First-class connectors to name explicitly:
* ALP mobile (Expo patient app) — two-way: patient-reported observations, journaling, habits,
  and adherence flow BACK into clinical_facts / patient_reported facts and feed the reasoning
  and N-of-1 engines. Make this loop explicit in the schema. (This two-sided loop is the
  structural advantage over Biocanic's view-only portal — build it deliberately.)
* Quantum Mind — behavior-support sessions + outcomes, per the original Quantum Mind section.
* Fullscript (+ dispensary) — supplement product data, orders, refills, adherence.
* Labs — at least one ordering + result connector (Rupa/Fullscript Labs, Evexia), plus the
  200+ specialty-lab result ingestion needed to match Biocanic (DUTCH, GI-MAP, Genova,
  Doctor's Data, Mosaic, Vibrant, Cyrex, TruDiagnostic) via the existing extraction pipeline.
* Vital — wearables (preserve existing integration).
* Stripe — payments (section A).
* Claim.MD (or equivalent) — insurance clearinghouse (section A).
* Telehealth provider — Zoom / Daily / Whereby (section A).
* Cerbo — optional EHR interop for hybrid/prescriber practices.

Requirements:
* Webhook signature validation on every inbound connector (already required generally — enforce
  per connector).
* Per-connector idempotency + retry + safe error surfacing to the Integrations UI.
* Connector health is observable (section on observability) with NO PHI in monitoring events.

---

## E. SECURITY / COMPLIANCE ADDITIONS

Add to the existing security section (which is already strong):
* Pursue SOC 2 Type 2 explicitly; structure logging, access, and change management to be
  audit-ready from day one. (Jane's SOC 2 + data residency is a clinic-grade sales gate; the
  original prompt is correct that software changes alone do not make you HIPAA compliant.)
* Add configurable data-residency at the organization level (region selection at signup) as a
  schema + infra concern, even if only one region ships first. It is a documented differentiator.
* Add an explicit "AI data-use" guarantee to the AI services: patient data is processed in-region
  and is NEVER used to train external/third-party models. Record this as a config + surface it.
  (Both Biocanic and Practice Better sell hard on this; make it true and visible.)
* Financial/PHI-adjacent tables get the same "no PHI in logs, no raw payloads in general logs"
  treatment as clinical tables.

Do not overstate compliance. Update /docs/hipaa-readiness-checklist.md to include billing/claims
data flows, the payment processor and clearinghouse BAAs, and the telehealth provider BAA.

---

## F. REVISED IMPLEMENTATION ORDER

Keep the original Phase 1 (auth centralization, org model, patient access, audit, secure storage,
CORS + logging hardening) exactly as written — it is the correct foundation and must come first.

Then adjust:

Phase 2 (expanded):
* Desktop shell, client directory, patient context, tasks, review queue, appointments, assessments
* ADD: minimal Billing slice (invoices, payments via Stripe connector, packages)
* ADD: Connector framework skeleton + first-class connectors: ALP mobile (two-way loop),
  Fullscript, one lab, Vital, telehealth provider
* Rationale: without ops parity + the data pipe, the practice never becomes system-of-record and
  later reasoning phases are starved of data.

Phase 3: Lab ingestion, biomarker normalization, lab review, timeline, provenance (unchanged) +
  broaden specialty-lab coverage to match Biocanic's list.

Phase 4-6: Clinical facts, hypotheses, evidence, contradictions, reasoning snapshots, Health Twin,
  Supplement Intelligence, N-of-1 — UNCHANGED. This is the differentiator; protect its depth.
  ADD to Phase 4/5: outcomes registry + populationAnalyticsService (Nexus-parity).

Phase 7: Program Builder, automations engine, reporting, Quantum Mind — as written, with the
  automations engine built to the deterministic/versioned/audited standard in section A.

Also add: migration importers (section A) can land any time after Phase 2 as an adoption lever.

---

## G. GUARDRAILS SPECIFIC TO THIS ENHANCEMENT

* Do NOT let ops features dilute reasoning depth. Reach ops PARITY; keep reasoning SUPREMACY.
* Do NOT self-build telehealth video, a payment processor, or a clearinghouse.
* Do NOT weaken RLS or audit for financial/operational tables.
* Do NOT emit population-level or per-patient medical probabilities.
* Do NOT expose any single patient through an aggregate/cohort view (cell suppression + consent).
* Feature-flag every unfinished capability, as the original prompt requires.
* For each slice, follow the original WORKING METHOD (goal, affected files, migrations, security
  implications, smallest coherent slice, tests, typecheck/lint/test/build, docs, summary,
  rollback). Do not fabricate passing tests or integrations.

## H. FIRST ACTION FOR THIS ADDENDUM
Do NOT start any of this until the original Phase 1 (tenant isolation, patient access, audit,
CORS/logging hardening) is complete and verified. Then implement, as the first addendum slice:
1. Connector framework skeleton (tables + adapter interface + webhook validation), and
2. Minimal Billing slice (products_services, invoices, invoice_line_items, payments via Stripe
   connector) behind a feature flag,
with RLS tests, cross-tenant access tests, and audit-log tests before any UI is wired.
Then report: files changed, migrations, tests added, security improvements, remaining risks,
and the exact next recommended slice.
