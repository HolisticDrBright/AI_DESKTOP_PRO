# Information architecture — practitioner OS (mock-first UI overhaul)

This document is the route + navigation contract for the desktop app after
the practitioner-OS overhaul. It is implemented, not aspirational: the
redirect table and tab mapping below are enforced by `next.config.ts`,
`src/lib/routes.ts`, and the patient tab router.

Scope guard: this phase is **visual / product-workflow only**. The live
adapter contracts, EMR (encounters, notes, signatures, addenda), scribe,
lens, labs review, tasks queue, calendar booking, consent, provenance, and
audit behavior are preserved unchanged. Everything newly interactive runs on
**synthetic mock/session data** behind the typed adapter façade
(`src/adapters`). No backend, Supabase, Railway, migration, auth, RLS, or
deployment change is part of this phase.

## Primary navigation (sidebar)

Practice-level destinations only — patient-scoped duplicates are removed.
`/today` is the default home in both mock and live modes.

| Nav item | Route | Notes |
|---|---|---|
| Today | `/today` | Practitioner daily brief (default home; `/` redirects here) |
| Calendar | `/calendar` | Existing calendar + new appointment drawer |
| Patients | `/patients` | Directory (renamed from Clients); chart lives at `/patients/[id]/[tab]` |
| Review Queue | `/tasks` | Existing queue, renamed in navigation (URL kept stable) |
| Inbox | `/inbox` | Three-pane messaging workspace |
| Programs | `/programs` | Programs Studio + AI Program Copilot |
| Billing | `/billing` | Global billing dashboard + mock POS checkout |
| Reports | `/reports` | Report catalog with filters + mock exports |
| Integrations | `/integrations` | Connections · Automations · Webhooks · Sync Log |
| Team | `/team` | Roles & permissions |
| Settings | `/settings` | Hub; sub-pages below |

Settings sub-pages:

- `/settings/data` — data boundaries: Imports (wizard) · storage posture.
- `/settings/governance` — Security & Governance: AI governance registry
  (`?tab=ai`) · Audit log (`?tab=audit`). Removed from primary navigation,
  **not** deleted.

Kept alive outside primary navigation:

- `/templates` — contextual, versioned template library (notes, protocols,
  care plans, messages, assessments, program lessons, emails, invoices,
  automation recipes). Reached from composers, Care Plan, Programs,
  Automations — not from the sidebar.
- `/patients/[patientId]/encounter/[encounterId]` — encounter workspace
  (EMR + scribe + lens), unchanged.

## Route consolidation (redirects — no dead links)

Static redirects (`next.config.ts`):

| Old | New |
|---|---|
| `/practice` | `/today` |
| `/clients` | `/patients` |
| `/messages` | `/inbox` |
| `/automations` | `/integrations?tab=automations` |
| `/imports` | `/settings/data?tab=imports` |
| `/ai-safety` | `/settings/governance?tab=ai` |
| `/audit-log` | `/settings/governance?tab=audit` |
| `/claims` | `/billing?tab=claims` |
| `/assessments` | `/templates?type=assessment` |

Mode-aware redirects (server pages, because the destination depends on
mock vs live):

| Old | New (mock) | New (live) |
|---|---|---|
| `/` | `/today` | `/today` |
| `/wearables` | default patient → `tracking?view=wearables` | `/patients` |
| `/quantum-mind` | default patient → `tracking?view=mind` | `/patients` |
| `/nutrition` | default patient → `care-plan?view=nutrition` | `/patients` |

## Patient-local navigation (one tab system)

`/patients/[patientId]/[tab]` — nine tabs, everything patient-scoped lives
here and nowhere else:

| Tab | Route segment | Contents |
|---|---|---|
| Overview | `overview` | Profile: bookings, upcoming visits, no-shows, time since last visit, balance, demographics, contacts, medical alerts, next appointment, communications, forms, concise clinical/reasoning highlights |
| Chart & Timeline | `chart` | Filterable longitudinal record: encounters, signed notes, addenda, forms, communications, lab events, prescriptions/supplements, protocol changes, wearable alerts, payments. Live mode renders the real EMR timeline (0021) unchanged |
| Labs & Reasoning | `labs` | `?view=results` (default) · `?view=orders` · `?view=reasoning` — labs workspace, lab orders, extraction review, trends, provenance, hypotheses, evidence, missing info, safety considerations, differential questions |
| Care Plan | `care-plan` | `?view=plan` (default: protocols) · `?view=supplements` (dispensary) · `?view=nutrition` (Passio-adapter mock: photo/barcode/voice/search/label/manual entries, corrections, targets, macro/micro trends, meal plans, adherence, protocol linkage) |
| Tracking & Experiments | `tracking` | `?view=twin` (longitudinal systems model) · `?view=experiments` (N-of-1) · `?view=wearables` · `?view=mind` (Mind & Cognition — mood, sleep, stress, cognition, neurocognitive scores, interventions, trends) · `?view=assessments` (assigned forms, validated questionnaires, scored outcomes, longitudinal comparisons) |
| Appointments | `appointments` | Booking history + upcoming, links to calendar |
| Messages | `messages` | Patient-scoped conversation view; full workspace at `/inbox` |
| Billing | `billing` | Patient ledger: invoices, payments, balance, card-on-file status, checkout entry |
| Files | `files` | Documents (lab PDFs, uploads, generated reports) |

Legacy patient tab aliases (server-side redirects in the tab router):

| Old tab | New location |
|---|---|
| `summary` | `overview` |
| `timeline` | `chart` |
| `labs` | `labs` (unchanged) |
| `lab-orders` | `labs?view=orders` |
| `reasoning` | `labs?view=reasoning` |
| `protocols` | `care-plan` |
| `supplements` | `care-plan?view=supplements` |
| `twin` | `tracking?view=twin` |
| `nof1-lab` | `tracking?view=experiments` |
| `reports` | `files` |

## Naming changes

- **Clients → Patients** everywhere in UI copy.
- **Quantum Mind → Mind & Cognition**, integrated into Tracking &
  Experiments. No quantum or diagnostic claims.
- **Tasks → Review Queue** as a navigation label (URL `/tasks` kept).
- **Health Twin** becomes the longitudinal systems model inside Tracking —
  not another overview.

## Mode split (unchanged rules)

- Mock/demo mode (default build): everything renders from
  `src/adapters/*.mock.ts` + per-session stores (`sessionStorage`). Session
  actions update dependent screens; every mutation is labeled
  `(demo — not persisted)` or equivalent. No PHI, no real sends, no real
  uploads, no real payments.
- Live mode (`NEXT_PUBLIC_USE_LIVE_API=true`): the live namespaces
  (patients, labs, tasks/queue, schedule, EMR timeline, encounters, scribe,
  lens, audit) keep their existing wiring. Mock-only surfaces state
  honestly that they are demo-only and are hidden or reduced in live mode
  rather than pretending.
- Nutrition is built behind a **typed Passio adapter boundary**
  (`src/adapters/nutrition.mock.ts` implementing the `NutritionAdapter`
  type). No Passio key exists anywhere in client code; the live adapter is
  a future server-side integration.

## Biohacker mode (navigation variant, not entitlements)

`practitioner` (default) and `biohacker` are navigation variants of the
same shell: Biohacker mode collapses practice operations (Patients →
self, no Team/Claims, Billing → subscriptions only) and centers Tracking &
Experiments. This phase ships the variant definition and a preview switch
in Settings; billing entitlements are explicitly out of scope.
