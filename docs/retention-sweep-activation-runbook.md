# Retention sweep activation runbook

September 20, 2026. How the scheduled personal-storage export retention sweep goes from
"deployed but refusing" to "acting", and back. The sweep has never run hosted. Its only executed run
is the local PGlite run in `owned-privacy-export-jobs.database.test.ts` ("retention sweep activation
path"), with a fictional object store. Nothing below is hosted evidence until the printed JSON of a
real `release` and the first sweep's CloudWatch report exist.

## What has to be true before the sweep does anything

The sweep (`privacy-retention-sweep-lambda.ts`, bundled as `retention-sweep.js` in the
privacy-operations candidate) refuses at three independent layers. All three must be satisfied; the
order below is the order they are normally cleared.

| Layer | Mechanism | Cleared by | Status |
|---|---|---|---|
| 1. Stack | `RetentionScheduleActive` condition on the privacy-operations candidate: needs `ExportCleanupActive` (`ExportCleanupEnabled=true`, `ExportCleanupEvidenceSha256`, `ExportBucketName`, `ExportKmsKeyArn`), `RetentionScheduleEnabled=true`, `RetentionScheduleEvidenceSha256`, `RetentionServicePersonId`, `RetentionServiceSubject`, `RetentionServiceOrganizationId`. Without it the function, schedule and alarms do not exist. | A reviewed stack update with those parameters. | not deployed |
| 2. Function | `retentionSweepContext` refuses unless `PHI_ALLOWED=true`, the evidence hash and identity parameters are well formed (`retention_sweep_configuration_invalid`). `PHI_ALLOWED` is the foundation stack's `PhiAllowed`. | PHI activation of the privacy-operations plane, a separate human decision. With PHI disabled the sweep cannot act even if layers 1 and 3 are cleared. | PHI disabled |
| 3. Database | `clinical_private.retention_sweep_actor()` requires the caller to be an active, production-bound workforce identity named by a live row in `clinical_private.privacy_retention_service_releases` (`approved_at` passed, `revoked_at` null). No migration seeds a row. Without it every sweep call refuses `retention_service_release_required`, the run reports `SweepRefused=1` and `RetentionRefusedAlarm` fires. | The `release` command below. | no row |

The evidence hash is one reviewed document: the retention operating policy that names the service
level for the oldest pending removal (`RetentionOverdueAlarmSeconds`), the sweep cadence, who the
retention service identity is, and who approves releases. Its SHA-256 is passed as
`RetentionScheduleEvidenceSha256` to the stack, recorded in the deployment manifest as
`retention_schedule_evidence_sha256`, and written into the release row. The wrapper refuses a
`release` whose hash differs from the manifest.

## The three numbers, and why they are kept apart

| Number | Where it lives | What it is |
|---|---|---|
| **24 hours** | `RetentionSweepSchedule` in the privacy-operations candidate | How often the sweep runs |
| **48 hours** | The job deadline enforced in the database (migration `20260920110000`), and this runbook | When a finished or cancelled prepared copy is removed |
| **72 hours** | The published privacy policy, and nowhere else | What the person is told: removal *within* 72 hours |

Each has slack against the next, and they are deliberately in different artifacts. Publishing measured behaviour turns
every timing bug into a misstatement, and 48 leaves no headroom for a slow backup or a missed pass. "Within" is the
load-bearing word in the published commitment: faster is compliant, and only slower is a failure. Nobody should
reconcile them — a change to any one of them is a separate reviewed decision.

## What each run must record

The sweep's report is the scheduled-cleanup evidence. Without it a missed pass is indistinguishable from a policy
failure, so every run emits one line carrying `startedAt`, `endedAt`, `durationMs`, `examined`, `removed` and
`outcome` (`completed`, `refused` or `failed`), beside the counts. `examined` is what the pass handled — copies cleaned
or deferred, certificates confirmed or reopened — not what remains in the backlog. A failed run reports before the
error propagates, because an unreported failure looks exactly like a sweep that never ran.

Three alarms watch it, all on the qualification alarm topic:

| Alarm | Fires when |
|---|---|
| `RetentionSweepMissedAlarm` | No completed sweep reported in 24 hours (a missing datapoint breaches) |
| `RetentionSweepFailedAlarm` | The sweep function errored |
| `RetentionSweepConsecutiveFailureAlarm` | Two consecutive sweeps failed |

**The alarm topic has no subscribers.** Until a real recipient is subscribed, every alarm above is a fiction and the
failure path does not exist. Fix that before the release, not after.

## The retention service identity

The sweep runs under its own role (`RetentionSweepRole`), holding only the database and export-retention statements —
not the inventory, purge or identity-deletion grants the operator function carries — and under a named non-human
service identity. The release path refuses a subject that is not named `svc-…`
(`retention_release_human_identity`), so the sweep cannot be released to run under a person's credentials.

An ordinary workforce identity row (`clinical_core.identities`, pool `workforce`, `production_bound`,
status `active`, belonging to an active person). It is provisioned like any workforce identity; it has
no assignments and no operator rights of its own. It gains the sweep's authority only from the release
row and loses it on revocation. The approver must be a different active workforce person. The database
enforces `service_person_id <> approved_by`; the module also refuses it before touching the database.

## Commands

`scripts/release-aws-retention-service.ps1` wraps
`dist/aws-clinical-core/retention-service-release-operator/index.cjs`
(`npm run build:aws-retention-service-release-operator`). Every command:

- pins the AWS account with `aws sts get-caller-identity` against the deployment manifest and the
  region against the manifest;
- takes the database from the reviewed qualification target manifest with `-QualificationTargetPath`
  (the manifest's qualification database, never the staging database a foundation stack exports; the
  qualification foundation is read only for its PHI posture), or, with `-FoundationStackName`, reads
  `PhiAllowed`, `DatabaseClusterArn`, `DatabaseSecretArn` and `DatabaseName` from that stack's outputs
  for a staging or production release; exactly one of the two must be named, and nothing is typed in by
  hand or printed;
- runs through the administrative RDS Data path with purpose `reviewed_retention_service_release`
  (the table is closed to the API role);
- removes every variable it set from the process afterwards.

```powershell
# Read-only: every release row, live or revoked, and the count of live rows.
.\scripts\release-aws-retention-service.ps1 -Command inspect -QualificationTargetPath <qualification-target.json> -DeploymentManifestPath <manifest.json>

# Insert the one live release. Refused unless the operating policy approval is confirmed here and the hash matches the manifest.
.\scripts\release-aws-retention-service.ps1 -Command release -QualificationTargetPath <qualification-target.json> -DeploymentManifestPath <manifest.json> `
  -ReleaseVersion ops-2026-09-20 -ServicePersonId <uuid> -ServiceSubject <cognito sub> -ApprovedByPersonId <uuid> `
  -PolicyEvidenceSha256 <64 hex> -ConfirmRetentionOperatingPolicyApproved

# End it. The next scheduled sweep is refused and RetentionRefusedAlarm fires until a new version is released.
.\scripts\release-aws-retention-service.ps1 -Command revoke -QualificationTargetPath <qualification-target.json> -DeploymentManifestPath <manifest.json> `
  -ReleaseVersion ops-2026-09-20 -ConfirmRetentionOperatingPolicyApproved
```

The Node operator can be run directly with the same environment (`PHI_ALLOWED`,
`EXPECTED_AWS_ACCOUNT_ID`, `AWS_REGION`, `CLINICAL_DATABASE_*`, `CONFIRM_RETENTION_OPERATING_POLICY_APPROVED`,
`RETENTION_RELEASE_VERSION`, `RETENTION_SERVICE_PERSON_ID`, `RETENTION_SERVICE_SUBJECT`,
`RETENTION_APPROVED_BY_PERSON_ID`, `RETENTION_POLICY_EVIDENCE_SHA256`). It prints one JSON line on
success and one bounded category on refusal (exit 1):

| Category | Meaning |
|---|---|
| `activation_boundary_refused` | unknown command, `PHI_ALLOWED` not stated, or approval not confirmed for `release`/`revoke` |
| `account_boundary_refused` | cluster ARN account differs from `EXPECTED_AWS_ACCOUNT_ID`, or a malformed ARN |
| `configuration_refused` | a required variable is missing |
| `retention_release_invalid` | version (1–80 chars, `[A-Za-z0-9._-]`), ids, subject or hash malformed |
| `retention_release_self_approval` | service and approver are the same person |
| `retention_service_identity_required` | no active production-bound workforce identity with that person id and subject |
| `retention_approver_required` | approver is not an active workforce person |
| `retention_release_exists` | that version was already used (live or revoked) |
| `retention_release_live` | another live release already names this identity; revoke it first |
| `retention_release_not_live` | `revoke` found nothing live under that version |

Each check runs inside the insert's transaction under a table lock, so two operators cannot release
concurrently. The release module verifies exactly what `retention_sweep_actor()` requires, so a row
that the operator manages to insert is one the sweep will accept; a row it refuses would have been
refused by the sweep too.

## Order of operations for first activation

1. Operating policy approved and its hash recorded in the deployment manifest
   (`retention_schedule_evidence_sha256`). Human decision; not made here.
2. Retention service workforce identity provisioned and its person id, subject and organization id
   recorded. `inspect` should still show `live: 0`.
3. Privacy-operations stack updated with `ExportCleanup*` and `RetentionSchedule*` parameters. The
   function and schedule now exist; every hourly run reports `SweepRefused=1`, `RetentionRefusedAlarm`
   fires. That alarm firing is the expected state between steps 3 and 5 and should be acknowledged as
   such, not silenced.
4. PHI activation of the privacy-operations plane, if and when approved. Until then the sweep reports
   `retention_sweep_configuration_invalid` rather than sweeping, whatever the database holds.
5. `release`. Record the printed JSON (version, service person id, subject, approver, `approved_at`)
   with the deployment evidence.
6. First sweep within the hour: `SweepRefused` drops to 0, `Cleaned`, `CleanupPending`, `Settling`,
   `OldestOverdueSeconds` appear in `ALP/PrivacyExportRetention`; `RetentionRefusedAlarm` clears. Run
   `scripts/run-aws-export-retention-acceptance.ps1` afterwards (with `-QualificationTargetPath`, the
   reviewed qualification target manifest; it never reads a foundation stack for its target): its
   cancelled fixture job should be removed by the sweep once settled, and its report is the first
   hosted evidence. Pass `-ScheduledCleanupWaitMinutes <n>` so the run waits for the schedule itself to
   record that removal and fails if it never comes; without it the scheduled step is skipped rather
   than assumed, because a pending cleanup state is not completed deletion.
7. Any later change of policy, identity or approver: `revoke`, then `release` a new version. Rows are
   never deleted.

## What this does not do

- It does not decide the operating model (scheduled sweep versus the assigned operator's manual
  passes) or the service level; both remain open policy decisions recorded in
  `personal-storage-privacy-export.md`.
- It does not activate PHI, change IAM, create identities or keys, or modify the stack.
- It has not been run against a hosted database. The local run proves the SQL, the module and the
  sweep entry point agree; it does not prove the RDS Data path, the schedule or the alarms.
