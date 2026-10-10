# Telehealth chart integration and record lifecycle — October 10, 2026

Source engineering on `claude/telehealth-chart-lifecycle-20261010`, started
from the PR 87 head `6fb7f56a95917bb8535dad7b2aae0d7fe16767a4`. It connects a
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
| `clinical_core.transfer_telehealth_note` | chart (forward candidate 113) | `require_clinical_patient`; the appointment row must carry this organization and this patient and be telehealth; destination = the appointment's open encounter, else its latest completed one, else a new telehealth encounter; `save_note_draft` creates version 1 of a `narrative` **draft**; one transfer per (organization, appointment) under an advisory lock — same source returns the original destination (`created:false`), another source raises `telehealth_transfer_source_changed`; a reused transfer id is refused; the ledger row (`telehealth_note_transfers`) is append-only and audited (`telehealth.note_transferred`). |
| `POST …/visits/notes/transfer/complete` (and inspect) | telehealth Lambda | reads the chart's receipt back through `get_telehealth_record_authority` with the caller's JWT and records it; nothing the caller supplies beyond the appointment id is trusted. No receipt at the chart → the admission stands; a receipt for another source or attempt → `transfer_mismatch` (review, never a second write). |

The desktop server (`telehealthLive.transferToChart`) runs admit → chart RPC →
complete; a lost response anywhere is settled by calling it again or by
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

## The forward candidate (113)

`infra/aws-clinical-core/production-candidates/telehealth-chart-lifecycle.sql`
→ `20261010110000_production_telehealth_chart_lifecycle.sql`, built by
`npm run build:telehealth-chart-lifecycle-candidate` on top of the EXACT 112
telehealth-consent-copy candidate (parent pins in
`scripts/telehealth-chart-lifecycle-candidate.mjs`: count 112, ledger
`45aec436…`, assembly `6cc19135…`; this file's SHA-256 is pinned and a changed
byte refuses). It alters no historical migration, touches no 112 artifact
byte, seeds nothing, and is not an instruction to apply.

It adds: `clinical_core.telehealth_note_transfers` (append-only, RLS forced,
no API-role table access), provenance `ref_type` `telehealth_visit`, audit
action `telehealth.note_transferred` (both constraint lists restated in full),
`get_telehealth_record_authority(uuid,uuid,uuid)` and
`transfer_telehealth_note(uuid,uuid,uuid,uuid,integer,text,jsonb,jsonb,jsonb)`,
executable by `clinical_core_api` only.

Release mapping to coordinate with Codex: the migration number
(`20261010110000`) and the 113 position are proposed, not registered; the
distinct successor must get its own exact release mapping (no count-based
widening of 105/106/111/112 registrars); `clinical_core.telehealth_note_transfers`
must be added to `covered-entity-coverage.json` as an append-only
organization-column table when the candidate joins a release (the coverage
gate scans the 106 release only, so the entry is not added here); the
preserving 112→113 operator, rollback rehearsal and durable custody are
Codex's.

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
  `telehealth-requests/7`. IAM unchanged.
- Production pilot policy (`PRODUCTION_PILOT_DESKTOP_RPCS`) does not include
  these RPCs, as it includes no chart RPC; the pilot refuses them until that
  scope decision is made.

## Verification (local, synthetic, fictional identities only)

| Check | Result |
| --- | --- |
| `npm run test:telehealth-chart-lifecycle-candidate` | 18 pass (byte-exact parent, refusals) |
| `src/server/clinical-core/telehealth-chart-lifecycle.database.test.ts` (PGlite, real 113 artifact, actual `clinical_core_api` role) | 10 pass: draft creation, encounter reuse, timeline, retry in both orders, stale/changed source, tenant/patient/role/appointment binding, malformed input, append-only ledger, chart signature and addendum, retained authority after calendar removal/move/reassignment, refusals (foreign clinic, staff, wrong patient, consumer, suspended/removed membership, archived patient) |
| `aws-telehealth-requests.test.ts` | 94 pass (retained reads, lists withhold, transfer admit/complete/stale/mismatch/lost response, sign under retained authority, inventory, withdrawal, no deletion route, consumer refused) |
| `src/contracts/telehealthRecordInventory.test.ts` | 4 pass |
| `e2e/live-telehealth.spec.ts` under the dev server and contract fixture | 7 pass, including the transfer case: explicit action, lost completion reconciled by Inspect, one draft on the encounter, chart link, timeline entry, keyboard activation |
| Gates | stub-reset, provider configuration, compatibility contract (223), operation inventory (228), typecheck, lint |

Embedded Postgres cannot run two transactions concurrently, so the transfer
race is proven as both orders plus the advisory lock in the SQL, not as a true
interleaving. Hosted concurrent races remain Codex's.

## What remains, and for whom

- **Codex (AWS):** register the 113 successor mapping and coverage entry;
  preserving upgrade with rollback and custody; deploy the telehealth Lambda
  with the three routes; hosted negatives (direct AWS reads with revoked
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
