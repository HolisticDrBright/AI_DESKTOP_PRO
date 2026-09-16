# Production voice shutdown candidate

Source implementation only. Nothing deployed or activated. Original phase2
increment, not a completed commercial-readiness phase.

## Why there are three states

- blocked (default): no service data permissions and no sweep schedule.
- approved: previously reviewed identity/consent/entitlement-governed processing.
- draining: all public methods return503 with voice_cleanup_only; only the
  scheduled maintenance invocation may cancel and clean existing jobs.

Drain requires PhiAllowed=false, empty AllowedScopes, the earlier activation and
provider evidence hashes, a separate CleanupEvidenceSha256, and alarm recipient.
Hashes record the operator's review reference; they do not verify a signature or
create authorization. No consent grant, content upload, provider start, transcript
retrieval, SQL lookup or billing request is made by drain.

The existing durable sweep cancels due unexpired jobs via its refusal policy,
waits for nonterminal provider work, and removes terminal provider jobs and exact
audio/transcript object versions. Partial failures retain pending state and throw
a sanitized retry error for the Lambda alarm. Independent invocations resume from
persisted jobs; no phone or new consent is required. All public reads and writes
remain unavailable, including user cancellation (the worker cancels on their behalf).

IAM in drain permits only named-table GetItem/UpdateItem/index Query, scoped
object-version listing/deletion and named-job provider status/deletion. KMS
permissions are constrained to DynamoDB through its regional service and this
table/account encryption context; no S3-content decryption permission is retained.
See [AWS DynamoDB encryption context and permissions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/encryption.usagenotes.html).
Actual AWS/key-policy effectiveness still needs hosted acceptance.

## Required shutdown sequence — not executed

1. Operator reviews retention/legal holds and approves a drain plan, alarm owner,
   prior service evidence and recovery procedure. If a hold prohibits deletion,
   do not enable this deleting drain; arrange an authorized preservation process.
2. Review and apply a change set selecting draining and disabling new processing.
   Wait for deployment completion and old invocations to finish. IAM/configuration
   propagation is not an instantaneous global cancellation transaction.
3. Verify public rejection, scheduler operation and alarm delivery using synthetic
   acceptance. Inspect all pending jobs and provider/object versions independently.
   An empty due-work batch or HTTP swept:true is NOT proof of an empty inventory.
4. Keep drain running until pending jobs and provider jobs/object versions are
   independently reconciled. Ready jobs may not become due until their15-minute
   readable deadline; each sweep has a25-item limit. Running provider work cannot
   be forcibly deleted until terminal. Failures require investigation, not blocking
   the schedule and claiming erasure.
5. Only after a reviewed completion inventory, set blocked. Retained job metadata
   TTL, PITR, logs, backup/audit retention and account-level erasure are separate.
   No automatic empty-inventory certification or irreversible key deletion exists.

## Source verification

Tests cover every public method and spoofed scheduler envelope, missing/invalid
drain configuration, abandoned/queued/ready jobs, running-provider wait then
restart, retry after partial deletion, restricted candidate IAM and built-handler
refusal. Tests use doubles; neither an AWS drain nor production erasure is claimed.
The default-blocked candidate builds and passes CloudFormation lint.

Local verification: full Desktop suite1562 passing /11 existing skips (14 added
checks), typecheck and CloudFormation lint passed. No V2 code changed; its prior
aed85d56 GitHub run35053061002 passed. Updated Desktop CI must be checked after
publication; earlier green source runs do not prove this revision.

Remaining: actual IAM/provider and deployment-transition acceptance, complete
inventory reconciliation tooling, backlog/load/failure alarms, operator/legal-hold
decisions and full account privacy fulfillment. Clinical holds and source checks
are unchanged. No paid mobile build, real data or PHI activation.
