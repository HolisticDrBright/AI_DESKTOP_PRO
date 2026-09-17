# Lab import receipt contract for coordinated V2 recovery

Source-only addition to the AWS clinical-state adapter. No SQL migration, provider
activation, PHI flag or clinical-review decision is changed.

After record_lab_import succeeds, the adapter returns the existing eventId,
state and duplicate plus receipt.version=lab-import-receipt/1, connectionId,
providerEventId, resourceVersion and payloadSha256. The hash is exactly the
canonical content hash supplied to SQL. The existing function checks that hash
before accepting an event/resource-version duplicate. The adapter snapshots input
before asynchronous database work and validates the database outcome before
issuing the receipt. It does not return raw health content in receipt metadata.

V2's coordinated source candidate requires those correlation fields and saves
the immutable selection and receipt in an encrypted account/environment journal.
Older API responses remain uncertain rather than being treated as successful
delivery. Deploy the API first; prove authenticated synthetic receipt matching,
duplicate replay, lost-response restart, changed consent and cross-user refusal
before shipping a mobile candidate. Unit tests and matching golden hashes are
not hosted or physical acceptance. No paid mobile build is triggered here.

Conflicts and rejections remain terminal acknowledgment states, not successful
imports. Historical receipts do not claim later clinical review completion.
Device loss/server discovery, retention/erasure, versioned specimen-context
delivery, multi-device concurrency and overall release qualification remain open.
