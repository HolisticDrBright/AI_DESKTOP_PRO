# AI Longevity Pro — documentation index

This repo owns the **desktop practitioner app** and the **clinical database
schema**. The shared backend and the Phase 0 audit live in the platform repo
[`HolisticDrBright/rork-ai-longevity-coach`](https://github.com/HolisticDrBright/rork-ai-longevity-coach).
This index ties the two together so the desktop repo carries its full audit
trail.

## Architecture decisions

Decisions are recorded in the repo that owns them.

**This repo — clinical data + desktop** (`docs/architecture-decisions/`):
- [0001 — Clinical data isolation](./architecture-decisions/0001-clinical-data-isolation.md):
  why clinical PHI lives in a dedicated Supabase project, with the HIPAA
  blast-radius rationale and why it does not fork the backend.
- [0002 — Identity & system of record](./architecture-decisions/0002-identity-and-system-of-record.md):
  single identity provider (the clinical project), staged legacy-data
  migration, and the `auth.users` ↔ `patient_profiles`/`practitioner_profiles`
  linkage spec.

**Platform repo — shared backend** (`docs/architecture-decisions/` on `main`):
- [0001 — Record architecture decisions](https://github.com/HolisticDrBright/rork-ai-longevity-coach/blob/main/docs/architecture-decisions/0001-record-architecture-decisions.md)
- [0002 — Capture baseline schema before migrations](https://github.com/HolisticDrBright/rork-ai-longevity-coach/blob/main/docs/architecture-decisions/0002-capture-baseline-schema-before-migrations.md)
- [0003 — Centralized authorization & org model](https://github.com/HolisticDrBright/rork-ai-longevity-coach/blob/main/docs/architecture-decisions/0003-centralized-authorization-and-org-model.md)
  — implemented by `backend/trpc/clinical-authorization.ts`.

## Phase 0 audit (platform repo `main`)

- [current-architecture.md](https://github.com/HolisticDrBright/rork-ai-longevity-coach/blob/main/docs/current-architecture.md)
- [database-inventory.md](https://github.com/HolisticDrBright/rork-ai-longevity-coach/blob/main/docs/database-inventory.md)
- [security-gap-analysis.md](https://github.com/HolisticDrBright/rork-ai-longevity-coach/blob/main/docs/security-gap-analysis.md)
- [desktop-platform-roadmap.md](https://github.com/HolisticDrBright/rork-ai-longevity-coach/blob/main/docs/desktop-platform-roadmap.md)
- [rls-snapshot.md](https://github.com/HolisticDrBright/rork-ai-longevity-coach/blob/main/docs/rls-snapshot.md)

## Database (this repo)

- [`supabase/README.md`](../supabase/README.md) — schema, RLS model, migration
  history reconciliation.
- [`supabase/migrations/`](../supabase/migrations/) — 0001–0012, forward-only.
- Tests (run against the live project, rolled back, every row `pass = true`):
  [`cross_tenant_isolation.sql`](../supabase/tests/cross_tenant_isolation.sql)
  (org isolation) and
  [`practitioner_assignment_access.sql`](../supabase/tests/practitioner_assignment_access.sql)
  (intra-org assignment gate — 37 assertions).

## Backend & live path

- Authenticated tRPC layer: `backend/trpc/clinical-authorization.ts` +
  `routes/clinical/` in the platform repo.
- [live-api.md](./live-api.md) — how the desktop's `patients` namespace is
  flag-swapped to the backend, and exactly what is verified vs. what the
  sandbox egress policy blocks.

## Product & design

- [architecture.md](./architecture.md), [platform/](./platform/),
  [design-handoff/](./design-handoff/), [screenshots/](./screenshots/).
