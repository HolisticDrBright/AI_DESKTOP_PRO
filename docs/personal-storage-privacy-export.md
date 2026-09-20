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
- **Expiry and cleanup.** A ready copy expires 48 hours after the cut-off; the owner's next
  request, cancel or status call marks it expired and the owner's next cleanup pass aborts
  open uploads and deletes staging and object versions, each verified absent, before the
  job is recorded as deleted. One open job per owner; one new job per owner per hour.
- **Evidence.** PGlite runs the production SQL with a fictional object store
  (`owned-privacy-export-jobs.database.test.ts`): multi-part packaging with exact counts
  against the snapshot row, download issuance and refusal, cancellation with verified
  cleanup, expiry, resumption after a failed pass, and cross-owner refusal. No bucket,
  hosted run, signed link or real account was used.

This is still the inline export's coverage, not a complete account export.
