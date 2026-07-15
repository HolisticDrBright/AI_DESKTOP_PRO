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

## Design principles

- **Organization-first tenancy.** Every tenant/patient table carries
  `organization_id`; isolation is enforced by RLS, not just the app layer.
- **Authorization helpers live in a `private` schema** (`is_org_member`,
  `has_org_role`, `is_org_admin`, `can_access_patient`, …) — `SECURITY DEFINER`
  with pinned `search_path`, executable only by `authenticated`/`service_role`,
  and **not** exposed as PostgREST RPC. RLS policies call them; clients cannot.
- **Patient = org-owned record, optionally linked to an auth user**
  (`patient_profiles.user_id`) — unifies the legacy clinic-record and
  mobile-user models.
- Required provenance/audit columns on patient tables (`source`,
  `source_record_id`, `created_by`, `updated_by`, `deleted_at`).
- Every migration is applied **and verified**: the Supabase security advisor
  must report 0 findings, and `tests/cross_tenant_isolation.sql` must pass.

## Migrations

| File | Contents | Verified |
| --- | --- | --- |
| `migrations/20260715000001_tenancy_foundation.sql` | `organizations`, `organization_memberships`, role helpers, owner-bootstrap trigger, RLS | advisor: 0 findings |
| `migrations/20260715000002_patient_access_model.sql` | `practitioner_profiles`, `patient_profiles`, `practitioner_patient_relationships`, `invitations`, `can_access_patient`, RLS | advisor: 0 findings; cross-tenant test passes |

Applied to the live project during development via the Supabase MCP. To apply
elsewhere (or re-provision) with the CLI:

```bash
supabase link --project-ref urcjiehlxoehievobezf
supabase db push
```

## Tests

- `tests/cross_tenant_isolation.sql` — creates two orgs/users in a rolled-back
  transaction and asserts a user in Org B cannot read Org A's organization,
  patient, or memberships. Every output row must have `pass = true`. Extend it
  with a row per new patient/tenant table.

## Not yet built (next migrations)

- Privacy: `consents`, `audit_events` (append-only, service-role write,
  org-admin read).
- Clinical domain (labs/biomarkers, supplements, reasoning, …) — later phases,
  each org-scoped and RLS-tested on this same foundation.
- Backfill/import path from the legacy project for existing patient data
  (staged, reviewed — never a silent bulk copy).
