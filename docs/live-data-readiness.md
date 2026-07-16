# Live-data readiness map

Per-domain guide for replacing mock/session data with the real backend. The
architecture every domain follows is already proven by the labs vertical slice
(see [`live-api.md`](live-api.md)): UI → `api.<domain>.*` façade → (live mode)
route handler / server component → tRPC backend → clinical Supabase under RLS,
with SECURITY DEFINER RPCs (migration `0013`) as the append-only write path.

Shared assumptions for every domain:

- **Auth:** practitioner signs in against the clinical project (ADR 0002); the
  backend runs RLS as that user. Until login ships, the server-side demo
  session (`CLINICAL_DEMO_EMAIL/PASSWORD`) stands in — server-only, never in
  the browser.
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

## Labs — ✅ live path exists (the proven slice)
- **Route:** `/patients/:id/labs` · **Adapter:** `api.labs.*`
- **Mock:** `labs.mock.ts` · **Session:** `lab:<pid>:<mid>` review outcomes
- **Live tables:** `biomarker_observations`, `biomarker_definitions`,
  `lab_panels`, `lab_documents`; RPC `review_biomarker` (atomic review+audit)
- **Missing fields:** trend series need a per-marker history query; optimal
  ranges need `biomarker_optimal_ranges` (practice-scoped) — lab reference
  interval is never replaced
- **First live mutation:** already defined — `review_biomarker` (backend
  procedure `clinical.labs.reviewMarker` is the remaining hop)

## Tasks / Review queue — 🟢 ready to wire
- **Route:** `/tasks` · **Adapter:** `api.tasks.getQueue`
- **Mock:** `tasks.mock.ts` · **Session:** `queue:<id>` outcomes + session-added items
- **Live tables:** `review_queue_items` (item_type/priority/status enums match);
  RPC `create_review_task` already deployed + verified
- **Audit:** resolve/assign/snooze → `record_audit_event`
- **Missing fields:** `due` date + `assignee` display need columns/joins
  (`assigned_to` exists); saved-view counts computed client-side
- **First live mutation:** resolve queue item → `UPDATE review_queue_items.status`
  ('resolved') + audit — mirrors the demo exactly

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

1. **Tasks/Review queue** (next slice — everything funnels here; RPC deployed)
2. Labs backend procedures (`clinical.labs.*` in the tRPC repo) → full labs live
3. Reasoning reads + accept/reject mutation
4. Composer save-note (with sign-off gates)
5. Dispensary sale → invoices (+ inventory table migration)
6. Programs / N-of-1 / Twin / Imports as their pipelines land
