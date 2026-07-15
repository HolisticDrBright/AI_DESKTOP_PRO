<!--
  Provenance: extracted from the uploaded Word document
  "AI_Longevity_Platform_Development.docx" (2026-07). Content is verbatim;
  heading levels and list formatting were flattened by extraction.
  This is the ORIGINAL backend prompt referenced by backend-addendum.md —
  per the addendum, use it unchanged and append the addendum below it.
  It targets the HolisticDrBright/rork-ai-longevity-coach repository (the
  existing Expo app + Hono/tRPC/Supabase backend), NOT this repo.
-->

# AI Longevity Platform Development — Original Backend Prompt



    You are the principal software architect and senior backend engineer for the existing GitHub repository:

    HolisticDrBright/rork-ai-longevity-coach

    Your task is to evolve the current AI Longevity Pro application into a secure, multi-tenant clinical intelligence platform that supports:

    The existing Expo patient application.

    A new desktop-first practitioner web application.

    Biocanic-style practice operations.

    Dynamic clinical reasoning.

    An Adaptive Health Twin.

    N-of-1 experimentation.

    Supplement Intelligence.

    Strong provenance, auditing, permissions and practitioner oversight.

    Do not rewrite the application from scratch.

    Do not remove working mobile features.

    Do not create a second isolated backend.

    Preserve the current core stack unless an architecture change is clearly justified:

    Expo and Expo Router

    React Native

    TypeScript

    Supabase

    Hono

    tRPC

    TanStack Query

    Zustand

    Zod

    Vercel AI SDK

    Vital wearable integration

    Sentry

    CURRENT ARCHITECTURE TO VERIFY

    The repository currently appears to contain an Expo application under /expo.

    The application currently uses:

    Expo Router

    React Native Web

    Supabase authentication

    PIN authentication

    HIPAA consent provider

    User provider

    Protocol provider

    Labs provider

    Hormone provider

    Nutrition provider

    Supplements provider

    Wearables provider

    Hono backend

    tRPC API

    Supabase

    Sentry

    Vital wearable SDK

    Nutrition image processing

    PDF lab extraction

    The tRPC application currently exposes at least:

    nutrition

    clinic

    supplements

    Verify all of this by inspecting the actual repository before making changes.

    PHASE ZERO: FULL REPOSITORY AUDIT

    Before implementing features:

    Inspect the entire repository tree.

    Identify:

    All applications

    All routes

    All providers

    All database calls

    All tRPC routers

    All Hono middleware

    All environment variables

    All AI calls

    All Supabase tables referenced in code

    All file storage usage

    All authentication paths

    All role checks

    All mobile and web-specific logic

    All external integrations

    Existing tests

    Existing deployment files

    Inspect package files and lockfiles.

    Inspect recent commits relating to:

    PDF lab extraction

    Nutrition analysis

    Supplements

    Clinic functionality

    Authentication

    Fly.io deployment

    Identify code that currently stores health information only in React providers, Zustand or local device storage.

    Identify places where PHI could appear in:

    Logs

    Sentry

    Analytics

    Error messages

    AI prompts

    Create:

    /docs/current-architecture.md

    /docs/database-inventory.md

    /docs/security-gap-analysis.md

    /docs/desktop-platform-roadmap.md

    /docs/architecture-decisions/

    Do not perform destructive database migrations during the audit.

    TARGET REPOSITORY STRUCTURE

    Determine whether the repository can safely be reorganized toward:

    apps/ mobile/ clinical-web/ api/

    packages/ domain/ database/ api-client/ ui/ validation/ auth/ ai/ clinical-reasoning/ supplement-intelligence/ experiments/ design-tokens/ config/

    Do not move files solely for aesthetic reasons.

    Use incremental migration.

    The existing Expo application may remain under /expo initially if moving it creates unnecessary risk.

    NEW DESKTOP APPLICATION

    Create a desktop practitioner application using:

    Next.js App Router

    React

    TypeScript

    Tailwind CSS

    Radix or shadcn/ui primitives

    TanStack Query

    tRPC

    React Hook Form

    Zod

    TanStack Table

    Recharts or Visx

    Lucide icons

    The desktop application must use the same backend and shared domain schemas as the Expo application.

    Do not duplicate API schemas manually between mobile and web.

    MULTI-TENANT DOMAIN MODEL

    Implement an organization-first model.

    Required entities:

    Identity:

    users

    organizations

    organization_memberships

    roles

    permissions

    clinics

    practitioner_profiles

    patient_profiles

    practitioner_patient_relationships

    invitations

    Privacy:

    consents

    data_sharing_authorizations

    privacy_acknowledgements

    audit_events

    access_events

    breach_notifications

    record_export_requests

    record_deletion_requests

    Clinical:

    health_goals

    conditions

    symptoms

    symptom_observations

    allergies

    medications

    medication_exposures

    procedures

    family_history

    lifestyle_observations

    environmental_exposures

    patient_notes

    clinical_notes

    encounters

    Labs:

    lab_documents

    lab_panels

    biomarker_definitions

    biomarker_aliases

    biomarker_observations

    reference_ranges

    optimal_ranges

    extraction_jobs

    extraction_fields

    extraction_corrections

    Supplements:

    supplement_brands

    supplement_products

    supplement_product_versions

    supplement_ingredients

    ingredient_aliases

    product_ingredient_amounts

    supplement_protocols

    supplement_protocol_items

    supplement_exposures

    supplement_adherence

    ingredient_evidence

    ingredient_interactions

    contraindications

    nutrient_upper_limits

    Programs:

    programs

    program_versions

    program_templates

    program_enrollments

    program_steps

    program_conditions

    program_tasks

    educational_content

    message_templates

    Assessments:

    assessment_templates

    assessment_versions

    assessment_sections

    assessment_questions

    assessment_rules

    assessment_assignments

    assessment_responses

    assessment_scores

    Wearables:

    wearable_connections

    wearable_data_sources

    wearable_observations

    wearable_daily_summaries

    wearable_sync_jobs

    Nutrition:

    food_logs

    meal_photos

    detected_food_items

    nutrition_calculations

    nutrition_targets

    meal_plans

    Reasoning:

    clinical_facts

    clinical_hypotheses

    evidence_items

    contradictions

    missing_data_recommendations

    clinical_relationships

    reasoning_snapshots

    reasoning_snapshot_items

    recommendations

    practitioner_decisions

    risk_flags

    Experiments:

    experiments

    experiment_phases

    experiment_interventions

    experiment_outcomes

    experiment_observations

    experiment_confounders

    experiment_adverse_events

    experiment_analyses

    experiment_conclusions

    Operations:

    appointments

    tasks

    task_assignments

    conversations

    messages

    notifications

    files

    tags

    patient_tags

    integrations

    integration_sync_jobs

    Every patient-specific table must include:

    id

    organization_id

    patient_id where applicable

    source

    source_record_id where applicable

    created_at

    updated_at

    created_by

    updated_by

    deleted_at or superseded_at where appropriate

    Clinical observations must also include:

    observed_at

    ingested_at

    data_quality

    confidence

    provenance

    review_status

    reviewed_by

    reviewed_at

    DATABASE AND SUPABASE

    Use Supabase Postgres as the source of truth.

    Create versioned SQL migrations.

    Enable Row Level Security on every table containing tenant or patient data.

    Policies must enforce:

    Users only access organizations to which they belong.

    Patients only access their own records unless explicitly authorized.

    Practitioners only access assigned or authorized patients.

    Clinic administrators only access their clinic or organization.

    Platform administrators use explicit privileged service operations.

    Service-role access is never exposed to the client.

    Do not rely only on UI checks.

    Add tests that attempt unauthorized cross-tenant access.

    Create separate schemas or carefully separated namespaces if helpful:

    public

    clinical

    knowledge

    audit

    Do not put protected health information into database logs or migration output.

    AUTHENTICATION AND AUTHORIZATION

    Preserve Supabase authentication.

    Review the existing PIN authentication flow.

    Determine whether PIN authentication should remain:

    Local re-authentication

    Session unlock

    Biometric fallback

    Secondary application lock

    Do not use the PIN as a replacement for proper server authentication.

    Create a centralized authorization layer used by every tRPC procedure.

    Define protected procedure helpers such as:

    authenticatedProcedure

    organizationProcedure

    practitionerProcedure

    patientProcedure

    adminProcedure

    patientAccessProcedure

    Every protected call must derive identity from the authenticated server context.

    Never accept organization_id or patient ownership from the client without validating authorization.

    API ARCHITECTURE

    Continue using Hono and tRPC.

    Split the current app router into domain routers:

    auth

    organizations

    users

    clients

    clinic

    appointments

    tasks

    messages

    assessments

    programs

    labs

    biomarkers

    supplements

    nutrition

    wearables

    protocols

    reasoning

    healthTwin

    experiments

    reports

    files

    integrations

    audit

    Use Zod schemas for all inputs and structured outputs.

    Use cursor pagination for large tables and timelines.

    Add idempotency keys for:

    File uploads

    Lab ingestion

    Integration webhooks

    Experiment processing

    AI analysis jobs

    Use background jobs for long-running operations rather than holding open API requests.

    BACKGROUND JOBS

    Introduce a durable job system appropriate for the current deployment.

    Jobs include:

    PDF extraction

    Lab normalization

    OCR fallback

    Wearable sync

    Supplement-label extraction

    Clinical reasoning refresh

    Experiment analysis

    Report generation

    Notification delivery

    Integration synchronization

    Each job should have:

    id

    type

    organization_id

    patient_id when applicable

    status

    progress

    attempts

    max_attempts

    input reference

    output reference

    error code

    safe error message

    created_at

    started_at

    completed_at

    Do not store sensitive raw job payloads in general logs.

    FILE INGESTION

    Create a secure file-ingestion pipeline.

    Support:

    PDF

    PNG

    JPEG

    CSV

    JSON where explicitly supported

    Requirements:

    Upload original file to private storage.

    Validate MIME type and size.

    Scan or validate content before processing where possible.

    Create immutable file metadata.

    Launch extraction job.

    Preserve raw extracted text.

    Preserve source page and bounding information when available.

    Normalize extracted fields.

    Mark low-confidence results for review.

    Permit human correction.

    Preserve original and corrected values.

    Never overwrite historical results silently.

    Use signed URLs with short expiration.

    Do not expose public buckets for protected health information.

    LAB NORMALIZATION

    Create a biomarker dictionary.

    It must support:

    Canonical marker name

    Aliases

    LOINC when available

    Unit types

    Conversion rules

    Biological system tags

    Specimen type

    Sex-specific ranges

    Age-specific ranges

    Laboratory-provided ranges

    Practitioner-configurable optimal ranges

    Always preserve:

    Original marker name

    Original result

    Original unit

    Original reference interval

    Source document

    Source page

    Never replace the laboratory range with an optimal range.

    CLINICAL REASONING ENGINE

    Build a versioned, auditable reasoning pipeline.

    The system must distinguish:

    Measured fact

    Patient-reported fact

    Practitioner-confirmed conclusion

    Published evidence

    AI inference

    Conflicting information

    Missing information

    A ClinicalHypothesis must contain:

    id

    organization_id

    patient_id

    title

    description

    category

    status

    reasoning_strength

    supporting_evidence_count

    contradicting_evidence_count

    earliest_supporting_date

    last_updated_at

    prior_strength

    strength_change

    change_explanation

    review_status

    reviewed_by

    reviewed_at

    Do not call reasoning_strength a probability.

    Required statuses:

    proposed

    under_review

    supported

    weakened

    unresolved

    rejected

    archived

    Reasoning pipeline:

    Identify triggering data.

    Validate and normalize it.

    Add or update clinical facts.

    Detect meaningful temporal changes.

    Retrieve relevant patient history.

    Retrieve curated knowledge.

    Update existing hypotheses.

    Propose possible new hypotheses.

    Attach supporting evidence.

    Attach contradicting evidence.

    Identify confounders.

    Identify missing data.

    Run deterministic safety rules.

    Generate role-appropriate recommendations.

    Store immutable reasoning snapshot.

    Route required items to practitioner review.

    Each reasoning snapshot must record:

    Trigger

    Input record IDs

    Knowledge version

    Prompt version

    Model

    Structured output

    Validation result

    Safety results

    Previous snapshot ID

    Change summary

    Practitioner review

    Do not store hidden chain-of-thought.

    Store concise reasoning summaries, evidence citations and decision factors.

    TEMPORAL REASONING

    Implement utilities that determine:

    Whether intervention preceded outcome

    Time from intervention to outcome

    Overlapping interventions

    Baseline window

    Intervention window

    Washout window

    Discontinuation

    Rechallenge

    Repeated pattern

    Data completeness

    Potential confounders

    Expected response latency

    Do not infer causality solely from temporal sequence.

    ADAPTIVE HEALTH TWIN

    Implement the Health Twin as a derived, versioned patient model.

    Systems:

    metabolic

    cardiovascular

    inflammatory_immune

    hormonal

    gastrointestinal

    detoxification_exposure

    mitochondrial_energy

    cognitive_neurological

    musculoskeletal

    stress_autonomic

    sleep_circadian

    healthy_aging

    For each system store:

    state

    trend

    reasoning_strength

    data_quality

    supporting_fact_ids

    contradicting_fact_ids

    active_hypothesis_ids

    active_intervention_ids

    missing_data_ids

    last_updated_at

    practitioner_review_status

    Use event-driven recomputation.

    Do not claim that this is a validated molecular simulation.

    Call it:

    Adaptive Health Twin

    SUPPLEMENT INTELLIGENCE NETWORK

    Create a normalized supplement knowledge and patient-response system.

    Capabilities:

    Product database

    Product versions

    Ingredient normalization

    Ingredient-form recognition

    Label-photo extraction

    Complete stack audit

    Cumulative-dose calculation

    Duplicate detection

    Evidence grading

    Goal relevance

    Biomarker relevance

    Drug-supplement interactions

    Supplement-supplement interactions

    Contraindications

    Upper intake checks

    Monitoring recommendations

    Personal response analysis

    Cost and complexity analysis

    Adherence and refill tracking

    The system must separate:

    Product label facts

    Published ingredient evidence

    General safety rules

    Patient-specific observations

    AI interpretation

    Practitioner decisions

    Do not let an LLM be the sole interaction-checking system.

    Create deterministic, versioned safety rules.

    STACK AUDIT OUTPUT

    Return structured results:

    duplicate ingredients

    cumulative daily amounts

    possible excessive amounts

    doses below studied ranges

    form mismatches

    medication interactions

    supplement interactions

    condition cautions

    kidney or liver cautions

    procedure cautions

    pregnancy or lactation cautions

    allergy conflicts

    required monitoring

    products without an active goal

    possible simplification opportunities

    Significant actions must require practitioner review.

    N-OF-1 EXPERIMENT ENGINE

    Create an experiment service.

    Experiment types:

    before_after

    withdrawal_rechallenge

    alternating_treatment

    randomized_crossover

    custom

    Experiment fields:

    goal

    hypothesis

    primary_intervention

    baseline_duration

    intervention_duration

    washout_duration

    control_duration

    primary_outcome

    secondary_outcomes

    target_change

    minimum_data_completeness

    stable_variables

    confounders

    stopping_rules

    approval_requirement

    analysis_date

    Default to one primary variable per experiment.

    The analysis service must calculate:

    Baseline mean or median

    Intervention mean or median

    Absolute change

    Relative change

    Variability

    Data completeness

    Adherence

    Confounding events

    Adverse events

    Expected-latency compatibility

    Allowed conclusions:

    likely_beneficial

    possibly_beneficial

    no_measurable_effect

    possibly_harmful

    inconclusive

    Do not overstate causality.

    Store experiment results as evidence in the Adaptive Health Twin.

    ASSESSMENTS AND INTAKE FORMS

    Create versioned form templates.

    Support:

    Sections

    Question types

    Conditional display

    Required fields

    Scoring

    Calculated fields

    Reusable question libraries

    Longitudinal comparison

    Patient assignments

    Due dates

    Completion reminders

    Practitioner review

    Never alter historical responses when a template changes.

    PROGRAM BUILDER

    Build reusable program templates containing:

    Assessments

    Educational content

    Nutrition targets

    Supplement protocols

    Habits

    Wearable goals

    Tasks

    Appointments

    Messages

    Labs

    Experiments

    Quantum Mind sessions

    Support:

    Relative scheduling

    Conditional branches

    Completion requirements

    Practitioner approval steps

    Automated reminders

    Program versions

    Enrollment history

    OPERATIONS

    Build:

    Client directory

    Appointments

    Tasks

    Practitioner review queue

    Messaging

    Notifications

    Tags

    Teams

    Program enrollment

    Activity history

    Do not build a full generic CRM unless required.

    Focus on clinical program operations.

    AI ORCHESTRATION

    Do not use one giant prompt.

    Create specialized services:

    documentExtractionService

    labNormalizationService

    timelineService

    hypothesisService

    contradictionService

    missingDataService

    supplementAnalysisService

    experimentDesignService

    experimentAnalysisService

    patientExplanationService

    practitionerReportService

    quantumMindRoutingService

    Every AI service must:

    Use structured output

    Validate output with Zod

    Record model and prompt version

    Record input record references

    Record knowledge references

    Support retries

    Fail safely

    Avoid including unrelated patient data

    Use the minimum necessary patient context.

    KNOWLEDGE RETRIEVAL

    Maintain separate retrieval domains:

    Patient records

    Curated clinical knowledge

    Supplement evidence

    Product labels

    Practitioner protocols

    Patient education

    Do not treat arbitrary internet content as trusted clinical evidence.

    Knowledge records must include:

    Source

    Publication date

    Review date

    Evidence type

    Evidence quality

    Population

    Dose or exposure

    Outcome

    Version

    Deprecation status

    SAFETY ENGINE

    Build deterministic safety checks outside the LLM.

    Rule categories:

    medication interaction

    supplement interaction

    allergy

    pregnancy

    lactation

    kidney function

    liver function

    upcoming procedure

    abnormal laboratory finding

    dosage limit

    contraindicated condition

    urgent symptom

    emergency symptom

    Severity:

    informational

    monitor

    practitioner_review_required

    urgent_evaluation

    emergency_instruction

    Rules must be versioned, sourced and testable.

    PRACTITIONER REVIEW

    Create a central review queue.

    Review item types:

    lab extraction

    abnormal result

    reasoning snapshot

    hypothesis

    recommendation

    supplement interaction

    protocol

    experiment

    assessment

    patient message

    Practitioners must be able to:

    accept

    modify

    reject

    comment

    assign

    defer

    request data

    convert to task

    approve patient visibility

    QUANTUM MIND

    Integrate Quantum Mind as an optional behavior-support service.

    Do not diagnose mental-health conditions.

    Allow routing based on:

    Goal

    Adherence barrier

    Stress pattern

    Sleep concern

    Pain behavior

    Motivation

    User preference

    Track:

    Recommended session

    Completion

    Subjective response

    Adherence effect

    Outcome relationship

    SECURITY AND PRIVACY

    Implement:

    Encryption in transit

    Encryption at rest through approved infrastructure

    Secure secrets management

    Row Level Security

    Tenant isolation

    Access auditing

    Data-export workflow

    Data-deletion workflow

    Short-lived signed URLs

    No PHI in general logs

    No PHI in analytics

    Safe Sentry configuration

    Rate limiting

    Session expiration

    Device-session management

    Password and credential protections

    Webhook signature validation

    Backup and restoration plan

    Review the existing broad CORS configuration.

    Replace unrestricted CORS with environment-specific allowlists.

    Review all console logging.

    Do not log request bodies, clinical values, patient identifiers or AI prompts containing PHI.

    HIPAA

    Do not claim the product is HIPAA compliant based on software changes.

    Create:

    /docs/hipaa-readiness-checklist.md

    Include:

    Technical safeguards

    Administrative safeguards

    Physical safeguards

    Business associate agreements

    Vendor review

    Incident response

    Workforce access

    Risk assessment

    Backup and disaster recovery

    Policies and training

    TESTING

    Add:

    Unit tests

    Integration tests

    Database migration tests

    Row Level Security tests

    Cross-tenant access tests

    Authorization tests

    Lab extraction tests

    Biomarker normalization tests

    Supplement aggregation tests

    Interaction-rule tests

    Reasoning structured-output tests

    Temporal reasoning tests

    Experiment-analysis tests

    Audit-log tests

    File-access tests

    End-to-end practitioner workflows

    End-to-end patient workflows

    Use synthetic health records only.

    OBSERVABILITY

    Create safe operational monitoring for:

    API availability

    Job failures

    Integration failures

    Extraction failures

    Model failures

    Database errors

    Latency

    Queue backlog

    Do not attach PHI to monitoring events.

    IMPLEMENTATION ORDER

    Phase 1:

    Repository audit

    Authorization centralization

    Organization model

    Patient access model

    Audit logging

    Secure storage review

    CORS and logging hardening

    Phase 2:

    Desktop application shell

    Client directory

    Patient context

    Tasks

    Review queue

    Appointments

    Assessments

    Phase 3:

    Lab ingestion

    Biomarker normalization

    Lab review

    Longitudinal timeline

    Provenance

    Phase 4:

    Clinical facts

    Hypotheses

    Evidence

    Contradictions

    Reasoning snapshots

    Adaptive Health Twin Level 1

    Phase 5:

    Supplement Intelligence Network

    Product label extraction

    Stack audit

    Safety rules

    Personal response

    Phase 6:

    N-of-1 experiments

    Outcome analysis

    Health Twin response model

    Phase 7:

    Program Builder

    Automations

    Reporting

    Quantum Mind integration

    WORKING METHOD

    For each implementation slice:

    State the goal.

    Identify affected files.

    Identify database migrations.

    Identify security implications.

    Implement the smallest coherent slice.

    Add tests.

    Run:

    TypeScript checks

    Lint

    Unit tests

    Integration tests

    Production build

    Fix all failures caused by the change.

    Update documentation.

    Summarize:

    What changed

    What remains

    Risks

    Migration instructions

    Rollback instructions

    Do not silently change production schemas.

    Do not fabricate passing tests.

    Do not fabricate integrations.

    Use feature flags for unfinished features.

    INITIAL EXECUTION

    Begin with the repository audit.

    Then implement only the first safe coherent slice:

    Centralized authenticated tRPC context

    Organization and membership model

    Patient access authorization

    Audit event foundation

    Restricted CORS configuration

    Removal or sanitization of PHI-risk logging

    Do not begin the clinical reasoning engine until patient ownership, tenant isolation and audit controls are established.

    After completing the first slice, provide:

    Files changed

    Migrations created

    Tests added

    Security improvements

    Remaining risks

    Exact next recommended slice

