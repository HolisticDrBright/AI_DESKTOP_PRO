# Lab request creation recovery — September 15, 2026

Source candidate only. No AWS deployment, paid mobile build, live AI request,
credential change, PHI activation or clinical approval was performed.

## Implemented

- V2 persists an encrypted, account/environment-scoped request UUID, original
  timestamp, input fingerprint and original panel ID **before** creating a job.
  Document requests also keep the existing checksum/size/MIME/ID manifest.
  No document contents, local paths, filenames, credentials, clinical input
  payloads or signed upload URLs are persisted in this recovery pointer.
- Saved-value plans and document uploads use dedicated request-aware POST routes.
  A capability check is required first; a rollback between check and POST still
  cannot fall back to legacy creation because the POST route itself is new.
- AWS atomically writes the job and an immutable request-to-job ledger entry.
  The ledger key binds owner, organization, person and request UUID. A canonical
  input fingerprint binds the original input and request kind. Reuse with changed
  inputs or timestamps refuses. Concurrent winners and lost transaction responses
  are resolved through strongly consistent ledger reads.
- Discovery returns only a versioned request/job reference, not clinical data or
  a guessed state. The client verifies the reference before saving the job ID,
  then uses existing job status, upload recovery and durable-result acknowledgement.
- An interrupted request can be found after restart even when its create response
  was lost or the subsequent local job-ID write failed. If AWS explicitly reports
  that no request was recorded, retrying the same original inputs uses the same
  identity. Generic 404s, authorization failures and service errors do not permit
  creation. Resume without original inputs explains that they must be reselected.
- Document retries compare bytes and original context. When a job already exists,
  its original context/panel wins. Before creation was recorded, filename/context
  changes refuse; reselecting the same file under a new local path is supported.
- A discovered job must match the full identity scope and remain unexpired.
  Job deletion leaves the immutable ledger. Deleted/expired jobs cannot be revived
  by replay. After obtaining a job ID, V2 retains the request identity too; a
  missing job no longer silently clears a recoverable pointer and starts anew.

## Retention and deployment contract

Job and document expiry remains seven days. The synthetic-only request ledger
retains just its hashed key, job ID, fingerprint, request timestamp and TTL for
90 days. Creation without an existing ledger is limited to a request timestamp
within the prior 24 hours (at most 60 seconds ahead for clock skew). Therefore an
old request remains too old to recreate even after TTL removes its ledger entry.
This is not a production retention-policy approval or cross-device recovery index.

The extension now has 20 authenticated routes: the previous 12 plus capability,
request discovery and dedicated document/saved creation under each existing
consumer JWT and synthetic-session authorizer. Existing table Put/Get permissions
cover the conditional transaction; no public endpoint or broad table access added.

Deploy the matching Desktop-owned lab API bundle **and** lab-analysis-extension
routes before a future mobile candidate. Older clients retain their legacy
contract but do not gain creation recovery retroactively. New clients refuse an
old/missing recovery service. A mixed-version rollback must retain pending state,
not prompt users to clear app storage or repeatedly start fresh analyses.

## Verification

- Local V2 suite: 612 passing tests, one existing hosted skip.
- Local Desktop suite: 1,329 passing tests, 11 existing skips.
- TypeScript checks and V2 lint pass. Desktop lint: zero errors, four pre-existing
  warnings. AWS lab API/worker bundle builds and infrastructure validation pass.
- Added negative tests: concurrent creates, response loss, changed intent/time,
  all three identity-scope dimensions, deletion, expiry after TTL cleanup,
  unknown 404s, rollback between probe and POST, storage failure before/after
  creation, account change, original file/context/panel recovery and route auth.
- DynamoDB concurrency and API tests use mocked services. They do **not** establish
  hosted DynamoDB/IAM behavior, real S3 upload recovery or physical app acceptance.
- Clinical package manifests still verify; holds, exclusions, approval/verification
  distinctions and runtime activation gates were not changed.

Required hosted/physical acceptance: simultaneous same-ID requests against isolated
synthetic AWS; interrupt before/after each create/checkpoint/upload step; expire
signed URLs; exercise delete/expiry and cross-account denial; retry after a backend
rollback; confirm one job, one workflow execution name and one saved result. Repeat
on iOS and Android. No real lab, wearable or cycle data may be used for this check.

## Remaining work

This completes the **pre-create recovery source increment**, not commercial release
or all six phases. Still required: cross-device request inventory, recovery when
original files are lost, explicit safe abandonment of expired/unrecorded requests,
production-owned document/voice processing, atomic result/plan persistence,
active-plan adoption, guardian/privacy fulfillment, clinical release qualification,
store/provider integration and coordinated deployment/device/security/restore tests.
Executed BAAs, retention/subprocessor review, source verification, held decisions,
signatures and business/store permissions remain separate activation gates.

References:
- [DynamoDB atomic conditional transactions](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)
- [Transaction behavior and the SDK token's limited idempotency window](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

