# Personal-storage export — bounded coverage, not account fulfillment

September 15, 2026. Original phase 3 engineering increment; PHI remains disabled.

The independent consumer service now implements POST/GET
`/clinical-core/consumer/personal/privacy-export`. It needs the existing verified
consumer identity and deployment activation. It does **not** need clinic membership
or a renewed clinical-storage consent. No deployment flag or consent release is
enabled by this change. The disabled deployment template remains logs-only.

POST accepts only an idempotency request UUID. The database derives the owner,
rechecks the active identity, and serializes snapshot creation with the same owner
lock as record/consent writes. Retrying returns the original 15-minute snapshot;
new snapshots are limited to one per minute. GET returns up to 100 versions per
page, ordered by the immutable version keys with no OFFSET. Cursors bind to the
export and section; access rechecks owner and expiry on every page. Audit events
carry identifiers/counts, not payloads. The snapshot tables are not directly
accessible to the application role. Narrow private-owner-checked definer functions
allow privacy access after consent withdrawal without widening normal clinical RLS.

Pages also stop at 24 KiB of unescaped item JSON, with a continuation cursor even
when shorter than the requested record limit. This accounts for the Data API's
[64 KiB per-row limit](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.troubleshooting.html)
because the stored function returns a single JSON field. Three 15,000-character
fictional records exercise the byte-limited path in the rollback acceptance test.

Included: every retained personal-record version (including prior versions and
tombstones) and personal-storage consent history at the snapshot cutoff. Historical
payloads are exported as retained, not discarded because the current clinical
schema has changed. Database-only owner/request/hash columns are not serialized.

**Excluded:** clinic records/messages; processing jobs and original lab documents;
chat/voice transcripts; identity/billing; device-only caches and recovery archives;
backups/security audits. These exact exclusions and `completeAccountExport:false`
are returned in the versioned manifest. No deletion/correction fulfillment or full
account-export completion is claimed.

## Executed verification

- 1,508 Desktop tests passed /11 existing skips. Typecheck, personal-storage artifact
  build and lint passed (four unrelated pre-existing lint warnings).
- Expanded rollback-only API-to-Aurora test: **61 checks passed**. Identity/role
  isolation, no clinic requirement, consent withdrawal, immutable pagination while
  new record/consent versions are written, history/tombstones, exact manifest counts,
  cross-owner refusal, no direct table access, malformed pagination, expiry, and
  retry/rate limiting exercised. Rollback verified: no retained schema or fixture
  rows. The first attempt stopped before transaction start while AWS reported the
  cluster resetting master credentials; rerun succeeded after it became available.
- This was fictional rollback-only data in the existing PHI-disabled foundation,
  **not** an activated hosted endpoint, production data export, or device share test.

Reproduce with `scripts/test-aws-owned-consumer-records.ps1 -ConfirmRollbackOnly`.
It deliberately rolls back the owned-storage prerequisite migrations and this
export migration together; do not run it as a deployment mechanism.

## Remaining acceptance and release work

V2 prepares and explicitly shares an in-memory JSON copy after validating all page
counts, ownership, scope, and expiry. It has a 5,000-version/16 MiB payload ceiling
and fails without truncation if exceeded. No clipboard/file/token enumeration or
automatic third-party transfer. Native sharing has an explicit sensitive-data
warning; destination-app retention is outside ALP. Accounts above the inline
ceiling use the export job below. Physical iOS/Android sharing, export metadata/audit
retention policy, complete multi-store export/correction/deletion, legal holds,
guardian authority, and deployment approval remain open. No artifact is marked a
completed privacy request. No real data or signed approvals were used in testing.

## Large accounts: server-packaged export job (September 20, 2026)

Migration `20260920110000_production_owned_privacy_export_jobs.sql` adds an owner-scoped
job for accounts the inline path refuses. Routes under
`/clinical-core/consumer/personal/privacy-export/job` (POST request, GET status with
`advance=true`, POST `cancel`, POST `download`) need the same verified consumer identity
and privacy purpose; they refuse with `export_delivery_not_configured` unless the
personal-storage candidate was deployed with a reviewed export bucket, KMS key and review
hash (`ExportBucketName`, `ExportKmsKeyArn`, `ExportReviewSha256`; the IAM statement for
`personal-exports/*` exists only under that condition).

- **Packaging in owner-authorized passes.** A job pins its own snapshot cut-off (kept
  readable for 48 hours). Each poll with `advance=true` leases the job, reads a bounded
  number of pages under the owner's identity, and uploads one SSE-KMS multipart part of
  the JSON document (manifest with the inline coverage statement, then `records`, then
  `consents`), or a staging object when fewer than a part's worth of rows arrived; the
  cursor and part digests are recorded before the pass returns. Work happens only while
  the owner is signed in and asking; there is no background service identity, because the
  production security model has consumer and workforce identities only. A storage failure
  records nothing for that pass and the next poll resumes; a document over 2 GiB fails the
  job. Object keys use the owner's digest, never the id.
- **Delivery.** `download` requires a sign-in within the last five minutes (token
  `auth_time`), verifies the exact ready version, its encryption and size, and returns a
  five-minute signed link with `attachment` disposition. Every issuance is audited.
- **Expiry and cleanup.** A ready copy expires 48 hours after the cut-off. Expiry is a
  committed state transition (migration 20260920130000): the owner's next status, lease or
  cleanup call, or the assigned operator's retention pass, marks a ready copy expired and an
  unfinished job failed (`deadline_passed`). The objects are removed by the owner's next
  cleanup pass or by the operator's retention pass described below; a job is recorded as
  deleted only after the store lists nothing under its key. One open job per owner; one new
  job per owner per hour. The 48-hour figure is what the code enforces; it is not a reviewed
  retention policy and the policy text is not written.
- **Evidence.** PGlite runs the production SQL with a fictional object store
  (`owned-privacy-export-jobs.database.test.ts`, 18 cases): multi-part packaging with exact
  counts against the snapshot row, download issuance and refusal, cancellation with listing
  proof, expiry, resumption after a failed pass, cross-owner refusal, the four independent
  recheck cases below unmodified, the failure matrix, and the operator retention pass. No
  bucket, hosted run, signed link or real account was used. **Local verification only**: the
  S3 store (`aws-privacy-export-store.ts`) has never been exercised against a bucket, and the
  listing calls, HEAD on SSE-KMS versions without `kms:Decrypt`, and the IAM statements are
  unverified until the hosted synthetic run.

## September 20 recheck: failure boundaries (migration 20260920130000)

An independent recheck of the job path reproduced four failures against migration
20260920110000. Its four tests were added unmodified
(`describe('Codex recheck export failure boundaries')`) and pass with the repairs below;
none of the earlier cases changed.

| Recheck finding | Repair |
|---|---|
| Cleanup reported deletion when the store denied the abort. | `cleanupPrivacyExportJobs` no longer swallows abort errors. It lists the open uploads and versions under the job's key, aborts and deletes what it finds (plus the recorded versions), then lists again and HEADs each version; the job is certified deleted only when nothing remains. A refusal, timeout or an upload still listed after an abort that returned leaves the job pending with `objectDeleted:false`. |
| An upload created before a failed first part was orphaned. | The upload id is recorded (`record_owned_privacy_export_upload`) under the same lease before any part is sent, and cleanup finds uploads by listing rather than by the recorded id, so an upload whose creation response was lost is still removed. |
| A job stuck at section `done` after the object saved but the database receipt failed. | A pass that leases a job whose parts are all recorded never sends a part. It lists the versions under the key: exactly one live version whose HEAD matches the recorded byte count and the reviewed key completes the job with that version; no version and an open upload completes the upload from the recorded parts; anything else fails the job closed (`object_missing`, `object_mismatch`, `object_ambiguous`) and cleanup removes every version. |
| Expired unfinished jobs stayed `running`. | The lease no longer raises after updating: it commits the `failed`/`deadline_passed` transition with its audit row and returns `leased:false`, which the API reports as a conflict. Status reads and both cleanup listings commit the same transition for requested, running and ready jobs. |

The store interface gained `listUploads` and `listVersions` (S3 `ListMultipartUploads` and
`ListObjectVersions`, requested with one job's key prefix). The personal-storage candidate
grants `s3:ListBucketVersions` with `s3:prefix` under `personal-exports/*`. AWS does not
support `s3:prefix` for `s3:ListBucketMultipartUploads`, so that action is a separate
bucket-level statement: the export bucket must be dedicated to personal exports, which is part
of what `ExportReviewSha256` attests. No unversioned delete.

Additional cases in the same file: denied then timed-out abort (pending twice, certified on
the third pass), abort that returns while the upload is still listed, a recorded upload that
is already gone (no abort call) and a never-started expired job (no store call at all), a
lost create-upload response followed by a part failure, a superseded staging version whose
delete failed during the pass, a lost completion response (recovered without resending a
part) followed by an ambiguous second version (failed closed, both versions removed), and two
concurrent polls (one pass, one conflict).

## Retention that does not depend on the owner (migration 20260920130000)

The assigned privacy operator's `cleanupExports` action (privacy-operations API, workspace
button "Run export retention pass") lists, oldest first and at most ten per call, the
cancelled, failed and expired export jobs of every owner the operator holds a live assignment
for, after committing deadline transitions for that owner's requested, running and ready
jobs. Closed or disabled owner accounts are included: the owner's own identity is never
needed. Each job is removed with the same listing proof as the owner's pass and certified
under the owner lock (`record_privacy_export_object_deleted_by_operator`), with the operator
recorded on the `job.failed`, `job.expired` and `object.deleted` audit rows. The response
carries counts and per-job outcomes only, never keys, owners or content.

Activation is separate: `ExportCleanupEnabled`, `ExportCleanupEvidenceSha256`,
`ExportBucketName` and `ExportKmsKeyArn` on the privacy-operations candidate. The IAM policy
under that condition allows `s3:ListBucketVersions` with the export prefix condition,
`s3:ListBucketMultipartUploads` on the dedicated export bucket (no prefix condition exists
for it), and `s3:AbortMultipartUpload` and `s3:DeleteObjectVersion` on `personal-exports/*`.
It reads no object at all: cleanup proves absence by listing again, so there is no HEAD, no
`GetObject` and no KMS grant, and the SSE-KMS checksum question does not arise for this role.
A bucket lifecycle rule that aborts incomplete multipart uploads and expires noncurrent
versions is still recommended as defence in depth and is bucket configuration outside this
repository.

This is scheduled by a person, not by a timer: there is still no service identity, so the
pass runs when an assigned operator (or a reviewed scheduled invocation using an operator
identity, which does not exist yet) calls it. A 48-hour download deadline is therefore not a
48-hour deletion guarantee until a scheduled mechanism or a staffed process with a stated
service level exists; that decision is open.

## Second recheck: integrity binding and settlement (migration 20260920140000)

Two further reproductions against migration 95, both added unmodified
(`describe('Codex migration95 adversarial boundaries')`) and passing:

| Finding | Repair |
|---|---|
| Recovery accepted a same-length object whose checksum was unrelated to the recorded parts. | The recorded part digests fix exactly one acceptable object: S3's composite `base64(sha256(concat(part digests)))-count` (`compositeChecksum`). Recovery, the normal completion path and download issuance all compare against it; a differing, missing, malformed, wrong-count or reordered checksum fails the job closed (`object_mismatch`) or refuses the download. The fictional store now returns S3-shaped checksums (full-object for PUT, composite for multipart) instead of a placeholder. |
| Cancel and cleanup could certify deletion while a pass had a storage request in flight; the request then landed with no obligation left. | The lease is the record of an admitted writer and nothing erases it except the pass that finished its own storage work: cancel, fail (by another caller) and expiry keep `lease_until`; a recorded pass releases it only when no completion step remains; completion, and the leaseholder failing its own job, release it. Every storage request of a pass is aborted at the lease boundary. A finished job is `settled`, and certifiable, only when its last lease is at least 60 seconds old (`privacy_export_settlement`); both listings report the flag, both cleanup paths count an unsettled job as pending, and both certification functions refuse an unsettled job at the SQL boundary. |

The 60-second settlement window is the assumed bound on how long a request aborted
client-side at the lease boundary can still land in S3. It is a reviewed constant in one SQL
function, not a measured hosted value; the hosted run should confirm it or widen it.

Cases in the same file: missing, malformed, wrong-count and reordered checksums, correct
recovery with the download HEAD bound to the same checksum and refused when it differs, a
completed upload whose returned checksum differs from the parts, a late staging put, a late
part and a late completion landing after cancel or expiry (pending inside the window, found by
listing and removed once the window has passed, certificate only then), and the operator pass
under the same rule with SQL-level refusal of an unsettled certification.

### Why 60 seconds, and why it is not a guarantee

The settlement window covers one thing: a request this service itself started under a lease
and then abandoned. Every storage call of a pass carries a signal that aborts at the lease
boundary (at most 60 seconds after the lease began), and the S3 client is configured with two
attempts, so the last byte the service can send leaves before the lease ends. After that the
only open question is how long S3 may take to make a request it has already received durable
and visible. The 60-second figure is a conservative operational assumption about that
server-side completion latency for requests of at most 5 MiB; it is not derived from a
published S3 bound, and a timing experiment that never observes a later completion would not
make one impossible (a partitioned network path, a retried request inside the SDK, or a
paused process can all deliver later).

So the design does not rest on the window. The window decides only when the *first* removal
may be certified. Migration 20260920150000 then treats every certificate as provisional: the
job is reconciled again once the window has passed since certification, and daily for thirty
days after that, by listing the key; anything found reopens the cleanup obligation
(`object.reappeared` audit row, certificate withdrawn) and is removed with a fresh certificate
only after listing shows nothing again. The bucket lifecycle rules in
`infra/aws-clinical-core/personal-export-bucket-lifecycle.json` are the last layer: incomplete
uploads aborted after one day, noncurrent versions expired after one day, current export
objects expired after three days. If the hosted run measures completions later than 60
seconds, widen the constant in `privacy_export_settlement()`; the reconciliation and
lifecycle layers stay as they are.

## Retention as an operated process (migration 20260920150000)

Retention state is reported separately from job status, on every job view (`retention`) and
in the backlog:

| State | Meaning |
|---|---|
| `packaging` | requested or running |
| `downloadable` | ready and before its deadline |
| `cleanup_pending` | cancelled, failed or expired and not yet certified removed: settling (a pass may still be writing), due, or deferred after a failed attempt |
| `removal_recorded` | certified removed; reconciliation after the settlement window still owed |
| `removal_verified` | certified and reconciled with nothing found |
| `retained_under_hold` | defined, never produced: an export copy duplicates records that stay under the owner's retention and any legal hold, so the copy is removed regardless of a hold. This is a policy default awaiting review; if a hold must also preserve delivery copies, the state exists to report it. |

Download expiry (`status: expired`) is therefore distinct from removal (`objectDeleted`,
`removal_recorded`/`removal_verified`); the V2 card says so.

Mechanics:

- **Backoff.** A failed removal attempt is recorded (`cleanup.deferred`, attempts, last error
  label, next due time: 1 minute doubling to a 6-hour cap). The owner's pass reports deferred
  jobs as remaining without touching the store; operator and sweep listings return only due
  jobs, oldest first and bounded, so one failing job cannot starve other owners.
- **Reconciliation.** `list_*_reconcile` lists certified jobs due for a re-check; the caller
  lists the key and records `object.reconciled` or `object.reappeared` (which reopens cleanup).
  The owner's request and cancel routes run cleanup and reconciliation; the operator has
  `reconcileExports`; the sweep runs both.
- **Backlog.** `exportBacklog` (operator, assigned owners) and the sweep's global backlog
  return counts per state plus `oldestOverdueSeconds` and `oldestPendingSince`, measured from
  `finished_at` (cancel, failure or download expiry). Counts only, never keys or owners.
- **Scheduled sweep (disabled).** `privacy-retention-sweep-lambda.ts` runs hourly under
  `RetentionScheduleActive` on the privacy-operations candidate: it needs `ExportCleanupActive`,
  `RetentionScheduleEnabled`, its own evidence hash and the retention service identity
  (`RetentionServicePersonId`, `RetentionServiceSubject`, `RetentionServiceOrganizationId`).
  The identity is an ordinary workforce identity row; the database accepts it as the retention
  service only while a reviewed row in `privacy_retention_service_releases` names it
  (`retention_service_release_required` otherwise). No row is seeded, so a deployed schedule
  refuses until the operating policy is approved and an operator inserts the release
  (`retention-service-release.ts` through `scripts/release-aws-retention-service.ps1`; the
  order of operations and refusal categories are in `retention-sweep-activation-runbook.md`;
  the sweep entry point has run locally against the executable SQL with a fictional store, never
  hosted). Each run
  publishes CloudWatch embedded metrics (`ALP/PrivacyExportRetention`: `CleanupPending`,
  `CleanupDeferred`, `Settling`, `OldestOverdueSeconds`, `Reopened`, `Cleaned`,
  `SweepRefused`); alarms fire when the oldest pending removal exceeds
  `RetentionOverdueAlarmSeconds` (default 72 hours), when a sweep is refused, or when no report
  arrives. Its IAM is the same export-retention statement set: listing, abort, versioned
  delete; no object reads, no KMS.
- **Staffed alternative.** Without the schedule, the assigned operator's three actions are the
  process; the backlog panel shows what is due, settling, deferred and awaiting re-check. Which
  model operates, and the service level for the oldest pending age, is the open policy
  decision; both are implemented and locally verified only.
- **Account closure.** Closed or disabled owner accounts are covered by both the operator pass
  and the sweep, which never need the owner's identity.

Evidence (PGlite, fictional store): a write landing after the window and after the
certificate is found by reconciliation, reopens the job, is removed, and the certificate is
restored on the next re-check; a hung request aborted by the caller lands later and is removed
after settlement; concurrent owner and operator cleanup certify exactly once; a failing job
defers with doubling backoff, is audited, does not starve the other job, and clears its
deferral once cleaned; the operator backlog counts assigned owners only and reports the oldest
pending age; the retention sweep is refused without a release row, covers unassigned owners
with one, attributes its audit rows to the service identity, and is refused again after
revocation. `aws-privacy-export-store.test.ts` pins the S3 request shapes with a fictional
client (pagination markers, delete markers, checksum mode only on request, 404 as absence,
403 rethrown, composite checksum passthrough, exact-version deletes). None of this has run
against a bucket.

This is still the inline export's coverage, not a complete account export.
