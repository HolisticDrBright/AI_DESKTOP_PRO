# ADR 0001 — Clinical data isolation: dedicated Supabase project

- **Status:** Accepted (implemented 2026-07)
- **Owners:** HolisticDrBright (product), platform engineering
- **Applies to:** `AI_DESKTOP_PRO` (schema owner), `rork-ai-longevity-coach` (shared backend + mobile app)

## Context

Phase 0 audited the legacy Supabase project (`utuszztwwadvoxxuyshn`, "Dr. Bright's
Project") and found a **shared, ~230-table, multi-product database**: clinical
PHI co-resident with unrelated crypto-trading, marketing, astrology, and
personal-finance systems. A second candidate ("bright-os") turned out to be an
active agent-OS product with its own data and colliding table names.

For a clinical platform that intends to handle real PHI, a shared instance is a
material liability:

- **Blast radius.** Any credential leak, injection, misconfigured policy, or
  runaway migration in *any* co-resident product exposes or corrupts PHI.
- **Compliance boundary.** A BAA / audit scope cannot be drawn cleanly around
  one schema inside a junk-drawer database; backup, restore, and data-residency
  guarantees are entangled with non-clinical workloads.
- **Operational coupling.** Disaster recovery, capacity, extension, and
  upgrade decisions for unrelated products would all become clinical-risk
  decisions.

## Decision

Stand up a **dedicated, purpose-built Supabase project** for the clinical
platform: **`AI Desktop Pro` — ref `urcjiehlxoehievobezf`, region `us-east-2`**.
All clinical PHI lives only there. The schema (146 tables, org-scoped RLS,
`private.can_access_patient()` gate) is version-controlled in
`AI_DESKTOP_PRO/supabase/migrations/`.

## Deviation from the standing instruction — recorded deliberately

The project brief said **"do not create a second isolated backend."** This
decision intentionally creates a second *database*, and we record why that is
not a violation of the instruction's intent:

- The instruction guards against **forked application logic** — two backends
  drifting apart. That is preserved: there is **one shared Hono/tRPC backend**
  (`rork-ai-longevity-coach/expo/backend`) which serves both apps; the desktop
  app has no server of its own and never talks to Postgres directly
  (ADR 0002, Item 3 of the server-layer slice).
- What is split is the **data plane**, for HIPAA blast-radius reasons that did
  not surface until Phase 0 inventoried the legacy database. Keeping PHI inside
  a shared multi-product instance would have been the greater violation of the
  project's own security constraints ("do not weaken tenant isolation, RLS,
  audit logging, PHI protections").
- The split was proposed to and approved by the product owner ("Option B",
  session of 2026-07) before implementation.

## Consequences

- **Positive:** clean compliance/audit boundary; PHI blast radius limited to
  one project; clinical backup/DR independent of unrelated products; schema is
  fully version-controlled from day one (the legacy schema never was).
- **Negative / accepted:** two `auth.users` pools exist until identity is
  unified (resolved by ADR 0002); legacy clinical data must be migrated once,
  via the staged, review-gated import path (never a silent bulk copy); some
  duplication of Supabase configuration (advisors, secrets) across projects.
- **Rollback:** the legacy database remains untouched and authoritative for the
  mobile app until the ADR-0002 cutover completes; abandoning the dedicated
  project before cutover loses only re-creatable schema (it is in git).

## Verification at time of decision

- 146 tables, RLS enabled on all, 179 policies; Supabase security advisor:
  **0 findings**.
- `supabase/tests/cross_tenant_isolation.sql` — org-level isolation proven.
- `supabase/tests/practitioner_assignment_access.sql` — intra-org
  assignment gate proven (15/15 live assertions).
