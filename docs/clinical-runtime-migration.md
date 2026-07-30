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
append-only progress. Phase 4 made the inbox real: org-scoped conversation
threads with a database-enforced workflow, immutable messages with versioned
drafts, a durable outbox whose sending FAILS CLOSED without a delivery
provider, communication preferences and consent gates, a deterministic
urgent-language invariant, and AI triage that is stored separately and acts
only on explicit human acceptance.

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
| **Inbox, messaging & AI triage (Phase 4)** | `/inbox` (3-pane workspace), chart Messages tab, `/today` inbox card | `inbox.live.ts` → `InboxWorkspace`, `PatientMessagesLive`, `TodayInboxLive`; `messaging-provider.ts` (contract only) | `conversations` (extended), `messages` (extended), `message_draft_revisions`, `message_attachments`, `communication_preferences`, `message_outbox`, `message_delivery_events`, `conversation_events`, `message_ai_reviews`; 16 caller RPCs (`list_inbox`, `get_conversation`, `create_conversation`, `save_message_draft`, `cancel_message_draft`, `send_message`, `mark_conversation_read`, `update_conversation_workflow`, `create_task_from_message`, `append_message_to_note`, `set_communication_preferences`, `register_message_attachment`, `review_ai_suggestion`, `get_patient_messages`, `get_inbox_today_summary`) + 3 service_role-only worker RPCs (`record_inbound_message`, `record_delivery_callback`, `record_ai_suggestion`) | atomic; thread lifecycle, send refusals, AI decisions each audited; PHI-safe (message bodies never in audit rows or logs) | desktop_owned_inbox.sql (61) |
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

The Today page now shows THREE real aggregations: today's appointments with
their real statuses, the Programs summary, and the Inbox summary (open
threads, unread inbound, urgent flags, due follow-ups, my assignments — all
counts of persisted rows). Notes awaiting signature, wearable alerts, and
balances are named as not configured on that page — no count is shown for a
domain with no live backend.

Within the now-real inbox, two boundaries stay honestly unavailable by
design: **message delivery** (no provider is configured — `send_message`
refuses durably and nothing is marked sent/delivered without a provider
acknowledgment recorded via `record_delivery_callback`) and the **AI inbox
copilot** (`api.inbox.copilotAI` fails closed as not configured; suggestions
can only enter through the service_role `record_ai_suggestion` boundary and
only act when a human accepts them).

| Domain | Route | First real mutation when built | Needs |
| --- | --- | --- | --- |
| Message delivery (ALP in-app/email/SMS/push) | `/inbox` composer | provider-acknowledged send | `MessagingProvider` implementation + `messaging` connector registration + outbox worker |
| AI inbox copilot | `/inbox` AI panel | recorded suggestion | governed AI config + worker calling `record_ai_suggestion` |
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

Phase 4 found the ledger ending at `20260730171151` and appended:

| Version | Name | What |
| --- | --- | --- |
| `20260730182450` | desktop_owned_inbox | extends `conversations` (10 categories, priority, assignment, queues, follow-up/snooze, urgent invariant fields, `version`; status `open/snoozed/resolved`, legacy `closed`→`resolved`) and `messages` (8-state machine, channel, `version`, delivery timestamps, PHI-safe failure reason, provenance); new tables `message_draft_revisions`, `message_attachments` (opaque `storage_ref`, provider `none`/`supabase_storage`, no URLs), `communication_preferences`, `message_outbox` (unique idempotency key, unique `(message_id, channel)`), `message_delivery_events` (unique `(provider, provider_event_id)` — callback dedup), `conversation_events` (append-only), `message_ai_reviews` (immutable content, versioned prompt/model/schema/provider + output hash); `private.detect_urgent_language` (IMMUTABLE, fixed dictionary); immutability triggers (sent/inbound bodies frozen, DELETE blocked, events and AI content unmutable); legacy policies dropped, patient-access-scoped SELECT RLS, ALL direct writes revoked, every FK indexed |
| `20260730183610` | desktop_inbox_rpcs | 5 private helpers (`can_handle_inbox`, `messaging_provider_configured`, `inbox_thread_guard`, `log_conversation_event`, `apply_urgent_invariant`) + 14 caller RPCs + `review_ai_suggestion` + 3 service_role-only worker-boundary RPCs |
| `20260730183800` | desktop_inbox_task_type_fix | `create_task_from_message` writes lawful `review_queue_items` values (`patient_message`/`open`) |
| `20260730184141` | desktop_inbox_draft_insert_fix | draft insert matches the real `messages` shape (authorship is `sender_user_id`) |
| `20260730184914` | desktop_inbox_note_provenance_message | `note_provenance_refs.ref_type` check widened to include `message` |
| `20260730185240` | desktop_inbox_send_refusal_outcome | `review_ai_suggestion` revoked from anon; `send_message` provider refusal became a durable RETURNED outcome (`{ok:false, sent:false, refusal:'provider_not_configured'}`, draft kept, `send_refused` event persists) instead of an exception that rolled its own trail back |

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

**Advisor posture after phase 4 DDL.** Zero ERROR-level findings on phase-4
objects. The new security WARNs are the same generic gated-definer lint, one
per new RPC — the deliberate architecture, with every gate proven by the
61-check acceptance suite (including the explicit anon/public execution-denied
checks). Phase 4 introduced NO unindexed-FK, RLS-init-plan, or
multiple-permissive-policy findings on the nine inbox tables; the only
advisor entries naming them are `unused_index` INFOs, expected on a schema
with no production traffic yet.

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

### Phase 4 state machines and boundaries

**Thread status machine** (authoritative in Postgres —
`update_conversation_workflow`; the workspace only mirrors it):

```
open ↔ snoozed        (snoozing REQUIRES a wake time)
open | snoozed → resolved → open   (reopen is lawful; resolved is otherwise terminal)
```

**Message status machine** (trigger + RPC enforced):

```
draft → queued → sent → delivered      (each ← provider evidence ONLY)
draft → cancelled | superseded
queued → failed (PHI-safe reason)
inbound → (terminal; read_at is the only mutable field)
```

- Drafts are the ONLY editable message state: versioned
  (`message_draft_revisions`), optimistic (`40001` on a stale
  `_expected_version`), author-only (the sender is ALWAYS `auth.uid()` —
  no RPC takes a sender parameter, so identity cannot be spoofed). Once a
  message leaves `draft`, its body is frozen by trigger and DELETE is blocked
  — corrections are new messages.
- **Sending fails closed.** `send_message` validates consent and preferences
  (do-not-contact, declined outbound, per-channel consent — each a typed
  `22023` refusal), applies the urgent invariant, then requires a registered
  `messaging` connector. None exists: the refusal is a durable RETURNED
  outcome — draft kept, `send_refused` event persisted, NOTHING marked
  queued/sent/delivered. With a provider, send only ever reaches `queued`
  plus a `message_outbox` row (unique idempotency key; replays return
  `alreadyApplied`); `sent`/`delivered` are set exclusively by
  `record_delivery_callback` (service_role), which dedupes on
  `(provider, provider_event_id)`, only moves the projection forward,
  re-queues retryable failures with backoff state, and records terminal
  failures with a PHI-safe reason. **No code path in this repository can
  claim delivery without provider acknowledgment.**
- **Deterministic urgent invariant.** `private.detect_urgent_language` is an
  IMMUTABLE function over a FIXED dictionary ("chest pain", "can't breathe",
  "suicid", "overdose", "call 911", …). It runs on inbound recording, thread
  creation, and send; a match elevates visibility (`urgent_flag` +
  matched terms + an event) and the workspace renders an always-visible panel
  suggesting immediate human review — explicitly NOT a diagnosis and NOT a
  confirmed emergency, and entirely independent of AI availability.
- **AI triage separation.** AI output lives ONLY in `message_ai_reviews`
  (immutable content; versioned provider/model/prompt/schema + output hash),
  written ONLY by the service_role `record_ai_suggestion` boundary. A
  suggestion has zero effect until a human calls `review_ai_suggestion` with
  an explicit accept — acceptance applies through the SAME guarded workflow
  RPCs (category/priority/routing) or into the CALLER'S OWN draft
  (draft_response: never sent, never AI-attributed as sender). AI cannot
  send, resolve, refill, diagnose, order, prescribe, sign, schedule, charge,
  or suppress the urgent panel — those code paths do not exist. Patient
  message content is treated as untrusted input everywhere (adversarial
  prompt-injection tests at unit and browser level).
- **Human workflow.** Assignment, practitioner/staff queues, priority,
  category, snooze, follow-up, and resolution are optimistic-versioned RPC
  actions with append-only `conversation_events` history. "Create task"
  writes a REAL `review_queue_items` row (idempotent per message); "add to
  note" quotes the message into an UNSIGNED draft on a real encounter via the
  existing `save_note_draft` path (practitioner-gated via
  `require_clinical_actor`, idempotent, never signs).
- **Attachments** are provider-neutral METADATA plus an opaque
  `storage_ref` — no bytes in the database, no payloads in logs, and no
  guessable URLs (with `storage_provider = 'none'` the UI says
  "metadata only — storage not configured").
- **Permission matrix.** Every read/write: authenticated (`28000` if not) →
  active org membership (`private.can_handle_inbox`, `42501`) → patient
  access (`private.can_access_patient`, `42501`) → tenant agreement (thread,
  message, encounter, and patient org ids must all match) → role gates
  (clinical actor for note writes; draft author for draft edit/cancel/send).
  anon/public execution is revoked on every inbox function; all direct table
  writes are revoked — the browser can only go through the RPCs.
- **ALP delivery contract.** `src/adapters/messaging-provider.ts` defines the
  typed `MessagingProvider` interface (durable-outbox semantics above) and
  `live-types.ts` defines the versioned DTOs
  (`AlpMessagingThreadV1`/`MessageV1`/`DeliveryReceiptV1`/`ReadReceiptV1`).
  Contract ONLY: `resolveMessagingProvider()` returns null, there is no
  provider registry and no environment variable that can enable a fixture
  provider (unit-proven), and nothing in this repository calls AI Longevity
  Pro or transmits these shapes anywhere.
- **Deployment requirements** (unchanged pattern): `APP_EDITION=clinical`,
  `CLINICAL_SUPABASE_URL`/`CLINICAL_SUPABASE_ANON_KEY`, signed-in
  practitioner session. Wiring real delivery is a reviewed code change
  (implement `MessagingProvider`) PLUS a database-side `messaging` connector
  registration PLUS a worker for outbox claiming and callbacks — no
  configuration flag can shortcut it.

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

## Phase 5 recommendation

**The AI Longevity Pro messaging bridge (delivery slice).** Phase 4 built the
entire durable half of messaging — outbox, idempotency, callback dedup,
receipt DTOs, the typed `MessagingProvider` contract — and left exactly one
honest hole: no message can actually reach a patient. The highest-value next
step is the first real delivery integration: implement `MessagingProvider`
for ALP in-app messaging, register the `messaging` connector row, and build
the worker that claims `message_outbox` rows and reports through
`record_delivery_callback` / `record_inbound_message` — at which point sent/
delivered/read become provider-evidenced states with zero desktop changes.
That work lives partly outside this repository (the ALP side), so if a
desktop-only phase is preferred instead: **billing & payments persistence**
(invoices as rows with an honest not-configured payment boundary, mirroring
how messaging held delivery) or **reports** (access-scoped aggregates over
the now-substantial real domains). The AI inbox copilot should follow only
after a governed AI provider decision, feeding `record_ai_suggestion` — the
human-review gate is already live.
