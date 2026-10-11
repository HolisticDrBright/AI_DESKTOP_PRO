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
| `clinic-record-requests/2` (consumer and workforce actions, response binding; copy items as exact digested text) | `src/contracts/clinicRecordRequests.ts`, mirrored byte for byte in `expo/contracts/clinicRecordRequests.ts`; both repositories pin the hash (`scripts/clinic-records-contract-integrity.test.mjs`, `__tests__/clinic-records-contract-pins.test.ts`) |
| `clinic-record-copy/1` (manifest) | same files; produced by `clinical_private.clinic_record_build_copy` |
| `clinic-record-journal/1` (V2 encrypted pending-command journal) | `expo/lib/clinicRecords/clinicRecordJournal.ts` |
| `clinic-records-source-candidate/1` (bundled handler + SQL + manifest) | `scripts/build-clinic-records-source-candidate.mjs` |
| `clinic-record-privacy-candidate/3` (114-migration artifact; `/1` and `/2` superseded, never applied) | `scripts/clinic-record-privacy-candidate.mjs` |
| `clinic-records-deployment/1` (compiled handler, deterministic zip, CloudFormation template, manifest) | `scripts/build-aws-clinic-records.mjs`, `src/server/clinical-core/clinic-records-deployment.ts`, `clinic-records-lambda.ts` |
| `clinic-records-qualification-binding/1`, `clinic-records-qualification-report/2`, `clinic-records-qualification-cases/1` (Codex's synthetic qualification: observed target, mandatory cases, report check) | `scripts/clinic-records-qualification-report.mjs` |

Consumer actions: `overview`, `submit_copy`, `submit_correction`, `get`,
`withdraw`, `read_copy`. Workforce actions: `queue`, `review`, `begin_review`,
`fulfill`, `refuse`, `amend`, `decline`. Routes (proposed, unregistered):
`POST /clinical-core/consumer/clinic-records` (consumer JWT, purpose
`consent_management`, sign-in within 15 minutes; `read_copy` within 5) and
`POST /clinical-core/workforce/clinic-records` (workforce JWT, purpose
`clinical_data`, sign-in within 15 minutes).

## The exact-byte wire contract (recheck C2)

A copy item travels as the EXACT UTF-8 text PostgreSQL digested at fulfilment
(`payloadText`), its digest (`payloadSha256`) and its byte length
(`byteLength`). The device checks the length and the digest of the received
text before parsing it, and parses it with a number-preserving parser
(`expo/lib/clinicRecords/jsonText.ts`), so `1.20` is verified and displayed as
`1.20` and `0.0000001` never becomes `1e-7`. Nothing structured travels beside
the text; a page with one bad item (wrong digest, wrong length, substituted or
trailing text, duplicate key) is refused whole. The item table stores that text
once (`payload_text`, checked to be a JSON object of exactly `byte_length`
bytes). The fixture `src/contracts/fixtures/clinic-record-copy-lab-item.json`
is what the real reader produced in embedded PostgreSQL for a decimal
observation (1.20, reference 0.0000001–1000000.50, a 20-digit integer, Unicode);
the database test regenerates and compares it, and the V2 client test replays
it through the real transport (`AUDIT reads a valid decimal lab payload digested
by PostgreSQL jsonb`).

## The forward candidate (114, revision 3)

`infra/aws-clinical-core/production-candidates/clinic-record-privacy.sql` →
`20261011000000_production_clinic_record_privacy.sql`, built by `npm run build:clinic-record-privacy-candidate` on the
EXACT 113 telehealth-chart-lifecycle/3 candidate (parent pins: count 113, ledger
`0abad35b…`, assembly `2cb4ca8c…`). SQL SHA-256 `0752dde7fdd2396d9cd62d3a9feb80ea0cd504d6bf50d788ee95f46aa0890327`,
114 ledger `a6d5f7b8660e0f6b902738c5f1c19d25e59d108ce59b9f385ec1bf72f54f85e8`, assembly
`a743b0eb8f9661aadcca84d93912ee4a2e1b31556825b7e08d4d375b9b3de9cb`. It alters no historical migration, seeds
nothing (no request, copy, release), and is not an instruction to apply. The
first revision (`20261010210000`, `/1`, re-serializable objects) and the
second (`20261010230000`, `/2`, timestamps rendered in the session TimeZone)
are superseded by this distinct version and hash; neither was applied anywhere.
The copy builder sets `TimeZone='UTC'` on its own definition so the digested
bytes never depend on the connection's clock.
The candidate still depends on chart lifecycle `/3`: it cannot be deployed over
the selected `/4` + Zoom-host + key-fence chain by changing a count; Codex
supplies the selected parent and mapping before a combined release.

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

## The deployment candidate (source only, blocked by default)

`npm run build:aws-clinic-records` compiles `clinic-records-lambda.ts` with the
build identity (source commit, clean flag, 114 ledger, candidate SQL hash, the
dispatcher body hash) into `dist/aws-clinical-core/clinic-records/` and writes
a deterministic `deployment.zip`, a `template.json` and
`artifact-manifest.json` (`clinic-records-deployment/1`, `deploymentPerformed:
false`, `registered: false`). The template registers the two routes on an
existing API with SEPARATE JWT authorizers (consumer pool, workforce pool;
`SeparateIdentities` rule), one `AWS::PROXY` integration, exact-resource
`lambda:InvokeFunction` permissions per route, a role whose data policy exists
only under the `Enabled` condition (RDS Data API on one cluster, one secret, KMS
decrypt via Secrets Manager for that secret), a KMS-encrypted log group, two
alarms, reserved concurrency 2, and the qualification profile shared by every
candidate. Parameters `SourceCommit`, `MigrationReleaseSha256` and
`ClinicRecordsExtensionSha256` admit only this build's values. Reviews
(`DatabaseReviewSha256`, `WorkforceMfaReviewSha256`, `DisclosureReviewSha256`,
`RetentionReviewSha256`) are hash-shaped parameters with no default; the
runtime refuses to serve without all four, and no environment flag turns a
missing review into approval.

`clinic-records-deployment.ts` binds the runtime: the environment must repeat
the build's commit, ledger and SQL hash, the activation stays `blocked`, the
account, region, cluster, secret and database must match the mode (production
account for production, `588966314750` + `clinical_core_qualification` for
qualification), and a dirty build never serves. Before business SQL, every
transaction verifies under `clinical_core_api` that the deployed dispatcher is
the compiled one (body hash, security definer, empty search_path, executable
by the API role and by nobody anonymous), that the five ledgers force row
security and grant the API role nothing, and that the guard and append-only
triggers exist; otherwise 503. `clinic-records-deployment.test.ts` proves this
against the real 114 artifact.

## The hosted qualification runner (source; Codex executes)

`scripts/clinic-records-qualification-runner.mjs` executes the thirty cases
against a target through two ports: `http` (the deployed routes) and `sql`
(read-only readback as a privileged inspection principal). Every observation
in the report comes from a real response or a real readback: replay counts,
copy rows, manifest coverage, item digests, note signature rows before and
after an addendum, audit rows, API-role privileges, triggers. Tokens come from
Codex per fictional subject (`fresh`, `aged` 5–15 minutes, `stale` > 15
minutes); the runner reads only their claims, refuses a token under another
subject or outside its window, and never writes a token. The run verifies the
ledger has 114 rows and that no release exists, executes the seventeen
`before_release` cases, calls `awaitRelease` (Codex runs the owner-reviewed
operator), verifies that exactly the bound fictional release now exists, and
executes the thirteen `under_release` cases. A port failure or a window
violation ends the run with an incomplete report that the evaluator refuses.
`createHostedPorts` binds `fetch` to the qualification API origin and the RDS
Data API to the qualification cluster (positional parameters rewritten to the
Data API's named form). `clinic-records-qualification-runner.test.ts` runs the
whole thing against the REAL artifact-bound handler over the real 114 schema in
embedded PostgreSQL, with seven fictional subjects and two fictional clinics:
all thirty cases observed, the release registered between phases, verdict
`mandatory_cases_matched` with acceptance false.

CLI: `node scripts/clinic-records-qualification-runner.mjs --binding=<json>
--tokens=<json> --fixtures=<json> --target=<json> --out=<report.json>`, where
`fixtures` names the signed note text and the draft text Codex seeded for
patient A (used only to assert absence in responses) and `target` names
`apiId`, `clusterArn`, `secretArn`, `database`.

## Coverage declared honestly

The copy covers signed notes with addenda, telehealth visit records through
chart-transfer receipts, and accepted lab observations. Three clinic domains are
NOT covered by this copy, and the manifest says so under `completeClinicRecord:
false`: correspondence stays readable through the separately scoped care-message
export under the immutable thread owner (a deliberate launch exclusion, not an
owner approval); programs/protocols and intake/check-ins have no production
reader at all today. These are disclosures of incomplete coverage, not proof of
a complete clinic export. Integrating the care-message export into this copy is
possible without new authority and is left as an owner decision.

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
| `npm run test:clinic-records-contract-integrity` | 2 pass (contract and fixture hashes pinned in both repositories; text-only wire form) |
| `npm run test:clinic-records-deployment` | 5 pass (blocked by default, binding refusals, reviews, bound dispatcher check against the real artifact) |
| `npm run test:clinic-records-qualification-runner` | 4 pass (actual wrong database with matching ledger refused before dispatch; window and subject refusals; all 30 cases through the real handler and schema; release-present refusal) |
| `npm run build:aws-clinic-records` | template, zip and manifest; `deploymentPerformed: false` |
| `clinic-record-privacy.database.test.ts` (PGlite, real 114 artifact, `clinical_core_api` role, through the production adapters) | 7 pass (the seventh regenerates and compares the decimal fixture): fail-closed without a release then fulfilment under a fictional partial release with an honest manifest; telehealth records without admission material, keyset paging with byte budget, digest cross-check against the device's canonical form; retained copy after pause/revoke/replacement and never to a new owner; two clinics, two same-clinic patients, roles and pools; decisions in both orders, replay, stale revision, withdrawal, supersession, append-only ledgers; corrections only against a disclosed revision, addendum appended, original unchanged, decline recorded |
| `production-clinic-records-api.test.ts` | 8 pass (off by default, fixture admission per pool, review gates, claim substitution, fresh sign-in windows, body bounds, decided code mapping) |
| `rds-data-database.test.ts` | the eight new refusal words classified |
| `npm run test:clinic-records-qualification-report` | 42 pass (including missing/inconsistent observation and old count-only contract refusals) |
| `npm run test:clinic-records-qualification-target` | 33 pass (raw fictional AWS observations, target refusal matrix, pagination, full ledger, deployed zip, execution marker and direct hosted bypass refusal; no AWS calls) |
| `ClinicRecordRequestsView.render.test.ts` | 4 pass |
| `e2e/live-clinic-records-ui.spec.ts` | see the handoff for the run result |
| CI (`.github/workflows/ci.yml`, job "Care messaging database API…") | runs the candidate, qualification-report, contract-integrity, deployment and runner suites, both source builds and the embedded-database journeys |
| V2 `clinic-records-client`, `clinic-records-json-text`, `clinic-records-contract-pins`, `clinic-records-journal`, `clinic-data-center-screen` (mounted; includes the three AUDIT diagnostics), `clinic-records-device-inventory` | see the handoff |
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

## Source portability recheck

Both mirrored source files are pinned to LF through Git attributes. The
contract-integrity suite checks the effective attributes as well as the raw
source hashes. Clinical payloadText is not normalized or reconstructed.

The exact-byte database regression builds a new copy through candidate /3
under UTC and Pacific/Honolulu database sessions, checks each against the same
committed fixture, and verifies the builder restores the caller's time zone.
It does not merely reread an already-built copy or change the process TZ.
The candidate identity and SQL are unchanged by this regression.

Focused database, runner and single-attempt suites pass38 tests, and the three
contract-integrity checks pass. The predecessor source with the local test
repair passed6,310 tests and11 existing skips; that result is not claimed as a
full-suite run of this reconciled candidate. Exact d236b76 predecessor CI is
green. Both CI runs at the reconciled portability head e29055d are now green
(38098642531 and38098673817). The next source increment replaces the count-only
preflight as described below; its own CI and hosted evidence are separate.

## Independent qualification target guard

The runner now requires `clinic-records-hosted-target/1`, the exact local
deployment bytes, and the full ordered migration artifact. The guard checks
STS account and non-root member role, foundation and candidate stack completion,
all candidate parameters and the exact template, physical Lambda and routes,
actual Lambda zip checksum and environment, JWT authorizers and integrations,
the default stage and its successful automatic deployment, and cluster/secret
metadata. One read-only database statement returns `current_database()` and the
complete ordered ledger. A same-count but different ledger cannot pass.

These checks run before the first request, before and after the separate
release callback, and after the case list. Every HTTP observation requires the
qualification response marker. Missing metadata, incomplete pagination, an
unmarked denial or drift refuses the run; nothing is silently skipped.

`clinic-records-qualification-report/2` separates the requested binding from
the observed target. Injected source-test ports are always `embedded`; a caller
cannot promote them with a boolean. A real hosted invocation requires the CLI's
fresh build from a clean, exact checkout. Review hash syntax is not approval,
and even a complete report retains `acceptance:false` and `phiAllowed:false`.

The AWS observer uses the explicit `ai-synthetic-member` profile, fixed Ohio
endpoints, single attempts and read-only metadata commands. It never reads secret
contents. Database inspection begins a read-only transaction and rolls it back.
There is no fixture writer or release insertion in this runner; the existing
release prompt must be fulfilled by a separately reviewed, target-bound operator.

AWS observations are sequential, not an atomic snapshot. This guard does not
certify IAM permissions, concurrency, retention, provider agreements or production
activation. The managed database still requires the selected, authorized preserving
schema upgrade. The clinic candidate remains on its exact lifecycle /3 parent;
it must not be re-pointed to another 114-by-count. Actual hosted qualification,
release integration and device journeys remain outstanding.

See `docs/clinic-records-qualification-target.md` for the required target fields
and execution procedure. The fictional test fixture is not a runnable manifest.
