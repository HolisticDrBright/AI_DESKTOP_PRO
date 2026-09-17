# Independent production voice-processing candidate

September 17 follow-up: `personal-voice-deletion-holds.md` describes the concrete
database guard on provider/object deletion and cleanup receipts, including drain.
Production native TTL/lifecycle deletion is removed; synthetic expiry is unchanged.
The candidate now requires a reviewed SecretKmsKeyArn for database-secret access.

September 15, 2026. Original phase2, not a new/completed phase.
Desktop **4a0080f01f46819911b029172929fa51d93cc041**;
V2 **48ba65a48a78e703ab10d2e0c74530fea459f7da**.
Source only: no deployment, persistent migration, real data or paid mobile build.

Release follow-up: GitHub CI now explicitly builds and CloudFormation-lints the
generated independent voice template, in addition to its unit/build refusal tests.
This closes a schema-validation coverage gap; it does not deploy or prove provider
acceptance. The generated template remains default-blocked.

## Implemented

- Dedicated production handler on the existing consumer voice-job contract. Gateway
  verifies JWT signatures; code checks exact consumer issuer/audience, expiry,
  verified email, production binding and active database identity. Synthetic,
  workforce and unverified claims refuse. No clinic membership is inferred.
- Separate voice_transcription and ai_context server consent. No reviewed release
  or grant is seeded. Jobs bind server-derived owner/person/organization, consent
  revisions, release versions and exact content hashes. Request bodies cannot inject
  approval/identity. Regrant or same-version copy changes do not revive old recordings.
  Database JSON map ordering does not break identical retries.
- Checks before upload/dispatch/transcript retrieval and again before response.
  Lost consent/identity stops work; database outages retry without falsely claiming
  revocation or cleanup. In-progress provider work cannot be instantly interrupted:
  results stay withheld and cleanup waits for terminal provider status. This is
  not an atomic transaction across a consent database and external provider.
- Server Core entitlement check on creation. Owner cancellation is not paywalled
  and does not require consent regrant. Removing feature scopes while retaining
  the deployed service still permits cancellation/cleanup.
- Durable idempotency/leases, bounded audio size,15-minute readable lifetime and
  retry sweep retained. Separate production object/job namespaces. Cleanup removes
  exact audio/transcript versions and delete markers, refusing unexpected keys and
  partial failures. Cleaned-job metadata stays on a retained retry watch; backups/audits are not
  claimed erased. Scheduled failures throw sanitized errors so alarms can fire.
- V2 checks both owner-specific server consents before capture and upload; Personal
  data storage provides review/history/withdrawal. No bundled approval/automatic
  grant. Users still review transcription before Send.

## Deployment and verification

`node scripts/build-aws-owned-voice.mjs` builds Lambda and a candidate template.
Default PHI false, activation blocked, no scopes, logs-only IAM, disabled sweep.
Activation requires review/provider evidence hashes, database/billing configuration,
explicit scopes and alarm recipient. Hashes alone do not verify agreements or
constitute signatures. Candidate includes encrypted versioned objects, retained
DynamoDB/PITR/index/TTL,3JWT routes, scoped data permissions, concurrency cap and
error alarm. Transcript output explicitly selects KMS encryption; see
[AWS encryption documentation](https://docs.aws.amazon.com/transcribe/latest/dg/data-encryption.html).

- Desktop **1548 passing /11 existing skips**,33 added tests; typecheck, lint
  (zero errors/four existing warnings), builds, infrastructure validation and
  built-handler PHI-false refusal smoke passed. Existing synthetic voice checks pass.
- V2 **976 passing /one existing hosted skip**,9new tests; typecheck/lint,
  source226files/capability gates and patient-API PHI-false build/smoke passed.
- **72 rollback-only Aurora assertions passed**, including11additional voice
  checks through actual handler/adapter/Data API/database. Missing approval,
  grant/withdrawal/regrant, isolation and cleanup authority tested. Voice storage,
  provider and entitlement components are doubles: not a production transcription,
  payment or device test. No retained schema/identities/fixture rows.
- Fixed release-packaging omission: privacy migration20260916010000 existed but
  was absent from manifest. Registered it and voice consent20260916020000.
  **51 source migrations**, zero seeded rows; release SHA256
  **ffdda6dea5f627b14914d012df97b426567f794ba5e536df545a4ff222e9f9ee**.
  Unregistered SQL now fails build. A temporary omitted-file negative fixture
  triggered the real failure; fixture removed and clean build passed.

## Still required

Production-owned lab/document processing and authoritative delivery; real voice
deployment/provider/payment acceptance; load/abuse qualification; complete job/read
auditing and account privacy across metadata/audio/transcripts/identity/backups;
crash/restart/two-device/native testing; global-shutdown drain/recovery.
The template disables scheduling/data IAM when globally blocked: that switch is
not erasure of outstanding objects. A separate reviewed cleanup-only drain is
now implemented; see production-voice-shutdown.md for its limits and operator
sequence. Retention/lifecycle/PITR policy, reviewed
consent releases, applicable agreements, production configuration and operational
alarm owner must be verified before activation. No approval was invented.

PostgreSQL guidance preserved owner checks/RLS/restricted grants; React guidance
kept app actions explicit and account-bound. Hosted lab883623f, web4ffd5f2 and
installed V2 unchanged. All six original phases remain partial/incomplete.
