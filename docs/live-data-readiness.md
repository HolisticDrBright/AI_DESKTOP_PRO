# Live-data readiness map

Per-domain guide for replacing mock/session data with the real backend. The
architecture every domain follows is already proven by the labs vertical slice
(see [`live-api.md`](live-api.md)): UI → `api.<domain>.*` façade → (live mode)
route handler / server component → Desktop-owned Supabase REST/RPC boundary
under RLS. Transitional worker/coordinator domains still use the legacy tRPC
service until they move in their own tested slice. SECURITY DEFINER RPCs remain
the atomic, authorized write path.

Shared assumptions for every domain:

- **Auth:** practitioner signs in at `/login` against the clinical project
  (ADR 0002); the token lives in httpOnly cookies and the backend runs RLS as
  that user (see [`live-auth-and-seeding.md`](live-auth-and-seeding.md)). The
  env fallback (`CLINICAL_DEMO_EMAIL/PASSWORD`) is local/e2e-only — never set
  it in a real deployment.
- **RLS:** org membership via `organization_memberships`; patient access via
  `private.can_access_patient` (assignment or org-admin); writes via
  `private.can_write_patient_data` (practitioner/admin role + access).
- **Audit:** clinical mutations call RPCs that append to `audit_events`
  server-side (actor stamped from `auth.uid()`, PHI-safe metadata).
- **Errors:** normalized `AdapterError` codes; clinician-safe messages; shared
  `ClinicalStates` loading/empty/error.

Status legend: ✅ live path exists · 🟢 ready to wire (schema + pattern exist) ·
🟡 needs backend/schema work first · ⚪ placeholder by design.

---

## Patients — ✅ live path exists
- **Route / screen:** patient layout + header, `/clients`
- **Adapter:** `api.patients.list/get` (live behind flag) · `summary` (mock)
- **Mock source:** `patients.mock.ts` · **Session state:** none
- **Live tables:** `patient_profiles` (+ `practitioner_patient_relationships`)
- **Audit:** none for reads; `access_events` later for chart-open tracking
- **Missing fields:** avatar/goals/care-team/visit dates have no columns —
  presentation defaults; `summary` synthesizes scores (no DB source yet)
- **First live mutation:** patient demographics edit → `UPDATE patient_profiles`
  (role-gated) + audit event

## Labs — ✅ live path exists (the proven slice, now incl. PDF ingestion)
- **Route:** `/patients/:id/labs` · **Adapter:** `api.labs.*`
- **Mock:** `labs.mock.ts` · **Session:** `lab:<pid>:<mid>` review outcomes
- **Live tables:** `biomarker_observations`, `biomarker_definitions`,
  `lab_panels`, `lab_documents`; RPCs `review_biomarker` (atomic review+audit)
  and `ingest_lab_extraction` / `mark_lab_document_failed` (migration `0016`)
- **Desktop boundary:** `list_patient_lab_observations` SECURITY INVOKER read,
  RLS-scoped patient/document selects, and direct `review_biomarker` /
  `create_review_task` calls with the practitioner JWT. Missing confidence stays
  unknown; ambiguous source flags are never assigned a direction.
- **Ingestion:** Upload lab (live) → `lab-documents` storage bucket
  (path-scoped storage RLS) → backend deterministic extraction (alias-anchored
  parser, no AI) → observations with verbatim originals + per-marker
  confidence → low-confidence rows open a review-queue item → audit
- **Missing fields:** optimal ranges need `biomarker_optimal_ranges`
  (practice-scoped) — lab reference interval is never replaced; image-only
  (scanned) PDFs are not extracted yet (stored + honest `failed` status)
- **Transitional piece:** PDF upload/download still use the worker-backed
  endpoint because Storage, extraction, and deletion are coordinated jobs.

## Tasks / Review queue — ✅ live path exists
- **Route:** `/tasks` · **Adapter:** `api.tasks.getQueue` (live behind flag) +
  `actions.execute("resolve")` with a `liveRef` → real mutation
- **Mock:** `tasks.mock.ts` · **Session:** `queue:<id>` outcomes + session-added items
- **Live tables:** `review_queue_items`; RPC `resolve_review_queue_item`
  (migration `0014`, atomic status+audit, idempotent) + `create_review_task`
- **Desktop boundary:** `list_review_queue` SECURITY INVOKER read plus direct
  `resolve_review_queue_item`; selected organization and patient RLS both apply.
- **Reload persistence:** the row's settled status maps into the UI
  (`settledOutcome`), so resolve survives reload without sessionStorage
- **Missing fields:** non-caller assignee display names and structured source
  links still need a governed directory/source join.

## Calendar / Scheduling — ✅ live path exists
- **Route:** `/calendar` · **Adapter:** `api.schedule.getWeek/book/updateStatus`
  (live-only; the demo calendar renders the weekday-pattern mock directly)
- **Live tables:** `appointments` (types/status vocab + patient-NULL breaks
  org-visible via migration `0017`); RPCs `book_appointment` (double-booking
  rejected for practitioner AND patient) / `update_appointment_status`
  (transition rules, terminal idempotent) / `reschedule_appointment` — all
  audited atomically
- **Live UI:** real week fetch per anchor, record statuses (never derived from
  the clock), booking drawer (patient/practitioner/type/time), check-in /
  complete / cancel (confirm + audit)
- **Deferred (documented, not faked):** patient-facing online booking page,
  reminders (email/SMS provider decision), external calendar sync,
  drag-to-reschedule UI (RPC already exists)

## Clinical Reasoning — 🟡 needs backend shaping
- **Route:** `/patients/:id/reasoning` (+ summary snapshot card)
- **Adapter:** `api.reasoning.getWorkspace` · **Session:** `hypothesis:*`/snapshot keys
- **Live tables:** migration 0006 (`reasoning_snapshots`, `hypotheses`,
  `hypothesis_evidence`) — reads map cleanly; generation stays server-side AI
- **Audit:** accept/reject hypothesis → audit RPC
- **First live mutation:** hypothesis accept/reject → status column + audit
  (same shape as `review_biomarker`)

## Composer / Notes / Reports — 🟡 needs generation endpoint
- **Adapter:** `api.composer.generate` (mock templates)
- **Live:** notes → `clinical_notes` (0004); generation is a server-side AI
  endpoint with the same draft/review/sign gates; **drafts are never final**
- **First live mutation:** save reviewed note → `INSERT clinical_notes` + audit

## Audit Log — ✅ dual-mode
- **Route:** `/audit-log` — demo (sessionStorage) vs live (`list_audit_events`
  RPC: own events, all if org-admin)
- **Missing:** pagination + filters when volume grows

## Supplements — 🟢 reads ready · 🟡 stack writes
- **Route:** `/patients/:id/supplements` (+ Inventory/Dispense sub-tabs)
- **Adapter:** `api.supplements.getWorkspace`, `api.inventory.*`
- **Session:** stack outcomes; inventory adjustments; sales; custom products
- **Live tables:** 0007 (`supplement_products`, ingredients, interactions,
  contraindications) for intelligence; `products_services` +
  `invoices`/`invoice_line_items`/`payments` for dispensing — **stock
  quantities need a new `inventory_items` table** (qty on hand, cost, reorder)
- **First live mutation:** record sale → invoice + line items + stock decrement
  (transactional RPC) + audit

## Health Twin — 🟡
- **Adapter:** `api.healthTwin.getMap` · 0006 twin tables exist; snapshot
  replay needs a versioned-state design. Keep mock until reasoning is live.

## N-of-1 — 🟡
- **Adapter:** `api.experiments.*` · 0008 `experiments` tables exist.
- **First live mutation:** launch experiment (practitioner-approved) → insert +
  audit; analysis stays mock until wearable ingestion exists.

## Programs — 🟡
- **Adapter:** `api.programs.listTemplates` · 0009 tables exist.
- **First live mutation:** publish template → insert + audit (review-gated).

## Imports — 🟡 biggest backend lift
- **Adapter:** `api.imports.plan` · needs upload + parse/OCR pipeline server-side;
  `source`/`source_record_id` provenance columns already exist on clinical
  tables; commits land as `review_queue_items`, never directly into charts.
- **First live mutation:** commit staged batch → queue items + audit.

## Integrations — ⚪ placeholder by design
- Connector health is display-only until real connectors exist (`connector_accounts`
  in 0011 when they do).

## Settings / permissions — 🟢 status panel live-aware
- Data-source panel reads real env presence; `/team` matrix is intended policy
  (DB enforces via RLS) — wire to `organization_memberships` roles read when
  admin screens arrive. Appearance/scale stays local (`localStorage`).

---

## Recommended wiring order

1. ~~Tasks/Review queue and labs read/review~~ — ✅ Desktop-owned boundary
2. **Audit reads/writes** — move the remaining `clinical.actions.*` transport
   while retaining the server-owned event registry
3. Scheduling/calendar — move existing RLS/RPC contracts off transitional tRPC
4. Reasoning reads + accept/reject mutation (same liveRef pattern via ActionBar)
5. Composer save-note (with sign-off gates)
6. Dispensary sale → invoices (+ inventory table migration)
7. Programs / N-of-1 / Twin / Imports as their pipelines land
