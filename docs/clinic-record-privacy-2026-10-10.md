# Clinic-record privacy: copies, corrections and practitioner fulfilment — October 10, 2026

Source engineering on `claude/clinic-record-privacy-20261010` (Desktop) and
`claude/v2-clinic-record-privacy-20261010` (V2), started from the exact heads
`13b38d33f63aaa4d41ab1e02616e70ee2307c234` and
`15301ee8eba3b79ca6d0a62d8a595d483a8538d5`. A patient asks a connected clinic
for an authorized copy of the records it holds, follows the clinic's decision,
reads the prepared copy, and asks for a correction of a signed note; a
practitioner reviews, fulfils or refuses, and accepts a correction only as an
append-only addendum. Nothing here is deployed, registered, activated or
PHI-enabled; no AWS write, secret, provider call or paid build happened. No
retention duration, deletion guarantee or disclosure approval is invented.

## Decisions visible in the design

- **A separate clinic-data workflow.** The owner's personal-storage export and
  its exclusion of `clinic_records_and_messages` are untouched. Whether clinic
  text later joins the personal export is the owner's decision.
- **Authority is derived, never supplied.** The server resolves the actor from
  the verified identity (`clinical_private.care_connection_actor`), the patient
  and clinic from the canonical `patient_connections` row, and the
  practitioner's authority from `require_clinical_patient`. No patient id,
  clinic id or connection id is accepted from a client for a submission.
- **Active sharing and retained-record authority are different.** A NEW request
  needs a live, verified connection. Reading a request one owns, and the copy
  prepared for it, needs the immutable owner, the organization and an active
  production-bound identity — not the connection still being verified. A link
  that is paused, revoked or replaced never moves an old copy to a new owner.
- **Disclosure fails closed.** Fulfilling a copy requires a live, reviewed
  release in `clinical_private.clinic_disclosure_releases` covering every
  included section. The artifact seeds none; until the owner's review registers
  one, every fulfilment is refused with `clinic_disclosure_release_required`
  (shown on both screens as a decided state, never an outage). Tests use
  clearly fictional releases only.
- **A copy is a snapshot taken at fulfilment**, bounded per item, read by
  keyset under the download fresh-sign-in window. Its manifest names every
  included section, every exclusion with its reason, every record counted but
  not disclosed (drafts, unsigned notes, notes entered in error, unreviewed or
  flagged or rejected observations), and states `completeClinicRecord: false`
  with the list of what is not included (chart drafts, correspondence, provider
  copies, backups, identity and billing). Oversize projections are kept as a
  digest and counted as omitted, never dropped silently.
- **Section registry** (`clinical_private.clinic_record_sections`): signed notes
  with addenda, telehealth visit records through their chart-transfer receipts
  (the signed visit record, chart lineage, never the chart draft, the admission
  or signing material), and accepted lab observations with provenance have
  readers; correspondence is named as readable through the existing care-message
  export; programs/protocols and intake/check-ins are named as having no
  production reader.
- **Correction ≠ amendment ≠ dispute.** A correction targets one signed note
  revision this owner was actually shown (a revision in a fulfilled copy to this
  owner). Acceptance is `add_note_addendum` (attributed, reasoned, referencing
  the signed version); the signed content, signature and revision never change.
  A decline records the disagreement beside the record. The existing
  personal-storage dispute and the synthetic clinic dispute are untouched.
- **Replay, never duplication.** The client chooses the request id and the
  practitioner's decision id. The same bytes again return the recorded row
  (`alreadyApplied`); the same id with other bytes is a conflict; a decision on
  a stale revision or a settled request is a conflict; two decisions in either
  order converge on one outcome. One open request per (connection, kind):
  a newer copy request supersedes the open one only by naming it.
- **Deletion is not here.** A request to delete clinic-held material remains
  the reviewed disposition workflow (privacy operations, store
  `clinic_records`). Holds, Zoom copies and backups are untouched and never
  certified deleted.

## Contracts

| Contract | Where |
| --- | --- |
| `clinic-record-requests/1` (consumer and workforce actions, response binding) | `src/contracts/clinicRecordRequests.ts`, mirrored in `expo/contracts/clinicRecordRequests.ts` |
| `clinic-record-copy/1` (manifest) | same files; produced by `clinical_private.clinic_record_build_copy` |
| `clinic-record-journal/1` (V2 encrypted pending-command journal) | `expo/lib/clinicRecords/clinicRecordJournal.ts` |
| `clinic-records-source-candidate/1` (bundled handler + SQL + manifest) | `scripts/build-clinic-records-source-candidate.mjs` |
| `clinic-record-privacy-candidate/1` (114-migration artifact) | `scripts/clinic-record-privacy-candidate.mjs` |
| `clinic-records-qualification-binding/1`, `clinic-records-qualification-report/1`, `clinic-records-qualification-cases/1` (Codex's synthetic hosted qualification: target binding, mandatory cases, report check) | `scripts/clinic-records-qualification-report.mjs` |

Consumer actions: `overview`, `submit_copy`, `submit_correction`, `get`,
`withdraw`, `read_copy`. Workforce actions: `queue`, `review`, `begin_review`,
`fulfill`, `refuse`, `amend`, `decline`. Routes (proposed, unregistered):
`POST /clinical-core/consumer/clinic-records` (consumer JWT, purpose
`consent_management`, sign-in within 15 minutes; `read_copy` within 5) and
`POST /clinical-core/workforce/clinic-records` (workforce JWT, purpose
`clinical_data`, sign-in within 15 minutes).

## The forward candidate (114)

`infra/aws-clinical-core/production-candidates/clinic-record-privacy.sql` →
`20261010210000_production_clinic_record_privacy.sql`, built by
`npm run build:clinic-record-privacy-candidate` on the EXACT 113
telehealth-chart-lifecycle/3 candidate (parent pins: count 113, ledger
`0abad35b…`, assembly `2cb4ca8c…`; this file's SHA-256 is pinned). It alters no
historical migration, seeds nothing (no request, copy, release), and is not an
instruction to apply. If Codex's `/4` chart candidate (`20261010190000`)
replaces 113, the parent pin must be re-pointed and the file renumbered above it.

The number 114 is this file's position above the pinned parent, not a reserved
release slot: Codex's `zoom-host-authority-candidate/1` also proposes a 114 on a
different parent, and Codex owns the release mapping. The candidate is declared
by source name, exact parent ledger/assembly and SQL hash; renumbering changes
the file name and position only, never the bytes.

It adds: `clinical_core.clinic_record_requests` (state machine, revision CAS,
immutable identity), `clinic_record_request_events` (append-only, decision ids
unique), `clinic_record_copies` and `clinic_record_copy_items` (append-only
snapshot, items ≤ 48 KiB each), `clinical_private.clinic_disclosure_releases`
(retire-only, no API-role access, empty), the section registry and
`clinical_core.clinic_record_request(jsonb)` (the only function executable by
`clinical_core_api`). Audit actions `clinic_record.*` are added with the
`events_action_check` list restated in full. All ledgers: RLS forced, no
API-role table access.

Release follow-ups for Codex: register 114 after the chart successor is
settled; coverage entries for the four `clinical_core` tables (organization and
patient columns; append-only) and the custody entry for the release table;
register the two routes; deploy the handler (`createProductionClinicRecordsApi`
with `disclosureReviewSha256`, `retentionReviewSha256`, `mfaReviewSha256`
reviews, activation blocked, PHI off); classify the new refusal words in the
hosted rejection mapping (`rds-data-database.ts` already does).

## The qualification contract for Codex

`npm run print:clinic-records-qualification-cases` prints
`clinic-records-qualification-cases/1`: the target (account `588966314750`,
`us-east-2`, `clinical_core_qualification`, 114 rows at this candidate's ledger),
the two routes, the seven fictional subjects (two same-clinic patients, a
revoked link, an other-clinic patient, a practitioner, a member without a
clinical role, an other-clinic practitioner), the four reviews (disclosure,
retention, workforce MFA, qualification) and the 30 mandatory cases in
execution order. Each case names the pool, subject, action, exact HTTP status
and decided error word, the response fields the runner must copy, and the facts
it must establish by its own read-only database readback (no record text in a
review, no copy row before a release, the original note unchanged after an
addendum, item digests verified, no admission or signing material, no rows for
the other clinic, the API role without table access). Seventeen cases run with
no disclosure release at all; thirteen run after the owner-reviewed operator
inserts the plainly fictional release named in the binding (`fictional-…`,
review hash equal to the disclosure review) on the qualification database only.

`evaluateClinicRecordsQualificationReport(report, binding, candidate)` refuses a
binding on the wrong candidate, ledger or routes, shared pools, duplicate
subjects, zero review hashes or a non-fictional release; and a report with a
missing, duplicated, unknown, skipped, unobserved, out-of-order, wrong-subject,
wrong-phase or mismatched case, or any attestation absent or false. Its only
verdict is `mandatory_cases_matched` with `acceptance: false`,
`humanReviewsVerified: false`, `phiAllowed: false`: hosted concurrency, device
journeys, the owner's reviews and PHI stay outside it. The runner that
executes the cases against the deployed routes, and the CloudFormation
template that registers them, are not in this branch (see the handoff).

## Surfaces

- **Desktop**: `src/app/inbox` → `ClinicRecordRequestsPanel` / `View`
  (queue, review with counts never text, mark in review, prepare the copy under
  the release with every requested section included or excluded with a reason,
  refuse with written words, accept a correction as an addendum, decline with
  written words; decision ids replayed on retry; patient text cleared on lost
  authorization and on backgrounding) through `/api/live/clinic-records` →
  `clinicRecordsWorkforceCall` → the workforce route.
- **V2**: Privacy Center → "Open Clinic Data Center" → `app/clinic-data-center`
  → `ClinicDataCenterCard` (the one connected clinic; explicit section choice;
  request list with the clinic's decision in plain words; details with the
  event history; the copy manifest as a dated snapshot with exclusions; pages
  opened on demand and verified against the clinic's digest; a correction
  offered only from a disclosed signed note; withdrawal under the current
  revision; pending/uncertain state with "Check with the clinic" and an explicit
  "Send the same request again"). Opened text is cleared on background,
  sign-in change, clinic change, unmount and erasure; a late page never
  reopens a closed view. The legacy copy/correction actions on the Privacy
  Center card are superseded; the deletion-review request stays.
- **V2 device copies**: the journal `clinic-record-v1:<env>:<owner>` is in the
  owner-scoped inventory (`clinic_record_request_recovery`), so it exports and
  erases with the rest; it holds the request id, sections or the correction's
  subject and words — never clinic text, a copy, a token or a credential.

## Verification (local, synthetic, fictional identities only)

| Check | Result |
| --- | --- |
| `npm run test:clinic-record-privacy-candidate` | 19 pass (byte-exact parent, refusal matrix) |
| `clinic-record-privacy.database.test.ts` (PGlite, real 114 artifact, `clinical_core_api` role, through the production adapters) | 6 pass: fail-closed without a release then fulfilment under a fictional partial release with an honest manifest; telehealth records without admission material, keyset paging with byte budget, digest cross-check against the device's canonical form; retained copy after pause/revoke/replacement and never to a new owner; two clinics, two same-clinic patients, roles and pools; decisions in both orders, replay, stale revision, withdrawal, supersession, append-only ledgers; corrections only against a disclosed revision, addendum appended, original unchanged, decline recorded |
| `production-clinic-records-api.test.ts` | 8 pass (off by default, fixture admission per pool, review gates, claim substitution, fresh sign-in windows, body bounds, decided code mapping) |
| `rds-data-database.test.ts` | the eight new refusal words classified |
| `npm run test:clinic-records-qualification-report` | 35 pass (case list shape, complete fictional report never accepted, 32 refusals, `--cases` output) |
| `ClinicRecordRequestsView.render.test.ts` | 4 pass |
| `e2e/live-clinic-records-ui.spec.ts` | see the handoff for the run result |
| V2 `clinic-records-client`, `clinic-records-journal`, `clinic-data-center-screen` (mounted), `clinic-records-device-inventory` | 16 pass |
| V2 full suite, typecheck, lint, hipaa-baseline, surface-disclosure, v2-capabilities | see the handoff |

Embedded Postgres runs one transaction at a time: race orders are proven as
both serial orders plus row locks and the partial unique index, not as a true
interleaving. Hosted concurrency, both-pool hosted negatives and physical
device journeys are Codex's qualification.

## Open decisions (not made in code)

- Registering a clinic disclosure release (which sections a clinic may disclose
  through this path): `clinical_private.clinic_disclosure_releases` rows,
  reviewed by the owner; none exist.
- Retention posture of fulfilled copies: no expiry or access window is invented;
  the copy stays readable by its owner. An access window, if wanted, is a
  reviewed decision.
- Whether `flagged` observations are disclosable (this path discloses only
  `accepted`; caregiver reads elsewhere include `flagged`).
- Whether clinic-authored text later joins the owner's personal export.
- Correspondence stays with the care-message export rather than this copy.
