# Live API path — status, architecture & verification

The desktop consumes data exclusively through the adapter façade
(`src/adapters/index.ts`, the `api` object). A single feature flag decides
whether each wired namespace reads/writes the real clinical backend or the
in-session demo layer. Components never import Supabase, tRPC, fetch clients,
or auth clients directly.

## Modes

| | Demo (default) | Live |
| --- | --- | --- |
| Flag | `NEXT_PUBLIC_USE_LIVE_API` unset / `false` | `NEXT_PUBLIC_USE_LIVE_API=true` (or `1`) |
| Data | mock modules + `sessionStorage` | real backend under RLS |
| Audit | session audit log (clears with the tab) | append-only `audit_events` |
| Persistence | none | real rows |

`src/adapters/mode.ts` is the single source of truth for the flag and the
dev-only identity overrides.

## Architecture (ADR 0002 + ADR 0003)

```
client component
   └─ api.<domain>.*                 (src/adapters/index.ts — the only import UI uses)
        ├─ DEMO → mock module + session-store            (unchanged)
        └─ LIVE
             ├─ migrated domains → server component or same-origin route
             │                    → *.live.ts → supabase-rest.server → Supabase (RLS/RPC)
             └─ transitional domains → same-origin route/server component
                                      → *.live.ts → trpc.server → legacy tRPC transport
```

- The browser **never** talks to Postgres/Supabase directly. Server-only
  modules (`*.live.ts`, `supabase-rest.server.ts`, `trpc.server.ts`,
  `session.server.ts`, `live-status.server.ts`) carry a browser guard and are
  only reached from server components or `/api/live/*` route handlers.
- Client components in live mode reach the backend through same-origin route
  handlers (`src/app/api/live/*`) via the client-safe `live-client.ts`. No
  credentials or server clients ship to the browser.
- Desktop server code uses only the publishable key plus the signed-in
  practitioner's JWT. It does not use a service-role key. The database's RLS
  policies and role-gated **SECURITY DEFINER RPCs** remain authoritative.

## The secure write path

`audit_events` is append-only (migration 0003): org-admin `SELECT`, and **no**
insert/update/delete policy. Rather than hand the server a service-role key
(which would bypass every RLS check), app-facing SECURITY DEFINER functions
run as owner but **authorize the caller explicitly** with the same `private.*`
helpers RLS uses, and stamp actor ids from `auth.uid()`:

| Function | Purpose |
| --- | --- |
| `review_biomarker(observation_id, decision, note?)` | Update review columns + append audit row, atomically. Never touches lab value / unit / reference interval / provenance / confidence. |
| `list_audit_events(org, limit)` | Read the caller's own events (all events if org admin). |
| `create_review_task(patient_id, title, …)` | Downstream link: enqueue a `review_queue_items` row + audit. |
| `resolve_review_queue_item(item_id, note?)` — migration `0014` | Resolve a queue item + append audit row, atomically. Idempotent on already-resolved items; org-level (patient-null) items require a practitioner/admin role. |
| `record_registered_audit_event(org, event, …)` — migration `20260728222649` | Append a generic Desktop UI event using database-owned action, resource type, wording, and per-event scalar metadata rules. |

`search_path` is pinned empty and every object is schema-qualified. `EXECUTE`
is revoked from `public` + `anon` and granted to `authenticated` only. Migration
`20260728222813` also revokes direct `audit_events` table privileges; reads and
generic writes pass through the caller-authorized functions.

The legacy `record_audit_event` function remains temporarily for older callers.
The Desktop same-origin route does not expose it: it accepts only a registered
event key, identifiers, and bounded scalar metadata.

> Advisor note: these functions raise the expected
> `authenticated_security_definer_function_executable` WARN. That is
> **accepted by design** — they are the deliberate authenticated write path to
> the append-only table; each authorizes the caller in-function. `SECURITY
> INVOKER` is not an option (the caller has no `INSERT` on `audit_events`).

## What is wired

| Namespace / method | Demo | Live |
| --- | --- | --- |
| `patients.list` / `patients.get` | mock | ✅ real `patient_profiles` through the Desktop-owned server boundary; selected-org filter + RLS |
| `organizations.mine` / `claim` / member management | n/a | ✅ Desktop-owned REST/RPC boundary; active caller memberships only; database-enforced admin/owner guards |
| practitioner sign-in / refresh / sign-out | n/a | ✅ server-only Supabase Auth; rotated refresh tokens, selected-org preservation, current-session revocation |
| `patients.summary` | mock | mock (synthesized, no DB source) |
| `labs.getWorkspace` | mock | ✅ Desktop-owned `list_patient_lab_observations` + RLS-scoped patient/document reads |
| `labs.reviewMarker` / `flagMarker` | session + session audit | ✅ direct `review_biomarker` RPC (persist + audit) |
| `labs.createReviewTask` | session queue item | ✅ direct `create_review_task` RPC |
| `labs.uploadDocument` | n/a (demo keeps `queueUploadDemo`, no file leaves the browser) | ✅ real PDF ingestion: storage upload + deterministic extraction + `ingest_lab_extraction` RPC (migration `0016` — observations w/ verbatim originals + confidence, low-confidence review-queue item, audit, atomic); failures → `mark_lab_document_failed` (PDF stays stored, audited) |
| `tasks.getQueue` | mock queue | ✅ Desktop-owned `list_review_queue` (SECURITY INVOKER + RLS), settled status carried through reload |
| `actions.execute` — `resolve` on a queue item | session outcome + session audit | ✅ direct `resolve_review_queue_item` RPC (migration `0014`): status + audit atomically, idempotent |
| `actions.listLiveAuditEvents` / registered generic events | `[]` / session events | ✅ direct `list_audit_events` / `record_registered_audit_event` RPCs |
| `actions.execute` — other kinds | session | session (wired per-domain as slices land) |
| `schedule.getWeek` | n/a (demo calendar renders the weekday-pattern mock directly) | ✅ real `appointments` week read (RLS-scoped; patient-NULL breaks org-visible via migration `0017`) |
| `schedule.book` / `updateStatus` | n/a (demo announces, never pretends to persist) | ✅ `book_appointment` / `update_appointment_status` RPCs (migration `0017`): validation + double-booking rejection (practitioner AND patient) + status-transition rules + audit, atomic. `reschedule_appointment` exists server-side; drag-to-reschedule UI is a later slice |
| `knowledge.pathways` / `createDraft` / `updateDraft` / `approve` | session registry | ✅ authenticated organization registry through role-gated RPCs; approved content is immutable |
| `knowledge.imports` / `stageImport` / `reviewImportItem` | session import review | ✅ immutable, hashed import batches with no-PHI attestation; acceptance creates only a pathway draft or pending product label |
| everything else | mock | mock |

`ActionBar` executes through `api.actions.execute`; an action whose context
carries a `liveRef` routes to the real mutation in live mode, so future live
domains plug in at the façade without touching components.

All live mutations flow through the reusable `runClinicalMutation` helper
(`src/adapters/mutations.ts`): optimistic update → live write (or demo effect)
→ rollback on failure → standardized `{ ok, message, persisted }` outcome.

## Reusable integration layer (for wiring future domains)

| File | Role |
| --- | --- |
| `src/adapters/mode.ts` | flag + dev overrides + `describeMode()` status |
| `src/adapters/errors.ts` | `AdapterError` (code + clinician-safe message), normalizers |
| `src/adapters/mutations.ts` | `runClinicalMutation` (optimistic/rollback/audit) |
| `src/adapters/live-client.ts` | client-safe bridge to `/api/live/*` |
| `src/adapters/live-types.ts` | PHI-safe wire DTOs |
| `src/adapters/*.live.ts` | server-only Supabase or transitional tRPC calls per domain |
| `src/adapters/trpc.server.ts` | dependency-free tRPC query/mutation client |
| `src/adapters/supabase-rest.server.ts` | Desktop-owned, server-only clinical REST/RPC transport |
| `src/app/api/live/*` | route handlers (client → server bridge) |
| `src/components/ui/ClinicalStates.tsx` | shared loading / empty / error |
| `src/components/settings/DataSourceCard.tsx` | env/status panel |

**To wire a new domain live:** add `<domain>.live.ts` (Desktop-owned
Supabase calls by default) → add a
`/api/live/<domain>/*` route (client-initiated) or call it from a server
component (reads) → add the live branch in `index.ts` behind `USE_LIVE_API`,
reusing `runClinicalMutation` for writes and `ClinicalStates` for async UI.

The clinical knowledge registry, practitioner identity/session lifecycle,
organization selection and membership management, patient directory, labs
workspace/review, review queue, and audit log use the Desktop-owned boundary
defined in ADR 0003. Their live adapters use `supabase-rest.server.ts`, with
the publishable key and caller JWT confined to the Next.js server. Lab PDF
ingestion remains worker-backed; other domains stay on transitional adapters
until migrated in their own tested slices.

## Security assumptions

- No PHI in console logs. Registered generic audit events allow only
  database-approved scalar metadata and never accept display wording from the
  browser; domain mutation functions govern their own metadata.
- No client-side service-role key; no direct writes that bypass RLS.
- `organization_id` / `patient_id` are never trusted from the client — every
  RPC re-checks access with `private.can_write_patient_data` /
  `can_access_patient` / `is_org_member` against `auth.uid()`.
- Dev overrides (`NEXT_PUBLIC_DEV_*`) are **local-only, unsafe for production**,
  and are not authentication — the backend still enforces RLS.

## Run it

**Demo (default):**
```
npm install
npm run dev            # NEXT_PUBLIC_USE_LIVE_API unset → demo mode
```

**Live:** set the env in `.env.local` (see `.env.example`):
```
NEXT_PUBLIC_USE_LIVE_API=true
TRPC_BASE_URL=…                 # transitional domains only
CLINICAL_ORG_ID=…               # or NEXT_PUBLIC_DEV_ORG_ID
CLINICAL_SUPABASE_URL=… CLINICAL_SUPABASE_ANON_KEY=…   # auth + migrated Desktop domains
```
Then `npm run dev` and **sign in at `/login`** (httpOnly cookie session; see
[`live-auth-and-seeding.md`](live-auth-and-seeding.md)). `CLINICAL_DEMO_EMAIL/
PASSWORD` is a local/e2e-only fallback when no one is signed in — do not set it
in a real deployment. Settings → **Data source & environment** shows the
resolved mode, the practitioner session, and which server-side vars are
configured (presence only).

**Live mode without infrastructure (contract fixture):** to exercise the live
UI where no backend is reachable, run the committed fixture —
`node scripts/live-stub-server.mjs` — and point the env at it (exact recipe in
the header of `e2e/live-tasks.spec.ts`). It speaks the same wire contract with
synthetic in-memory data; it is **not** the real backend, and the real data
layer is verified separately (`supabase/tests/*.sql` via MCP). The gated live
suite runs against it after a live-flag build: `E2E_LIVE=1 npm run test:e2e --
e2e/live-tasks.spec.ts e2e/live-scribe.spec.ts e2e/live-lens.spec.ts`.

## Verification (this change)

| Layer | How | Result |
| --- | --- | --- |
| Static checks | `npm run typecheck`, `npm run lint`, live production build | green |
| Unit adapters | `npm run test:unit` | **52/52** (auth, PostgREST errors, organizations, selected-org patient/lab/queue/audit reads, registered audit and review/task mutations, dates, knowledge) |
| Desktop identity DB boundary | rolled-back SQL against the clinical project — `supabase/tests/desktop_identity_directory.sql` | **6/6** (active memberships only, assigned-patient RLS, cross-tenant denial, anon execute denied, explicit grants) |
| Desktop labs/queue DB boundary | rolled-back SQL against the clinical project — `supabase/tests/desktop_labs_review_queue.sql` | **12/12** (patient and org queue visibility, reference/provenance joins, cross-tenant and anonymous denial, minimum grants, atomic review/resolve/create) |
| Desktop audit DB boundary | rolled-back SQL against the clinical project — `supabase/tests/desktop_audit_actions.sql` | **13/13** (registered wording, metadata allowlist, tenant and role visibility, anonymous and direct-table denial) |
| Demo UI | production build + Playwright | **41/41** |
| Full live contract fixture | live production build + Playwright (`live-tasks`, `live-scribe`, `live-lens`) | **32/32** (auth rotation/revocation/logout, organizations, patient isolation, labs, scheduling, EMR, scribe, lens, registered audit boundary) |
| Dependency audit | `npm audit` after non-breaking remediation | safe patch updates applied; remaining reports are the Next/sharp and ESLint/minimatch toolchains whose automated remedies require breaking downgrades |

The real signed-in staging browser gate remains an external deployment check;
the database acceptance suite and committed contract fixture are supporting
evidence, not substitutes for it.

## Repository boundary

AI Desktop Pro and AI Longevity Pro are separate products. New Desktop server
work stays in this repository (or a future Desktop-owned API repository);
Desktop feature branches and procedures are not added to
`rork-ai-longevity-coach`. See ADR 0003. Legacy tRPC-backed slices are migrated
to the Desktop-owned boundary one domain at a time, with a signed-in live
browser gate before the old transport is removed.
