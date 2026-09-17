# Personal lab cleanup and legal holds

September 17, 2026. Original phases 2/3, source candidate only. No deployment,
hold release, policy approval, PHI activation or paid mobile build.

## Repaired boundaries

- Both production delete/cancel and the background sweep/late-object cleanup
  carry a real database deletion guard. A personal cleanup path without it
  refuses before destructive calls. The synthetic path remains unchanged.
- Migration 62 adds `guard_owned_external_deletion()`: current production
  consumer identity, consent-management purpose, shared owner advisory lock,
  active identity/person row locks and no unreleased owner hold. It accepts no
  caller-selected owner parameter. Only the API database role may execute it.
- The guard transaction remains open around each remote mutation: claiming
  deletion, stopping processing, deleting each object-version batch, removing
  the job row and updating the late-upload watch. New holds are rechecked between
  mutations. Processing consent is not required to request deletion.
- Remote DynamoDB/S3 mutations and each Step Functions stop have 15-second
  abort deadlines. Database outage, identity refusal or hold prevents further
  mutation. A held request returns `lab_deletion_held` (409); unavailable guard
  returns 503. No successful partial-deletion acknowledgment is substituted.
- Personal cleanup requires the full reviewed activation posture, not merely
  PHI/classification flags. Its candidate role receives scoped database/secret
  access only under the existing `Active` condition. Defaults remain blocked,
  PHI false, logs-only, events disabled. The synthetic cleanup role is unchanged.
- The production candidate no longer inherits native Dynamo TTL or S3 object/
  version expiry. Those mechanisms cannot consult the database hold. Processing
  deadlines remain deadlines, not permission to erase retained data. Source and
  operational retention require a reviewed policy and hold-aware cleanup. This
  can increase retained storage; no claim of automatic seven-day erasure remains.

## Evidence and limitations

106 targeted tests passed, including all 62 production SQL migrations in isolated
PGlite and 38 privacy SQL cases using fictional identities/data. Tests exercise
held/disabled/wrong-purpose/wrong-subject refusals, no callback before authority,
guarded remote operations, a hold between cleanup steps, missing guard, safe
errors, default-blocked infrastructure, and uncertainty after remote completion.
Full Desktop suite: **1,951 passed / 11 existing skips**. Typecheck, changed-file
lint, production SQL gate and generated CloudFormation lint passed.

This is **not a distributed atomic transaction**. A remote request that times out
may already have executed; database rollback cannot restore S3 versions. The
durable outbox must remain for reconciliation. A hold placed after an authorized
mutation cannot undo it. These tests do not establish real Aurora/S3 concurrency,
network-partition or hosted event-delivery behavior. S3 Object Lock, if required
by the approved retention policy, is not supplied by this database guard.

Deletion still reports only the job cleanup/late-upload-watch state, never full
account erasure. Reviewed account-wide lab inventory orchestration, voice holds,
identity-last fulfillment, clinic/device/archive/backups/audit retention, hosted
qualification and physical testing remain open. The approved synthetic AWS
profile is currently expired; no other account/profile was substituted.
