# Telehealth chart integration and record lifecycle — October 10, 2026

Source engineering on `claude/telehealth-chart-lifecycle-20261010`, started
from the PR 87 head `6fb7f56a95917bb8535dad7b2aae0d7fe16767a4`; the Codex
audit of its first commit (`638b145`, handoff `aa08cb4`) reproduced three gaps
that the second commit repairs — see "The audit repairs" below. It connects a
signed telehealth visit record to the clinical chart, gives completed visits a
reviewed read authority that does not depend on the calendar, and brings every
piece of telehealth text under a stated lifecycle control. Nothing here is
deployed, applied, activated or PHI-enabled; no AWS write, migration
application, secret, Zoom call or paid build happened.

## What was built

### 1. Chart integration (an explicit, bound, retry-safe transfer)

A practitioner places a **signed** telehealth visit record into the chart as an
**unsigned draft** on the patient's telehealth encounter. The visit signature
never becomes a chart signature; the chart's own review/sign/addendum workflow
applies to the draft; approved action items arrive as text, never as orders.

The two stores are never written atomically. The chart is the authority:

| Step | Where | Binding |
| --- | --- | --- |
| `POST …/visits/notes/transfer` (admit) | telehealth Lambda | completed visit, signed note, retained-record authority, the EXACT source the caller reviewed (`sourceRevision` + `sourceDigest`, both from the record) — a stale screen is refused (`transfer_source_stale`). Idempotent: a completed receipt is returned; a receipt the chart already holds is recorded; an admitted attempt is returned with the SAME transfer id. Only then is an admission written under the version. Returns the canonical content, the complete source payload and provenance. |
| `clinical_core.transfer_telehealth_note` | chart (forward candidate 113) | `require_clinical_patient`; a valid **admission** (below) whose every binding is recomputed over the bytes received; the appointment row must carry this organization and this patient and be telehealth; destination = the appointment's open encounter, else its latest completed one, else a new telehealth encounter; `save_note_draft` creates version 1 of a `narrative` **draft**; one transfer per (organization, appointment) under an advisory lock — same source returns the original destination (`created:false`), another source raises `telehealth_transfer_source_changed`; a reused transfer id is refused; the ledger row (`telehealth_note_transfers`) is append-only and audited (`telehealth.note_transferred`). |
| `POST …/visits/notes/transfer/complete` (and inspect) | telehealth Lambda | reads the chart's receipt back through `get_telehealth_record_authority` with the caller's JWT and records it; nothing the caller supplies beyond the appointment id is trusted. No receipt at the chart → the admission stands; a receipt for another source or attempt → `transfer_mismatch` (review, never a second write). |

The desktop server (`telehealthLive.transferToChart`) runs admit → chart RPC →
complete, carrying the exact bytes and the admission the boundary returned,
unchanged; a lost response anywhere is settled by calling it again or by
Inspect, which only reads. The note screen shows the chart's actual state:
"Not in the chart yet", "Transfer not confirmed" (Inspect/Retry), "Receipt not
yet recorded on the visit" (the chart confirms the draft; Inspect records it),
or the receipt with a link to the encounter draft. Text is cleared on lost
authorization as before.

Content: the chart's narrative note type is one `text` section, so the draft is
assembled under headings (reviewed AI sections, practitioner notes, action-item
decisions, a source line). The reviewed sections, practitioner text, action
items, consent summary and the COMPLETE provider summary (`aiOriginal`) are kept
as distinct data in the ledger's `source_payload`. Provenance names the visit
(`telehealth_visit` refs) for every AI-derived part.

### 2. Retained-record authority (historical reads)

Reads of a **completed** visit (`ended`/`cancelled`) — the note read, the
inventory, signing the record, and each list entry — now use
`get_telehealth_record_authority`: the clinical core's own patient-record
authority (`require_clinical_patient`: active membership, a clinical role, an
active patient record in THIS organization), evaluated with the caller's JWT.
It does not depend on the calendar still returning the appointment, so a
deleted or moved appointment never erases access to a retained record; it is
stricter than the calendar (a staff-only role is refused); a visit with no
patient record has no subject and is refused; any answer short of
`authorized` for this patient is a refusal — there is no fallback to
organization membership. Scheduled and running visits keep the current
appointment binding for reads; start, consent, end and import are unchanged.

Lists: a visit the caller may not read is **withheld** and counted
(`withheld`, `complete:false`); a refusal of the caller (revoked membership)
refuses the whole list.

### 3. Record lifecycle (inventory, never deletion authority)

`src/contracts/telehealthRecordInventory.ts` enumerates every telehealth text
location across the visit record, the chart, Zoom's copies and backups, and
states for each what export, amendment, retention, hold and erasure can
truthfully do today. `GET …/visits/notes/inventory` returns one visit's
inventory — presence, digest, size and counts, never the text — under the
same authority as the record, with the chart's legal hold and the consent
state. Consent withdrawal is reported as "new AI processing stopped, nothing
deleted". The response lists what no receipt from this system may claim:
deletion of the visit record (no deletion route exists), of chart records
(append-only), of Zoom's copies (no delete permission), of backups, or any
retention duration (no approved policy exists).

Owner correction vs clinician amendment: no owner-facing write reaches a
visit (consumer identities are refused on every visit route); a clinician
amends through `add_note_addendum` on the chart note, with reason, author,
time and referenced version, and the original signed text stays.

## The audit repairs (Codex A1–A3, October 10)

### A1 — source admission at the chart write boundary

The chart RPC is callable by any authenticated workforce caller through the
desktop's data-compatibility route, so the admit-first sequence in the
desktop adapter secured nothing by itself: the audit created a draft from a
fabricated "signed visit" with a syntactically valid digest. Now the chart
requires an **admission** (`telehealth-chart-admission/1`): a canonical JSON
object the telehealth boundary mints only after it has verified the completed
visit, the signed note, the exact source the caller reviewed and the caller's
retained-record authority (which resolves the practitioner's person id in the
chart). It binds `transfer_id`, `organization_id`, `patient_record_id`,
`appointment_id`, `practitioner_person_id`, `intent` (`chart_draft`),
`source_custody` (`telehealth-visit-record`) and `source_record_version`,
`source_revision`, `source_digest`, and the SHA-256 of the exact
`content`/`payload`/`provenance` bytes, with `issued_at` and a 15-minute
`expires_at`; it is signed with HMAC-SHA256 under `key_id`. The key lives in
Secrets Manager (`CHART_ADMISSION_SECRET_ARN`, read per request, never
cached, logged or returned) and in `clinical_private.telehealth_admission_keys`
(no API-role access; a key is only ever retired, which revokes every admission
under it). The browser never holds it. `transfer_telehealth_note` takes the
content, payload, provenance and admission as **text**, recomputes every hash
over the bytes it received, verifies the signature and every binding against
its own arguments and the actor it resolved, checks the window (not expired,
not issued in the future, at most one hour) against a database clock read
AFTER authority resolution and the lock wait, re-reads the clock at the
mutation point after destination resolution and refuses there too if the
admission has meanwhile expired (Codex B1: the first repair compared expiry
to a clock captured at function entry, so an admission that expired while the
call was blocked could still create the draft), and only then proceeds under
the existing appointment binding and one-per-appointment lock. Refusals:
`telehealth_admission_unavailable` (no key registered at all),
`telehealth_admission_refused` (unknown/retired key, bad signature),
`telehealth_admission_mismatch` (any binding differs). A retry presents the
exact admitted source (same bytes under a re-issued admission with the same
transfer id) and gets the original receipt; nothing else is replayable. The
production desktop dispatcher validates the shapes and passes the strings
through unchanged. DynamoDB admission plus the chart transaction are still not
atomic: reconciliation reads the chart's receipt as before.

Provisioning is Codex's: one random key (≥32 bytes, hex) as a Secrets Manager
secret `{ "keyId", "secret" }` for the Lambda, the same bytes inserted into
the key table with a privileged connection by the preserving operator, with
rotation = register the new key, then retire the old. The artifact seeds no
key; until one is registered every transfer is unavailable, and the boundary
without the secret refuses `transfer_unavailable` (503) with nothing written.

### A2 — receipt reads bound to the requested patient

`get_telehealth_record_authority` selects the transfer by organization,
appointment **and** the independently authorized `_patient_id`, and the note
by the same; an appointment that carries another patient is reported as
`{ id, patient_matches: false }` and nothing more (no status, practitioner or
type). The telehealth boundary and the desktop only ever adopt or display a
receipt the chart reported for the visit's own patient; the fixture mirrors
the same rule.

### A3 — the calendar correction contract

The original test swallowed the failing update; the behaviour it implied was
never real. The contract now stated and enforced: **an appointment that
carries clinical records (an encounter or a transfer) keeps its patient
identity.** No governed operation re-patients an appointment; a raw update is
refused by name (`appointment_patient_identity_immutable`, a trigger that
fires before the encounter/ledger foreign keys would). The supported
correction is `correct_appointment_status` on the original (owner/admin, with
reason, `appointment.corrected` audited) plus a successor appointment for the
right patient. The original record stays readable under the patient it was
recorded for; the successor patient sees no transfer and the original
appointment as "not this patient's"; a transfer to the successor needs its own
admitted signed source. An appointment with no clinical record is outside the
guard (nothing re-patients it either). Reschedules and deletions still never
erase access to a retained record.

## The forward candidate (113)

`infra/aws-clinical-core/production-candidates/telehealth-chart-lifecycle.sql`
→ `20261010170000_production_telehealth_chart_lifecycle.sql` (candidate
contract `telehealth-chart-lifecycle-candidate/3`; each repair is a distinct
candidate identity — the audited `20261010110000` / `…/1` and the rechecked
`20261010150000` / `…/2` were never registered), built by
`npm run build:telehealth-chart-lifecycle-candidate` on top of the EXACT 112
telehealth-consent-copy candidate (parent pins in
`scripts/telehealth-chart-lifecycle-candidate.mjs`: count 112, ledger
`45aec436…`, assembly `6cc19135…`; this file's SHA-256 is pinned and a changed
byte refuses). It alters no historical migration, touches no 112 artifact
byte, seeds nothing (no transfer, no admission key), and is not an
instruction to apply.

It adds: `clinical_core.telehealth_note_transfers` (append-only, RLS forced,
no API-role table access; carries the admission, its digest, key id and
window), `clinical_private.telehealth_admission_keys` (retire-only, no API-role
access, empty), the `appointments` patient-identity guard, provenance
`ref_type` `telehealth_visit`, audit action `telehealth.note_transferred`
(both constraint lists restated in full),
`get_telehealth_record_authority(uuid,uuid,uuid)` and
`transfer_telehealth_note(uuid,uuid,uuid,uuid,integer,text,text,text,text,text,text)`,
executable by `clinical_core_api` only.

Release mapping to coordinate with Codex: the migration number
(`20261010170000`) and the 113 position are proposed, not registered; the
distinct successor must get its own exact release mapping (no count-based
widening of 105/106/111/112 registrars); `clinical_core.telehealth_note_transfers`
must be added to `covered-entity-coverage.json` as an append-only
organization-column table when the candidate joins a release (the coverage
gate scans the 106 release only, so the entry is not added here);
`clinical_private.telehealth_admission_keys` holds no patient data and needs
the key-custody entry; the preserving 112→113 operator (including key
registration), rollback rehearsal and durable custody are Codex's.

## Compatibility and runtime wiring

- `desktop-compatibility-operations.json`: `get_telehealth_record_authority`,
  `transfer_telehealth_note` (223 RPCs); `desktop-production-operations.json`
  native entries pointing at the candidate SQL; `CORE_RPCS` and `executeCoreRpc`
  branches in `aws-production-desktop.ts` (bounded args; `boundedProvenance`
  accepts `telehealth_visit`; the source payload is bounded at 512 KiB);
  inventory pins 223/5/228 and the committed inventory rebuilt.
- Both RPCs have desktop call sites (`telehealth.live.ts`): the record read
  for completed visits and the transfer.
- The telehealth Lambda calls `get_telehealth_record_authority` through the
  data-compatibility route with the caller's JWT, as it already does for the
  calendar.
- Template `telehealth-requests-extension.json`: routes `…/notes/transfer`,
  `…/notes/transfer/complete`, `…/notes/inventory` (workforce JWT), contract
  `telehealth-requests/8`; parameter `ChartAdmissionSecretArn` (default
  empty, NoEcho) with an exact-resource `secretsmanager:GetSecretValue` policy
  only when set, and `CHART_ADMISSION_SECRET_ARN` in the function environment.
- `rds-data-database.ts` classifies the transfer refusals
  (`telehealth_admission_*`, `telehealth_transfer_*`,
  `appointment_patient_identity_immutable`, `appointment_not_found`,
  `appointment_required`) so the desktop sees a refusal, never
  `database_unavailable`.
- Production pilot policy (`PRODUCTION_PILOT_DESKTOP_RPCS`) does not include
  these RPCs, as it includes no chart RPC; the pilot refuses them until that
  scope decision is made.

## Verification (local, synthetic, fictional identities only)

| Check | Result |
| --- | --- |
| `npm run test:telehealth-chart-lifecycle-candidate` | 18 pass (byte-exact parent, refusals) |
| `src/server/clinical-core/telehealth-chart-lifecycle.database.test.ts` (PGlite, real 113 artifact, actual `clinical_core_api` role) | 20 pass: draft creation, encounter reuse, timeline, retry in both orders, stale/changed source, tenant/patient/role/appointment binding, malformed input, append-only ledger, chart signature and addendum, retained authority after reschedule/deletion, refusals (foreign clinic, staff, wrong patient, consumer, suspended/removed membership, archived patient); **A1** forged claims with no admission / self-signed / unknown or retired key / tampered signature, substituted content, payload, provenance, revision, digest, transfer id, practitioner, patient, clinic, appointment, intent, contract, custody, extra or missing member, expired / future / over-long windows, **B1** expiry during a delayed authority resolution and expiry between the admission check and a delayed destination (both fail against the previous SQL, both leave no writes), exact retry, key retirement and retire-only custody, no API-role access to the key table, no key = unavailable; **A2** same-clinic second patient sees no receipt; **A3** the correction contract end to end; and the production desktop dispatcher (`aws-production-desktop.ts` in front of the same PGlite under the API role) accepting the exact bytes and refusing missing/forged/substituted/foreign/other-practitioner attempts |
| `aws-telehealth-requests.test.ts` | 95 pass (retained reads, lists withhold, transfer admit with a verifiable admission bound to the chart-resolved practitioner, exact bytes, fresh admission on retry with the same transfer id, no secret read for completed/refused/stale paths, unprovisioned or unreadable or malformed key = 503 with nothing written, complete/mismatch/lost response, sign under retained authority, inventory, withdrawal, no deletion route, consumer refused) |
| `rds-data-database.test.ts` | the ten transfer refusal markers classified |
| `src/contracts/telehealthRecordInventory.test.ts` | 4 pass |
| `e2e/live-telehealth.spec.ts` under the dev server and contract fixture (the fixture mints and verifies admissions under a fictional key exactly as the Lambda and the SQL do) | 7 pass, including the transfer case: explicit action, lost completion reconciled by Inspect, one draft on the encounter, chart link, timeline entry, keyboard activation |
| Gates | stub-reset, provider configuration, compatibility contract (223), operation inventory (228), typecheck, lint |

Embedded Postgres cannot run two transactions concurrently, so the transfer
race is proven as both orders plus the advisory lock in the SQL, not as a true
interleaving; the expiry-during-blocking cases are proven with a controlled
dependency delay, not a real lock wait. Hosted concurrent races, a real
PostgreSQL lock-wait negative, and revoked-authority / retired-key race
behaviour remain Codex's hosted qualification.

## What remains, and for whom

- **Codex (AWS):** register the 113 successor mapping and coverage entry;
  generate the admission key, store it as the Lambda's secret and register
  it in `clinical_private.telehealth_admission_keys` through the preserving
  upgrade (rotation = register, then retire); preserving upgrade with
  rollback and custody; deploy the telehealth Lambda with the three routes
  and `ChartAdmissionSecretArn`; hosted negatives (direct AWS reads with revoked
  membership, wrong clinic, staff role), transfer races against the deployed
  boundary, and the positive two-participant Zoom visit.
- **Policy decisions (not made in code):** a reviewed retention/disposition
  policy for clinic records (`owned_retention_policies` has no rows); whether
  clinic-authored telehealth text joins the owner's personal-storage export
  (the current scope decision excludes `clinic_records_and_messages`); Zoom
  copy retention; whether the chart RPCs enter the production pilot scope.
- **Engineering still open:** the clinic-tier `care_data_export` registry
  refactor (synthetic-only) before telehealth joins a clinic export; per-clinic
  Zoom host authority; V2 consent journey; record erasure beyond a recorded
  disposition.
