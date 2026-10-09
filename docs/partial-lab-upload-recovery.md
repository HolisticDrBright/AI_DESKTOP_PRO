# Partial lab upload recovery — September 15, 2026

Source candidate only. No PHI activation, AWS deployment, paid mobile build,
real provider call, credential change or clinical sign-off.

## Implemented

- V2 hashes the actual selected file bytes (SHA-256), one file at a time.
  The new job request binds each document to that checksum.
- After AWS returns the job, V2 persists an encrypted account/environment-bound
  manifest before the first PUT. It contains document IDs, checksums, sizes and
  MIME types, not names, local paths, document contents or presigned URLs.
  Each successful PUT checkpoints the uploaded IDs.
- If interrupted, select the same original files in the same order and choose
  Analyze securely. A pending manifest resumes the original job and its original
  analysis context; it does not submit the newly assembled intake/context.
  Resume pending lab analysis reports this instruction when files are needed.
- Recovery verifies bytes, size, MIME and document order before requesting new
  destinations. Re-selected paths or renamed files do not lose the job identity.
  Missing/different files refuse without creating another job.
- The AWS backend adds POST jobs/{jobId}/resume-upload on both existing consumer
  JWT and synthetic-session authorizers. Ownership, organization, person,
  synthetic attestation, awaiting-upload state, expiry and checksum availability
  are required. Legacy jobs without checksums are not silently promoted.
- Backend lists the exact document-key prefix with a one-object bound, then checks
  existing objects' size/type, KMS key, job/document metadata and full checksum.
  Only genuinely missing documents receive new 15-minute links. AccessDenied,
  timeouts, mismatched objects and invalid states refuse rather than mean missing.
- Checksum and If-None-Match headers are signed. Upload links cannot overwrite an
  existing object; S3 validates the received bytes. The mobile client checks those
  headers and the complete recovered inventory before uploading.
- Completion rechecks object metadata/checksum before queueing. Duplicate completion
  uses the existing job. Result acknowledgement remains separate from model completion.
- The upload screen now uses UUID panel IDs compatible with recovery storage.
  Recovered results retain their original panel ID even after opening a new form.
  A collection date must still be supplied from the report; generation time is not
  a substitute. No automatic transfer to Desktop is added.

## Deployment and rollback

Deploy the matching Desktop-owned lab API bundle and lab-analysis-extension
template before the new mobile candidate. The extension now declares 12 routes,
including the two authenticated recovery routes, and a ListBucket permission
restricted to the synthetic-labs prefix. Existing KMS permissions cover checksum
reads. Do not ship the new client against the old backend: it deliberately refuses
upload destinations missing the checksum/non-overwrite contract.

Old clients remain supported by the original upload contract, but their jobs lack
the checksum-bound recovery feature. Rolling the backend back before the app
would disable this new recovery path; keep pending jobs and do not recreate them
automatically. Complete a coordinated rollback rehearsal before commercial rollout.

## Verification

- V2: 592 tests pass; one hosted test remains skipped. Typecheck/lint and
  capability/TestFlight source gates pass.
- Desktop: 1,311 tests pass; 11 existing skips. Typecheck passes; lint has zero
  errors and four existing warnings. Lab API/worker bundles and infrastructure
  validation pass. Offline real-SDK signing verifies checksum/non-overwrite headers.
- New tests exercise file-content changes despite identical name/size, partial
  checkpoint/resumption, original panel identity, account changes, invalid inventory,
  missing signed headers, cross-owner/org/person denial, expiry, legacy jobs,
  storage failures, checksum mismatch and authenticated route definitions.
- No physical iOS/Android upload, live S3 checksum PUT/HEAD, hosted two-account
  test or deployed end-to-end acceptance has been performed for this checkpoint.
  Unit/integration tests use synthetic fixtures and mocked services.

## Remaining engineering

This finishes the **known-job partial-upload recovery source increment**, not all
of phase 2 and not commercial readiness. A lost create response or a crash between
server creation and local checkpoint still needs pre-create idempotency and
server job discovery. Cross-device recovery, missing-original-file recovery,
production-owned document/voice conversion, atomic result/plan persistence,
active-plan adoption, guardian/privacy fulfillment, signed eligible clinical
releases, store/provider integration and full release qualification remain.

BAAs, retention/subprocessor review, source verification, held clinical decisions,
signatures, business/store permissions and physical acceptance remain separate.
Knowledge-package holds, exclusions and activation gates were not changed.

Implementation references:
- [S3 PutObject conditional writes and checksums](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
- [S3 checksum retrieval and KMS permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html)
