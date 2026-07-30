# Clinical runtime migration

The living inventory of every surface in the clinical product: what is real,
what refuses honestly, and what each domain needs to go live. Updated with
every phase. Phase 1 (this document's first edition) made the runtime
clinical-only and shipped the first real vertical slice.

**The core rule.** A domain loses its mock runtime implementation only when it
has (1) a real authenticated implementation, or (2) an honest unavailable /
not-configured state. The clinical application never fabricates patient
information to make a screen look complete. Structural enforcement:

- `npm run check:mock-imports` — walks the real import graph from every
  `src/app` entry file; fails if any path reaches `*.mock.ts` or a demo
  session store. Type-only imports are erased and allowed.
- `npm run check:clinical-bundle` — strict scan of the built client chunks for
  fixture identities and demo copy. Zero tolerance since phase 1.
- `src/adapters/clinical-fixture-barrier.test.ts` — every unwired registry
  namespace refuses with `unavailable`; refusals leak no fixture identity;
  live namespaces fail on transport rather than degrade to fixtures.

Synthetic data may exist ONLY in: `src/adapters/*.mock.ts` (unit-test
fixtures), `scripts/live-stub-server.mjs` (contract-fixture e2e), and
`supabase/seed/*` (clearly-labelled staging seeds).

## Status classification

| Class | Meaning |
| --- | --- |
| **Real & verified** | Live reads/writes through the Desktop-owned boundary, covered by SQL acceptance + e2e |
| **Real, worker-bound (transitional)** | Live, but the operation legitimately runs on the worker/provider boundary |
| **Schema ready** | Tables + RLS exist; app-facing functions/UI not built |
| **Needs schema** | No adequate tables yet |
| **External integration required** | Blocked on a third-party (payments, lab vendor, wearables, comms) |
| **Not configured** | Honest unavailable state in the UI; nav preserved |

## Domain inventory

### Real & verified (Desktop-owned, practitioner JWT + RLS + membership + patient access)

| Domain | Route(s) | Adapter | Table/RPC | Audit | Acceptance |
| --- | --- | --- | --- | --- | --- |
| Authentication (sign-in, session cookie, org selection) | `/login`, `/reset` | `auth.server.ts` | Supabase Auth + validated `aidp_org` cookie | access_events | auth.server.test, live e2e |
| Organizations & memberships | `/settings` | `organizations.live.ts` | `organization_memberships`, mgmt RPCs | audit_events | org_membership.sql |
| Patient directory / profile reads | `/patients`, chart header | `patients.live.ts` | `patient_profiles` (RLS) | access layer | desktop_identity_directory.sql |
| **Patient overview (Phase 1)** | `/patients/[id]/overview` | `overview.live.ts` → `PatientOverviewLive` | `get_patient_overview` | read-only | desktop_patient_overview.sql (18) |
| **Clinical reasoning + review (Phase 1)** | labs tab → Clinical reasoning | `reasoning.live.ts` → `ReasoningWorkspace` | `get_reasoning_workspace`, `review_hypothesis`, `hypothesis_reviews` | atomic audit_events per review | desktop_reasoning_review.sql (22) |
| Labs workspace + biomarker review | `/patients/[id]/labs` | `labs.live.ts` | `list_patient_lab_observations`, `review_biomarker` | atomic | desktop_labs_review_queue.sql |
| Review queue (read + resolve) | `/tasks` | `tasks.live.ts` | `list_review_queue`, `resolve_review_queue_item` | atomic | resolve_review_queue_item.sql |
| Audit log viewer | Settings → Governance | `actions.live.ts` | `list_audit_events` | is the audit | desktop_audit_actions.sql |
| Scheduling (read week, book, status, reschedule) | `/calendar` | `schedule.live.ts` | `get_desktop_calendar`, `book_appointment`, … | atomic | desktop_scheduling.sql |
| Encounters, notes, signatures, addenda, timeline | `/patients/[id]/chart`, encounter workspace | `encounters.live.ts` | `start_encounter`, `get_desktop_note`, `get_desktop_patient_timeline`, … | atomic; signed-note immutability | desktop_encounters_notes.sql |
| Lens lifecycle + reference reads | encounter workspace | `lens.live.ts` | desktop lens RPCs | atomic | desktop_lens acceptance |
| Clinical knowledge registry + imports | Settings → Knowledge | `knowledge.live.ts` | registry RPCs | atomic | clinical_knowledge_*.sql |

### Real, worker-bound (transitional by design — do NOT move into browser routes)

| Operation | Why worker-bound | Provider failure behavior |
| --- | --- | --- |
| Lens evaluation / AI status | rules + AI engine on the worker | explicit error; deterministic layer independent |
| Scribe binary audio upload | streams + storage coordination | explicit failure; consent gates unchanged |
| ASR transcription | provider integration | job status honest; no fake transcript |
| Scribe AI draft generation | provider integration | not-configured message; no fixture draft |
| Lab PDF extraction/storage | storage + extraction jobs | "failed" is honest: PDF stored for manual review, failure audited |

### Not configured (honest unavailable states; navigation preserved)

| Domain | Route | First real mutation when built | Needs |
| --- | --- | --- | --- |
| Inbox messaging | `/inbox`, chart Messages tab | send secure message | schema + comms integration |
| Programs | `/programs` | publish program version | schema ready (`operations` tables) |
| Billing & payments | `/billing`, chart Billing tab | create invoice | external integration (payments) |
| Inventory writes / dispensary | Settings → Catalog | receive stock | schema ready (`products_services`) |
| Protocol persistence | chart Protocol tab | save protocol draft | schema ready (`protocols`) |
| Nutrition persistence | chart Nutrition tab | save diet plan | schema ready |
| Health Twin | chart Tracking tab | approve snapshot | schema ready (`outcome_snapshots`) |
| N-of-1 experiments | chart Tracking tab | start experiment | schema ready (`experiments`) |
| Wearables | chart Tracking tab | connect source | external integration |
| Record imports | Settings → Data | approve import batch | parse+match pipeline |
| External integrations | `/integrations` | connect connector | per-connector |
| Telehealth | calendar drawer | join visit | external integration |
| Reports | `/reports` | save report run | access-scoped aggregate queries |
| Templates | `/templates` | publish template version | schema ready (`templates`) |
| Team role matrix | `/team` | change role (exists via org mgmt) | read UI over memberships |
| Assistant | drawer | grounded answer w/ provenance | governed AI config |
| Composer draft generation | composer | generated draft | governed AI config |
| Health score | overview | n/a | governed algorithm (inputs, version, review status) — **must not be calculated before then** |
| Command-palette patient search | ⌘K | n/a | live directory search endpoint |
| Notifications | top bar | n/a | live feed |
| Practice optimal ranges | labs config | save range | schema (practice_ranges) |
| Lab ordering | labs Orders tab | create requisition | external integration (lab vendor) |

## Migration ledger (project `urcjiehlxoehievobezf`)

Phase 1 found the ledger ending at `20260730002121 worker_callback_ledger_privileges`
(exactly as expected) and appended:

| Version | Name | What |
| --- | --- | --- |
| `20260730033436` | desktop_owned_patient_overview | `get_patient_overview` bounded aggregate |
| `20260730033559` | desktop_owned_reasoning_review | `hypothesis_reviews` + workspace read + atomic review RPC |
| `20260730034530` | desktop_hypothesis_review_indexes | FK covering indexes (closes the 3 introduced advisor INFOs) |

Local filenames match recorded versions. All function contracts: SECURITY
DEFINER + `search_path=''` + explicit `auth.uid()` / `private.is_org_member` /
`private.can_access_patient` gates + bounded DTOs + anon/public revoked + no
PHI in error messages or audit `safe_message`.

**Advisor posture after phase 1 DDL.** Introduced findings fixed (3 unindexed
FKs). The 3 introduced security WARNs are the generic
`authenticated_security_definer_function_executable` lint, which fires
identically for all 75 pre-existing desktop RPCs — this is the deliberate
gated-definer architecture (invoker cannot work: table privileges are revoked
from `authenticated`), and every gate is proven by the acceptance suites.
Pre-existing findings (1 RLS-no-policy INFO on `provider_callback_events`,
1 leaked-password-protection WARN, 20 auth_rls_initplan WARNs, 90
multiple-permissive-policy WARNs, 461 unindexed-FK INFOs, 89 unused-index
INFOs) are documented here and deliberately not swept in this slice.

## Deprecations

- `NEXT_PUBLIC_USE_LIVE_API` — constant `true`; not consulted anywhere.
  Remove the remaining imports opportunistically; delete the export when none
  remain.
- `api.calendar.getSchedule`, `api.patients.summary` — refusing aliases kept
  one phase so stale callers fail loudly; delete in phase 2.

## Phase 2 recommendation

**Scheduling → encounter → note signing depth**: the calendar, encounters,
notes, and timeline are all live; the highest-leverage next slice is the
front-desk workflow (arrivals/status changes feeding the calendar drawer),
plus protocol persistence (schema ready) so the chart's care-plan tab gets its
first real mutation. Both reuse existing tables and the established RPC
contract — no external integration required.
