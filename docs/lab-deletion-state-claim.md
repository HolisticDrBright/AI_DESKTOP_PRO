# Lab deletion state claim — September 15, 2026

Source repair in original commercial phases 2/3. This is not full privacy
fulfillment, active-job cancellation or production document conversion.

The old deletion path read an eligible state, purged objects, then deleted the
job using only an owner condition. Upload completion could queue the same job
between the read and purge. The revised route conditionally claims `deleting`
before any purge. The claim verifies account subject, organization, person,
eligible state and absence of a live worker lease. A queued/processing winner
prevents purging. The final delete requires the same scope and deletion state.

An object-store failure leaves `deleting` durable so explicit retries can finish;
it does not restore the job to an upload/processing state. A repeated delete after
the row is absent remains idempotent. All direct job reads now compare all three
ownership dimensions, not only Cognito subject. Existing synthetic attestations,
PHI restrictions and scoped IAM remain unchanged. No objects were actually
deleted while developing or testing this source change.

Tests mock the AWS clients and exercise upload-completion races, worker leases,
failed purges, retry, stale state and each ownership mismatch. Real AWS contention
and device acceptance still require execution after coordinated deployment.

## Explicit remaining limitations

- Previously issued S3 upload URLs and in-flight PUTs can outlive this API
  operation. This change does **not** prove enduring object erasure. A durable
  cleanup ledger with URL/in-flight-write handling and post-cleanup evidence is
  required before claiming complete privacy fulfillment. Do not interpret
  `deleted:true` here as closure of an account-wide privacy request.
- Failed purge jobs require retry/operations visibility; no new autonomous
  sweeper, retention policy, account deletion or legal-hold decision is invented.
- This does not cancel active processing. It deliberately refuses it.
- A compatible backend release must deploy before using the revised semantics;
  old workers/API versions are not qualified for rollback across `deleting` jobs.
