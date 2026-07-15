# AI Desktop Pro — Clinical Platform Database

Version-controlled schema for the **dedicated** Supabase project that backs the
AI Longevity Pro clinical intelligence platform.

## Why a dedicated project

Phase 0 (see [`rork-ai-longevity-coach/docs`](https://github.com/HolisticDrBright/rork-ai-longevity-coach))
found that the legacy database (`utuszztwwadvoxxuyshn`, "Dr. Bright's Project")
is a **shared, ~230-table multi-product database** — clinical PHI co-resident
with unrelated crypto-trading, marketing, astrology, and personal-finance
systems. For a HIPAA-aiming clinical platform that is a material liability
(shared blast radius, no clean BAA/data-residency boundary, entangled
backup/DR).

Decision: stand up a **purpose-built, isolated project** for the clinical
platform rather than build on the shared DB or on `bright-os` (which turned out
to be an active agent-OS product with its own data and colliding table names).

- **Project:** `AI Desktop Pro` — ref `urcjiehlxoehievobezf`, region `us-east-2`.
- Clinical PHI lives only here. No unrelated tables share the instance.

## Status (applied + verified)

- **146 tables**, **RLS enabled on all 146** (0 without RLS), **179 policies**.
- **Supabase security advisor: 0 findings.**
- **Cross-tenant isolation test passes** (`tests/cross_tenant_isolation.sql`):
  a user in Org B sees zero of Org A's organization, patient, clinical
  hypothesis, invoice, or membership rows; the Org A owner sees all of theirs.

## Design principles (enforced in the schema)

- **Organization-first tenancy.** Every tenant/patient table carries
  `organization_id`; isolation is enforced by RLS, not just the app layer.
- **Authorization helpers live in a `private` schema** (`is_org_member`,
  `has_org_role`, `is_org_admin`, `can_access_patient`) — `SECURITY DEFINER`
  with pinned `search_path`, executable only by `authenticated`/`service_role`,
  and **not** exposed as PostgREST RPC. RLS policies call them; clients cannot.
- **Patient = org-owned record, optionally linked to an auth user**
  (`patient_profiles.user_id`) — unifies the legacy clinic-record and
  mobile-user models.
- **Uniform RLS.** Patient-scoped tables use one
  `can_access_patient(patient_id)` policy for ALL commands (the patient, an
  assigned practitioner, or an org admin). Reference/knowledge tables (no PHI)
  are authenticated-read / service-role-write. Financial tables are org-admin
  scoped.
- **Provenance/audit columns** on every patient table (`source`,
  `source_record_id`, `created_by`, `updated_by`, `deleted_at`) and
  **observation columns** (`observed_at`, `ingested_at`, `data_quality`,
  `confidence`, `provenance`, `review_status`, `reviewed_by`, `reviewed_at`) on
  observation tables.
- **Regulatory guardrails baked in:** `clinical_hypotheses.reasoning_strength`
  is documented as an internal 0–100 weighting, **not** a probability;
  `reasoning_snapshots` is immutable/append-only with "no hidden
  chain-of-thought"; experiment conclusions and safety severities use the
  spec's cautious enumerations; monetary values are **integer minor units**.

## Migrations

| File | Module |
| --- | --- |
| `…000001_tenancy_foundation` | organizations, memberships, role helpers, owner-bootstrap, RLS |
| `…000002_patient_access_model` | practitioner/patient profiles, relationships, invitations, `can_access_patient` |
| `…000003_privacy_foundation` | consents, data-sharing, **audit_events**/**access_events** (append-only), breach, export/deletion requests |
| `…000004_clinical_core` | goals, conditions, symptoms, allergies, medications, procedures, family history, encounters, notes |
| `…000005_labs_biomarkers` | biomarker dictionary, org optimal ranges, lab documents/panels/observations, extraction pipeline |
| `…000006_reasoning_and_health_twin` | clinical facts, hypotheses, evidence, contradictions, reasoning snapshots, risk flags, Adaptive Health Twin |
| `…000007_supplement_intelligence` | product/ingredient knowledge graph, protocols, exposures, adherence |
| `…000008_experiments` | N-of-1 experiments, phases, outcomes, observations, analyses, conclusions |
| `…000009_operations_programs_assessments` | appointments, tasks, messages, files, tags, programs, assessments |
| `…000010_safety_knowledge_jobs_outcomes` | safety rules/evals, knowledge sources, jobs, AI ledger, Quantum Mind, wearables/nutrition, outcomes/cohorts, imports, review queue |
| `…000011_billing_claims_automations_connectors` | billing, insurance claims, automations, connector framework, telehealth |

Migrations 0003–0011 were authored and applied to the live project via the
Supabase MCP `execute_sql` (the environment's egress policy blocks the CLI's
Docker path), then verified with the security advisor + isolation test. The
files here reproduce exactly what is live.

## Applying to a fresh project / syncing history / types

```bash
supabase link --project-ref urcjiehlxoehievobezf
# existing project already has the schema — record history instead of re-running:
supabase migration repair --status applied \
  20260715000001 20260715000002 20260715000003 20260715000004 20260715000005 \
  20260715000006 20260715000007 20260715000008 20260715000009 20260715000010 20260715000011
# a truly fresh project instead just needs:  supabase db push
supabase gen types typescript --linked > src/lib/database.types.ts
```

Run the isolation test after applying (every output row must have `pass = true`);
extend it with a row per new patient/tenant table.

## What this is and isn't

This is the **data foundation** — schema, RLS, and provenance for the whole
platform (prompt 1 domain + the prompt 2 addendum). It does **not** include the
application layer: tRPC routers, AI-orchestration services, external
integrations (Stripe / clearinghouse / telehealth / Fullscript / Vital), edge
functions, or data migration from the legacy project. Those build on top of
this schema; see `rork-ai-longevity-coach/docs/desktop-platform-roadmap.md`.
