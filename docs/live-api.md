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

## Architecture (ADR 0002)

```
client component
   └─ api.<domain>.*                 (src/adapters/index.ts — the only import UI uses)
        ├─ DEMO → mock module + session-store            (unchanged)
        └─ LIVE
             ├─ reads in server components → *.live.ts → trpc.server → tRPC backend → Supabase (RLS)
             └─ client-initiated calls  → live-client (fetch) → /api/live/* route handler
                                                            → *.live.ts → trpc.server → tRPC backend → Supabase (RLS)
```

- The desktop **never** talks to Postgres/Supabase directly. Server-only
  modules (`*.live.ts`, `trpc.server.ts`, `session.server.ts`,
  `live-status.server.ts`) carry a `typeof window` guard and are only reached
  from server components or `/api/live/*` route handlers — they never enter the
  client bundle.
- Client components in live mode reach the backend through same-origin route
  handlers (`src/app/api/live/*`) via the client-safe `live-client.ts`. No
  credentials or server clients ship to the browser.
- The backend is the one place that holds Supabase keys and calls the
  **SECURITY DEFINER RPCs** below as the authenticated practitioner.

## The secure write path — migration `0013`

`audit_events` is append-only (migration 0003): org-admin `SELECT`, and **no**
insert/update/delete policy. Rather than hand the backend a service-role key
(which would bypass every RLS check), migration `0013` adds four app-facing
SECURITY DEFINER functions that run as owner but **authorize the caller
explicitly** with the same `private.*` helpers RLS uses, and stamp actor ids
from `auth.uid()` server-side:

| Function | Purpose |
| --- | --- |
| `review_biomarker(observation_id, decision, note?)` | Update review columns + append audit row, atomically. Never touches lab value / unit / reference interval / provenance / confidence. |
| `record_audit_event(org, action, …)` | General append-only audit writer (PHI-safe metadata only). |
| `list_audit_events(org, limit)` | Read the caller's own events (all events if org admin). |
| `create_review_task(patient_id, title, …)` | Downstream link: enqueue a `review_queue_items` row + audit. |
| `resolve_review_queue_item(item_id, note?)` — migration `0014` | Resolve a queue item + append audit row, atomically. Idempotent on already-resolved items; org-level (patient-null) items require a practitioner/admin role. |

`search_path` is pinned empty and every object is schema-qualified. `EXECUTE`
is revoked from `public` + `anon` and granted to `authenticated` only.

> Advisor note: these four raise the expected
> `authenticated_security_definer_function_executable` WARN. That is
> **accepted by design** — they are the deliberate authenticated write path to
> the append-only table; each authorizes the caller in-function. `SECURITY
> INVOKER` is not an option (the caller has no `INSERT` on `audit_events`).

## What is wired

| Namespace / method | Demo | Live |
| --- | --- | --- |
| `patients.list` / `patients.get` | mock | ✅ real `patient_profiles` (server component → tRPC) |
| `patients.summary` | mock | mock (synthesized, no DB source) |
| `labs.getWorkspace` | mock | ✅ real workspace via `clinical.labs.getWorkspace` |
| `labs.reviewMarker` / `flagMarker` | session + session audit | ✅ `review_biomarker` RPC (persist + audit) |
| `labs.createReviewTask` | session queue item | ✅ `create_review_task` RPC |
| `tasks.getQueue` | mock queue | ✅ real `review_queue_items` (RLS-scoped), settled status carried through reload |
| `actions.execute` — `resolve` on a queue item | session outcome + session audit | ✅ `resolve_review_queue_item` RPC (migration `0014`): status + audit atomically, idempotent |
| `actions.listLiveAuditEvents` | `[]` | ✅ `list_audit_events` RPC |
| `actions.execute` — other kinds | session | session (wired per-domain as slices land) |
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
| `src/adapters/*.live.ts` | server-only tRPC calls per domain |
| `src/adapters/trpc.server.ts` | dependency-free tRPC query/mutation client |
| `src/app/api/live/*` | route handlers (client → server bridge) |
| `src/components/ui/ClinicalStates.tsx` | shared loading / empty / error |
| `src/components/settings/DataSourceCard.tsx` | env/status panel |

**To wire a new domain live:** add `<domain>.live.ts` (tRPC calls) → add a
`/api/live/<domain>/*` route (client-initiated) or call it from a server
component (reads) → add the live branch in `index.ts` behind `USE_LIVE_API`,
reusing `runClinicalMutation` for writes and `ClinicalStates` for async UI.

## Security assumptions

- No PHI in console logs; audit metadata carries no raw lab values or note text
  (enforced in `review_biomarker` and the app layer).
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
TRPC_BASE_URL=…                 # reachable tRPC backend
CLINICAL_ORG_ID=…               # or NEXT_PUBLIC_DEV_ORG_ID
CLINICAL_SUPABASE_URL=… CLINICAL_SUPABASE_ANON_KEY=…   # auth token endpoint
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
suite runs against it: `E2E_LIVE=1 npm run test:e2e -- e2e/live-tasks.spec.ts`
after a live-flag build.

## Verification (this change)

| Layer | How | Result |
| --- | --- | --- |
| Typecheck / lint / build | `npm run typecheck && npm run lint && npm run build` | green (mock and live builds) |
| DB write path (RPCs 0013) | live SQL vs the real project (MCP), simulated authenticated practitioner, rolled back — `supabase/tests/app_facing_functions.sql` | **16/16** (authorized review persists + audits; unauthorized → 42501; unauthenticated → 28000; invalid decision → 22023; lab values/provenance preserved; audit PHI-safe; anon cannot execute) |
| Demo path (browser) | Playwright | **11/11** (async labs load; review → session audit; downstream task in queue; Settings shows DEMO; audit demo view) |
| Live shell (browser) | Playwright, flag on + unreachable backend | **11/11** (LIVE badge + dev-override warning; clean retryable error state; no fake data; no misleading not-found; live append-only audit view) |
| Live route handlers | `curl /api/live/*` | clean JSON envelopes — `503 unavailable` (backend down), `400 invalid` (bad input); never a crash or fake success |

## The one hop not exercised here, and why

The final wire — **tRPC backend → real clinical Supabase over HTTP**, and the
desktop reaching a deployed backend — could not be exercised from this sandbox:
the egress proxy rejects `*.supabase.co` (`host not in allowlist`), and the
shared tRPC backend is not deployed/reachable here. Both sides of that hop are
verified independently (DB via MCP; desktop shell + route handlers + error
states via Playwright/curl). In an environment where the backend can reach the
project, the same calls complete end-to-end.

### Exact backend task remaining (in `rork-ai-longevity-coach`)

Add the `clinical.labs.getWorkspace`, `clinical.labs.reviewMarker`,
`clinical.actions.recordAudit`, `clinical.actions.listAuditEvents`, and
`clinical.actions.createReviewTask` procedures that forward the practitioner's
JWT and call the `0013` RPCs / read the workspace. The desktop already speaks
this contract.
