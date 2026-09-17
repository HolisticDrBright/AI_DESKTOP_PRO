# Retained lab processing privacy copy

September 16, 2026. Original phase 3 progress; not commercial readiness or PHI activation.

## API contract

- `GET /clinical-core/consumer/labs/jobs/{jobId}/privacy-copy` returns
  `lab-processing-copy/1`: a single consistent retained-job snapshot, its
  SHA-256, source inputs, result, delivery metadata and document metadata.
  Dynamo internals, authorization, execution leases and document object keys
  are omitted. The response explicitly says it is not a complete account export.
  It can read a retained row past its processing TTL, but cannot restore one
  DynamoDB has already removed. It never resumes processing, claims delivery,
  adopts a plan, writes a row or calls an AI provider.
- `POST /clinical-core/consumer/labs/jobs/{jobId}/documents/{documentId}/privacy-download`
  requires exactly `{ "confirmDownload": true }`. It verifies the original
  object's byte count, MIME type, SHA-256, job/document metadata, exact owner
  namespace and KMS key. Legacy documents without a checksum refuse download.
  It signs only the verified S3 version for 60 seconds, with `If-Match`, a
  generic attachment filename and `no-store`. The response includes expected
  bytes/checksum, required headers and expiry for a separately verified client
  download. A client must verify the received bytes before exposing the file.
- Synthetic-session equivalents keep the existing custom authorizer; consumer
  routes retain JWT authorization. Production has 17 consumer routes; the
  synthetic template has 34 routes. Version-specific S3 permission is scoped
  to the correct namespace and remains conditional on production activation.

Both routes require exact subject, organization, person and classification.
Active production DB identity is checked repeatedly, independent of a current
processing-consent grant or Core payment. **Deployment activation and enabled
feature scopes remain required.** This is not an emergency export service for
a globally disabled deployment. Current clinical processing reads still require
their original consent revisions; privacy copies do not make historical results
current or clinically approved.

Download checks repeat the job/identity reads before and after signing. This
detects tested deletion/identity races but is not an atomic identity+S3 lock.
Once a presigned URL has been returned it is a short-lived bearer capability;
later consent withdrawal cannot recall it. Never log it or include it in the
JSON privacy copy. Delivered copies outside ALP cannot be recalled either.

## Withdrawal-safe cancellation

The ownership reader used by explicit cancel/delete was still enforcing current
AI consent despite accepting deleting rows. It now bypasses only the processing
consent check for those operations. Exact ownership, classification, state,
explicit cancellation confirmation, atomic cleanup claim and cleanup outbox
remain enforced. Withdrawal does not authorize new processing or result adoption.
This change does not alter legal holds or retention policy.

## Evidence and remaining work

Unit/adversarial tests cover cross-owner/classification refusal, absent/corrupt
records, exports after withdrawal, no billing/processing side effects, byte
bounds, source hashes, document metadata/version checks, expiry and identity/
deletion races. API integration uses mocked AWS clients; cleanup atomic/state
tests run separately. Template tests build the actual default-blocked Lambda
candidate and inspect its scoped version-read permissions. This is not hosted
JWT, actual S3 download, or physical-device evidence.

V2 exposes a selected-record JSON export from analysis history, with checksum,
account/environment/session lifetime checks and native file-sharing cleanup.
It does not yet expose original-document downloads. Remaining: bounded native
binary download/checksum/share/cleanup; complete inventory including legacy,
unindexed and expired retained jobs; all-account orchestration including
transcripts/identity/billing/audit; operational retention/legal-hold fulfillment;
deployment and physical acceptance. No original phase is complete.
