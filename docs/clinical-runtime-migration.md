# Clinical runtime migration

The living inventory of every surface in the clinical product: what is real,
what refuses honestly, and what each domain needs to go live. Updated with
every phase. Phase 1 made the runtime clinical-only and shipped the first real
vertical slice. Phase 2 made front-desk scheduling a database-enforced state
machine and shipped versioned protocol + template persistence with a real
product-catalog picker and a deterministic-or-honest interaction review.
Phase 3 made Programs & Education real: org-owned programs with versioned
curricula (modules → lessons → typed blocks), a review → approve → publish
lifecycle with immutable published versions, offers that store commercial
terms only, and enrollments pinned to exact published versions with
append-only progress.

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
| Scheduling (read week, book, reschedule) | `/calendar` | `schedule.live.ts` | `get_desktop_calendar` (+`version`), `book_appointment`, `reschedule_appointment` | atomic | desktop_scheduling.sql |
| **Front-desk status machine (Phase 2)** | `/calendar` drawer, `/today` | `frontdesk.live.ts` → `CalendarView` drawer, `TodayScheduleLive` | `transition_appointment`, `correct_appointment_status`, `appointment_status_events`, `private.appointment_transition_allowed`; `start_encounter` extended to transition the linked appointment | atomic; corrections separately audited with reason | desktop_frontdesk_transitions.sql (29) |
| **Protocols + templates (Phase 2)** | `/patients/[id]/protocol` | `protocols.live.ts` → `ProtocolWorkspace` | `protocols`, `protocol_templates`, `protocol_versions`, `protocol_phases`, `protocol_items`; `get_patient_protocol`, `create_protocol_draft`, `save_protocol_draft`, `approve_protocol_version`, `activate_protocol_version`, `set_protocol_lifecycle`, `revise_protocol_version`, `list/create/approve/archive` template RPCs | atomic; approval/activation/lifecycle each audited | desktop_owned_protocols.sql (36) |
| **Protocol catalog + interaction review (Phase 2)** | protocol tab product picker | `protocols.live.ts` | `search_protocol_catalog`, `check_protocol_interactions`, `review_protocol_item_interactions`, `private.catalog_verification_status` over the 0007 supplement catalog | review action audited | desktop_protocol_catalog_interactions.sql (37) |
| **Programs & Education (Phase 3)** | `/programs`, `/programs/[id]`, chart overview card, `/today` summary | `programs.live.ts` → `ProgramsWorkspace`, `ProgramStudio`, `PatientProgramsLive`, `TodayProgramsLive` | `programs`, `program_templates`, `program_versions`, `program_modules`, `program_lessons`, `program_blocks`, `program_offers`, `program_enrollments`, `program_progress`, `program_version_events`, `program_enrollment_events`; 20 RPCs (`list_programs`, `get_program_studio`, `list_program_templates`, `get_patient_programs`, `create_program`, `save_program_draft`, `submit/return/approve/publish/revise_program_version`, `archive_program`, `create/approve/archive` template RPCs, `upsert_program_offer`, `enroll_patient_in_program`, `set_program_enrollment_status`, `record_program_progress`, `review_program_progress`) | atomic; creation/lifecycle/offer/enrollment/progress each audited, PHI-safe (payloads never in audit rows) | desktop_owned_programs_phase3.sql (71) |
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

The Today page now shows TWO real aggregations: today's appointments with
their real statuses, and the Programs summary (published programs + enrollment
counts summed from persisted enrollment rows). Unread messages, notes awaiting
signature, wearable alerts, and balances are named as not configured on that
page — no count is shown for a domain with no live backend.

| Domain | Route | First real mutation when built | Needs |
| --- | --- | --- | --- |
| Inbox messaging | `/inbox`, chart Messages tab | send secure message | schema + comms integration |
| Billing & payments | `/billing`, chart Billing tab | create invoice | external integration (payments) |
| Inventory writes / dispensary | Settings → Catalog | receive stock | schema ready (`products_services`) |
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

Phase 2 found the ledger ending at `20260730034530` and appended:

| Version | Name | What |
| --- | --- | --- |
| `20260730042846` | desktop_frontdesk_transitions | `in_encounter` status, `appointments.version`, `appointment_status_events`, transition/correction RPCs, `start_encounter` extension |
| `20260730042928` | desktop_frontdesk_calendar_version | `get_desktop_calendar` byte-identical + `version` in the appointment projection |
| `20260730043030` | desktop_owned_protocols | protocol/template/version/phase/item tables, RLS, immutability triggers, FK covering indexes |
| `20260730043300` | desktop_protocol_rpcs | the 11 protocol + template RPCs |
| `20260730045821` | desktop_protocol_catalog_interactions | catalog picker, derived verification, deterministic interaction check, practitioner review RPC |
| `20260730050009` | desktop_protocol_draft_verification | `save_protocol_draft` replaced: verification derived server-side, catalog identity from the catalog, version-must-belong-to-product |
| `20260730052613` | desktop_protocol_draft_item_ids | `save_protocol_draft` returns `itemIds` (payload order) so reviews can target persisted rows |

Phase 3 found the ledger ending at `20260730052613` and appended:

| Version | Name | What |
| --- | --- | --- |
| `20260730155911` | desktop_owned_programs | extends the 0009 program skeleton: versioned program/template curricula, offers, pinned enrollments, append-only progress + events, frozen-content triggers, single-policy RLS with all direct writes revoked, unique `(program_id, version)` / `(template_id, version)` |
| `20260730161830` | desktop_program_rpcs | 4 private helpers + the 20 program RPCs |
| `20260730171151` | desktop_program_fk_indexes | covering indexes for every remaining unindexed FK on the Desktop-owned program tables |

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

**Advisor posture after phase 2 DDL.** Zero ERROR-level findings on phase-2
objects. The 16 new security WARNs are the same generic gated-definer lint as
above, one per new RPC — the deliberate architecture, with every gate proven
by the three acceptance suites. Phase 2 introduced NO new unindexed-FK
findings (covering indexes shipped with the tables); the unindexed-FK INFOs
matching "protocol" in the advisor output all sit on the pre-existing 0007
`supplement_protocols` / `supplement_protocol_items` / `protocol_effectiveness`
tables, which this phase does not touch. New unused-index INFOs on the phase-2
tables are expected on a schema with no production traffic yet.

**Advisor posture after phase 3 DDL.** Zero ERROR-level findings on phase-3
objects. The 20 new security WARNs are the same generic gated-definer lint as
above, one per new RPC — the deliberate architecture, with every gate proven
by the 71-check acceptance suite. Phase 3 left NO unindexed foreign keys on
the eleven Desktop-owned program tables (`desktop_program_fk_indexes` covers
the keys that predated this phase but now sit on hot query/RLS paths), and no
multiple-permissive or RLS-init-plan warnings exist on phase-3 tables (the
remaining "program" matches sit on the legacy `program_steps` /
`program_tasks` / `program_conditions` tables, untouched and without
production callers). New unused-index INFOs on phase-3 tables are expected on
a schema with no production traffic yet.

### Phase 2 state machines and immutability rules

**Appointment status machine** (authoritative in Postgres —
`private.appointment_transition_allowed`; the drawer only mirrors it):

```
scheduled  → confirmed | arrived | cancelled | no_show
confirmed  → arrived | cancelled | no_show
arrived    → in_encounter | completed | cancelled | no_show
in_encounter → completed | cancelled
completed / cancelled / no_show → (terminal)
```

- Terminal statuses have NO outgoing transitions. The only way out is
  `correct_appointment_status` — org admin only, reason required, audited as
  `appointment.status_corrected`.
- Every transition takes an optimistic `_expected_version` (SQLSTATE `40001`
  on mismatch) and an optional `_idempotency_key`; a replay returns the stored
  outcome (`already_applied: true`) instead of transitioning twice, enforced
  by a unique partial index on `appointment_status_events`.
- Rescheduling is a separate RPC — moving a visit in time is not a status
  change.
- `start_encounter` transitions the linked appointment to `in_encounter`
  itself (accepting scheduled/confirmed/arrived) so there is exactly one code
  path, not two.

**Protocol version lifecycle** (append-only; trigger-enforced):

```
draft → approved → active → superseded
protocol lifecycle: draft/active → paused ↔ active → completed | discontinued
```

- Only drafts are editable (`save_protocol_draft`, 40001 on a stale
  `_expected_updated_at`; returns `itemIds` so the client can address the rows
  it just wrote). Approved and active versions are immutable — RPC-level AND
  via `private.guard_frozen_protocol_version` / `guard_frozen_version_content`
  triggers that also block direct SQL. Corrections go through
  `revise_protocol_version`, which copies into a NEW draft; supersede never
  deletes.
- Approval freezes; activation is a separate, separately-audited action. The
  acceptance suite proves activation creates no note, invoice, message, or
  order row. Nothing sends patient instructions, places an order, charges,
  modifies medications, or writes into a note as a protocol side effect.
- Templates are org-owned and versioned; a protocol draft from an APPROVED
  template version is a fully detached copy (fresh ids), so customizing one
  never touches the other; archiving a template never touches protocols
  created from it.
- Product items pin exact catalog identity (`catalog_product_id`,
  `catalog_product_version_id`); when a label version is pinned the stored
  manufacturer + label version are the CATALOG's values, and
  `verification_status` is DERIVED by `private.catalog_verification_status` —
  the autosave payload's field is ignored (hole closed in `20260730050009`).
- `affiliate_url` is commercial metadata only (column comment says so); it
  never establishes eligibility, evidence, dosage, or safety.
- Interaction checks are deterministic and narrow: they run only when the
  product version has structured ingredient rows AND the patient has coded
  (RxNorm) medications; otherwise the item reads "Interaction review not
  completed" with the reason. A completed check reports what the checked
  sources contain — never that a product is interaction-free. Practitioner
  sign-off is its own audited action, drafts only.

### Phase 3 state machines and boundaries

**Program version lifecycle** (append-only; trigger-enforced):

```
draft → in_review → approved → published → superseded
   ↑         │
   └─ return ┘        (in_review can return to draft with a reviewer note)
```

- Drafts and in-review versions are editable via `save_program_draft` — a
  WHOLESALE replace with per-kind block validation (text body; http(s) URL for
  image/video/document/resource; 1–20 quiz questions with 2–8 options and an
  in-range answer index; check-in prompt + response type) and `40001` on a
  stale `_expected_updated_at`. Approved, published, and superseded versions
  are immutable — RPC-level AND via `private.guard_frozen_program_version` /
  `guard_frozen_program_content` triggers that also block direct SQL (DELETE
  is blocked for every version row).
- Approval freezes and explicitly does NOT publish. Publishing is a separate,
  separately-confirmed RPC that supersedes the previously published version
  WITHOUT touching enrollments pinned to it, and creates **no enrollment,
  charge, invoice, message, protocol, order, task, or note** (proven by the
  acceptance suite). Corrections go through `revise_program_version` (advisory
  lock, refuses while a draft exists, detached copy).
- Templates are org-owned and versioned; copies in BOTH directions (template →
  program, program → template) are fully detached with fresh ids. Archiving a
  template never cascades into programs created from it; archiving a program
  preserves its published history and enrollments and only refuses new
  enrollments.

**Enrollment machine** (server-enforced):

```
invited → active | cancelled
active  → paused | completed | cancelled | expired
paused  → active | cancelled | expired
completed / cancelled / expired → (terminal)
```

- Enrollment pins `program_version_id` to the exact published version at
  enrollment time; later publishes never move it. Progress rows must belong
  to the PINNED version (lesson/block checked server-side), only on active
  enrollments, append-only (trigger), with practitioner review as the only
  permitted update. Audit rows carry identifiers and kind — never payloads.

**Commerce boundary.** `program_offers` stores terms only (`price_cents`,
currency, duration, `payment_mode`). This application never processes a
payment: a `stripe`-mode offer is stored intent that the UI renders as
"Not configured" and `enroll_patient_in_program` refuses with an honest
message. A `manual_comp` enrollment requires a reason; the authorizer is the
authenticated caller recorded server-side with an audit event.

**AI boundary.** `api.programs.builderAI` is the provider-neutral Program
Builder AI contract; with no approved provider it fails closed as
not configured, and no fixture AI output exists anywhere. The versioned
`ProgramDeliveryV1` DTO (in `live-types.ts`) defines the FUTURE AI Longevity
Pro handoff shape only — nothing in this repository calls AI Longevity Pro,
transmits the DTO, or claims content reached the patient app.

## Deprecations

- `NEXT_PUBLIC_USE_LIVE_API` — constant `true`; not consulted anywhere.
  Remove the remaining imports opportunistically; delete the export when none
  remain.
- `api.calendar.getSchedule`, `api.patients.summary` — refusing aliases kept
  one phase so stale callers fail loudly; delete in phase 3.
- `api.schedule.updateStatus` (`update_appointment_status`) — now a thin
  delegate over `transition_appointment` with no version/idempotency
  protection. New code must call `api.schedule.transition`; delete the
  delegate once the last caller migrates.

## Phase 4 recommendation

**Inbox messaging.** With scheduling, protocols, and programs real, secure
messaging is now the highest-value target: it unlocks the biggest remaining
honest-unavailable surface (Today's unread count, the chart Messages tab,
`/inbox`) and program/protocol work keeps generating reasons to message
patients. It needs new schema (conversations, messages, read receipts,
practitioner/patient participants under RLS) and a delivery-channel decision,
so scope the first slice to INTERNAL persistence + read/unread honesty and
keep external notification delivery behind an honest not-configured boundary,
exactly as payments and AI are handled today. Alternative smaller bites:
reports (access-scoped aggregates) or the team role matrix (read UI over the
existing membership RPCs).
