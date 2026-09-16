# Durable lab-file deletion cleanup

Original commercial phases 2/3. Synthetic-only implementation; no production
PHI activation, new clinical approval, mobile build or account-wide erasure claim.

## State and authorization

An owned deletion atomically claims the eligible job as deleting and upserts a
minimal cleanup outbox. Scope, processing state and worker-lease conditions guard
that transaction. The outbox stores identifiers, version and scheduling/verification
timestamps only, never filenames, lab values, results, credentials or signed URLs.

Cleanup rereads the outbox and current job consistently, verifies exact scope and
deletion state, removes source/artifact object versions, conditionally drops the
clinical job row, then retains a late-upload watch. Partial failure remains retryable.
Normal reads and request replay cannot expose or revive a deletion-claimed job.
Older deleting rows without an outbox can be repaired by an owned deletion retry.
Worker failure callbacks now accept only the processing states for their pass.

Object-created events do not independently authorize deletion. A current matching
outbox is required; an unrelated bucket/key, account or active job cannot be purged.
Late writes to the deleted job's exact prefix are reconciled even after its job row
is gone. A five-minute due-index sweep retries pending work and periodically checks
watching records (five-minute cadence during the first hour, daily afterward).
The bounded sweep paginates past failures, uses no table Scan, and preserves failed
work rather than reporting an empty success.

## Infrastructure and operation

- KEYS_ONLY LabCleanupDue index; existing inventory index remains.
- Dedicated cleanup Lambda uses the API artifact export, not the model worker.
  It uses shared account concurrency: this synthetic account currently has only
  10 executions and cannot allocate reserved concurrency under AWS's unreserved
  minimum. Commercial capacity/isolation and throttling tests remain required.
  It has scoped ledger/index/version-delete permissions, no object-body read/write,
  no model credentials and no Secrets Manager access.
- S3 EventBridge object-created rule and scheduled retry rule have exact resource
  permissions, delivery retry and an encrypted failure queue. Lambda asynchronous
  execution failures also go to that queue. The queue retains operational failure
  metadata for 14 days; EventBridge delivery failures may include the original
  object-event envelope (filename/key/request metadata). Do not treat it as public
  or assume the input transformer sanitizes every type of failure capture.
- Logs use fixed failure codes rather than SDK errors, event bodies or identities.
  Alarms cover Lambda failures and queued failed deliveries.
- LabCleanupAlarmTopicArn defaults empty. Alarm state exists, but **notifications
  are not configured** until an approved SNS topic/operational owner is supplied.
  Deployment preparation cannot silently invent a recipient through a new default.
- Tombstones have no automatic TTL. Their retention/removal needs an approved
  operational/retention policy; identifiers are still sensitive metadata. Never
  delete a watch while uploads, delayed delivery or backup restoration can revive
  objects without a replacement reconciliation mechanism.
- Operators can invoke the cleanup Lambda with the exact payload
  `{"kind":"sweep"}` to retry due records. Investigate recurring failures and replay
  failed events under the scoped synthetic role; do not alter ownership or remove
  tombstones to make an alarm disappear.

## Verification procedure

After the reviewed stack update completes and both indexes are ACTIVE:

```powershell
./scripts/test-aws-lab-recovery-hosted.ps1 -ConfirmSyntheticOnly -CreateSyntheticTestUsers -TestUploadRoundTrip -TestLateUploadCleanup
```

The smoke uses two newly created, email-suppressed synthetic identities. It checks
replay/isolation, invokes only the worker's failure callback against its own
awaiting-upload job (no analysis), uploads a constant non-clinical fixture,
deletes it, validates the minimal watch, uploads again using the still-valid URL,
and waits for automatic removal without another delete request. It never calls
complete-upload or the model. Cleanup retries the exact owned test job if needed,
signs out/disables both test identities, and retains audit evidence.

Tests cover partial failures, wrong scopes, corrupt metadata, cross-prefix results,
late writes, worker races, legacy deleting rows, replay refusal, posture refusal,
payload-free logs and scoped infrastructure. Unit tests are not live acceptance.
Record actual deployed SHAs, index status, smoke results and skipped checks in the
release evidence before describing this as operational.

## Explicit remaining boundaries

This does not cancel active processing, migrate already-expired legacy jobs,
delete personal-record copies/protocols/transcripts or external-provider records,
fulfill legal holds, or erase backup/PITR copies. Backup restoration must reapply
the deletion ledger before serving restored data. Approved retention, routed
operational alarms and full account-wide fulfillment are separate launch gates.
Do not roll back to a worker that can overwrite deleting state or an API that
deletes without preserving the outbox.

AWS behavior references:
[S3 event schema](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ev-events.html),
[EventBridge retry and failure capture](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html),
[Lambda asynchronous failure destinations](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html).
