# Phase 2 — EMR charting slice 1

The first real charting workflow, end to end:

**appointment → start encounter → draft note → autosave → practitioner
review → sign → locked note → addendum → patient timeline → audit**

## Data model (migration 0021)

Evolves the empty 0004 placeholder tables in place — no parallel concepts:

| Table | Role |
|---|---|
| `encounters` | + `appointment_id`, `status_reason`; state machine `scheduled → in_progress → completed/cancelled/entered_in_error` (`planned` remapped; `ended_at` = completion time) |
| `encounter_participants` | author/supervisor/observer/scribe per encounter |
| `clinical_notes` | + `status` (`draft → ready_for_review → signed → amended / entered_in_error`), `current_version`; `note_type ∈ soap/narrative/follow_up/adime/patient_instructions`; encounter + author now required |
| `clinical_note_versions` | append-only content versions (jsonb sections + SHA-256, autosave/manual) |
| `note_signatures` | one per note; freezes `(version, content_sha256)`; append-only |
| `note_addenda` | append-only corrections: author, reason, timestamp, referenced version |
| `note_provenance_refs` | section → appointment/encounter/lab observation/source document/patient form/chart item/**practitioner-entered** |

## Integrity enforced in the database

- Writes only via SECURITY DEFINER RPCs (`start_encounter`,
  `set_encounter_status`, `save_note_draft`, `mark_note_ready`, `sign_note`,
  `add_note_addendum`, `mark_note_error`, `get_patient_timeline`); the legacy
  browser-write policies are dropped — direct inserts/updates are refused.
- **A signed note cannot change**: the RPCs refuse edits, and a table trigger
  refuses new content versions once signed — binding even for definer code.
  Signatures and addenda rows are append-only at the trigger level.
- **Signing is idempotent**: re-signing the same version returns the existing
  signature — no second signature row, no second audit row. A different
  version is a `40001` conflict.
- **Optimistic concurrency**: every save carries `expected_version`; stale
  saves fail with `40001` → tRPC `CONFLICT` → desktop `conflict` (409) and
  the composer's side-by-side resolution view.
- **Tenant agreement**: appointment ↔ encounter ↔ patient ↔ organization must
  agree; `require_clinical_actor` demands an active practitioner/admin/owner
  membership AND `can_access_patient`, and re-checks patient ∈ organization.
- Corrections never delete: `entered_in_error` keeps rows; addenda never
  replace the original (verified by content-hash comparison).
- Every mutation writes its audit row in the same transaction
  (`encounter.started/completed/cancelled/entered_in_error`,
  `note.draft_created/ready_for_review/signed/addendum_created/entered_in_error`).

## Surfaces

- **Encounter workspace** `/patients/:id/encounter/:encounterId` — header
  (visit type, truthful state, started time, appointment link), explicit
  Complete / Cancel (reason) / Entered-in-error (reason) actions, notes rail,
  composer. Live mode only; demo shows an honest explanation.
- **Composer** — SOAP / narrative / follow-up / ADIME / patient-instructions
  (the latter labeled as a patient-facing draft that signing does NOT
  publish). Autosave (1.5 s debounce) + explicit save; **"Saved …" appears
  only after the backend confirms**; refresh recovers the authoritative
  draft; unsaved-change warning; conflict view with "use server version" /
  "keep my edits"; ready-for-review; sign with explicit confirmation
  ("Sign and lock"); signed read-only view with signature line; append-only
  addendum form; print view; derived missing-information list; provenance
  panel where practitioner-entered content is labeled as such.
- **Patient timeline** (`/patients/:id/timeline`, live) — clinical events
  only (encounters, notes, signatures, addenda, appointments), linking into
  the workspace; the security audit trail stays in `/audit-log`.
- **Calendar** — "Open encounter" on patient appointments (idempotent start).

## Verification

- **DB (real project, rolled back): `supabase/tests/emr_encounters.sql` —
  28/28** — state machines, 40001 conflicts, signed-note immutability incl.
  the any-role trigger test, idempotent signing (single signature + single
  audit), addendum preservation via content hash, staff-role refusal,
  dual-org/cross-tenant attacks, outsider RLS zero-visibility, direct-write
  refusal, clinical-only timeline. Migration 0021 applied.
- **Backend:** `clinical.encounters.*` / `clinical.notes.*` procedures with
  exact-RPC-argument vitest coverage incl. 40001→CONFLICT translation —
  16 new tests, full suite 283/283, backend tsc clean.
- **Desktop:** gated live e2e **18/18**, including the full acceptance
  workflow (appointment → encounter → autosaved SOAP → reload recovery →
  ready → sign+confirm → locked editor with original text intact →
  append-only addendum → timeline events → exactly one `Note signed` audit
  row → out-of-org user refused). Mock suite 14/14; unit 7/7; both builds.

## Honest boundaries

- No AI note generation in this slice — manual authoring only, by design.
- Transcript/scribe provenance types don't exist yet (no fake citations);
  `patient_form`/`chart_item` refs are selectable labels whose target
  records arrive in later slices.
- Deployed-environment run: NOT RUN (see `docs/deployment-verification.md`).
