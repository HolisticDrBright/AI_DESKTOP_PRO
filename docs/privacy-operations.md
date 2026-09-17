# Assigned workforce privacy operations

September 17, 2026. Source/release candidate, **not deployed or PHI-enabled**.

## Delivered

Settings → Privacy operations opens a paginated, explicitly loaded queue of
consumer correction/deletion requests. The request ID is the review handle;
there is no caller-selected owner, automatic clinic connection, or self-grant.
Ordinary organization membership does not authorize these records.

The dedicated POST /clinical-core/workforce/privacy-operations endpoint accepts
list, detail, resolve, previewPersonalPurge and purgePersonal commands. The
last two additionally require separate purge activation. It requires API Gateway-verified
workforce ID-token claims, verified email, production identity binding and an
auth_time within 15 minutes. Consumer/synthetic tokens, wrong issuer/audience,
expired sessions and owner overrides are refused. The configured workforce
pool's required MFA must be independently reviewed before activation; a token
refresh is not a new login. The DB rechecks active identity and an unexpired,
non-revoked, separately reviewed operator/owner assignment on every detail and
resolution. No assignments are seeded.

The additive production overlay provides an assigned queue and field-limited
correction detail. Detail shows the original/requested/current value, exact
revision target and explanation—not unrelated intake or laboratory fields.
Audited reads carry the operator and request ID; API access cannot modify audit
rows. Keyset pages are current views, not immutable export snapshots.

Applied correction decisions call the existing exact-successor verifier in the
same transaction as the returned detail. They never edit clinical content.
Declined decisions require an explanation visible to the consumer. Exact retries
are idempotent; changed decisions conflict. Holds remain authoritative. Legacy
unbound requests cannot be completed here. Deletion receipts are visible; the
separately gated action below deletes only personal storage and never attests
whole-account completion.

## Preview-bound personal deletion

An assigned operator supplies an existing, reviewed policy version. The policy
must have a personal_purge_authorized_sha256 matching its verified content hash;
generic retention approval alone is insufficient. No policy authorization is
seeded. Preview returns the full policy, exact counts and an inventory hash for
personal record versions, storage consents, active plans and adoption history.
It includes historical/deleted record versions, not merely currently visible rows.

The operator must type PURGE PERSONAL HISTORY. Execution is bound to that request,
policy hash, inventory hash and unique command ID. Inside one transaction it
rechecks operator assignment, current identity, legal holds and policy validity
under the same owner lock used by writers. Changed inventory or policy refuses.
Deletion, empty-store verification, store evidence and an immutable command
receipt are atomic. An exact retry returns its historical receipt and does not
delete newly written rows. Changed command content conflicts. The UI preserves
the command after an uncertain response, but requires a new confirmation after
a new preview. Confirmation and review data clear when the page becomes hidden.

The old direct purge function is no longer executable by the API role. Generic
completion still checks all nine stores and now rechecks current personal-store
counts before accepting purged/not-applicable receipts. Fresh rows roll completion
back; current reviewed retention may explicitly account for retained rows. An
older purge receipt is not proof that later data was removed.

This does not delete lab jobs/documents, voice jobs/transcripts, identity,
clinic records, device copies/recovery archives, backups or audit/request records.
Those stores remain separate fulfillment and retention obligations. Oversized
inventories refuse rather than silently truncate. Distributed concurrency and
large-history performance still require hosted verification.

The Next route validates its own session and exact Origin and forwards only to
CLINICAL_AWS_PRIVACY_OPERATIONS_ORIGIN (HTTPS API Gateway origin). Responses are
no-store, error text is bounded, credentials/data are not logged, and the page
has a same-origin CSP. Review state is not persisted and is cleared on
visibility loss/navigation; late requests are aborted/ignored. Decisions require
an explicit confirmation, never an effect-triggered submission.

## Deployment artifact

node scripts/build-aws-privacy-operations.mjs emits the Lambda and
dist/aws-clinical-core/privacy-operations/template.json. Its single route uses a
dedicated workforce JWT authorizer. PHI=false and activation=blocked by default;
database permissions are conditional on activation, activation evidence,
database review, workforce MFA review and an alarm destination. Code is bound
to a versioned object and source commit. Logs are encrypted/retained; data IAM
is account/resource scoped. There is no S3 object deletion, Cognito deletion,
wildcard data permission, automatic migration or account assignment.
PersonalPurgeEnabled defaults false, separately from queue activation, and
requires PersonalPurgeEvidenceSha256 plus the existing activation prerequisites.
Corresponding runtime settings are PERSONAL_PURGE_ENABLED and
PERSONAL_PURGE_EVIDENCE_SHA256. These settings do not grant DB policy approval.

## Verification and limits

- All 61 production migrations executed in isolated PGlite PostgreSQL with
  fictional records. Tests cover assigned pagination, cross-owner/consumer
  denial, revocation recheck, immutable access audit, field minimization and
  API → adapter → SQL → verified correction and personal-purge responses,
  including replay, stale previews, new data after purge, holds, policy/authority
  revocation, immutable receipts and transactional completion rollback.
- API/Next/client tests cover activation, fresh workforce login, owner
  overrides, origin checks, response shape and sanitized failure paths.
- Deployment candidate builds, passes CloudFormation schema validation, and its
  bundled blocked handler refuses without database configuration/credentials.
- Browser tests use **fictional intercepted HTTP responses**, not a hosted
  clinical backend: sign-in refusal vs empty, exact-field review with explicit
  decision confirmation, held-request refusal, state clearing and CSP headers.
  Five browser tests now also cover exact purge confirmation, uncertain-response
  command reuse and stale-preview invalidation. The screenshot was inspected.
  Actual API/SQL verification is separate; this is not a single deployed E2E run.
- Full local Desktop suite: 1,937 passed, 11 existing skips with maxWorkers=2.
  Initial targeted API/database/client/Next/contract/infrastructure checks: 113
  passed; two more SQL regressions then passed and are included in the full run.
  The 36 privacy SQL cases also prove unchanged-count inventory changes refuse
  and a command-receipt insertion failure rolls deletion/store evidence back.
  Typecheck, changed-file lint and CloudFormation schema validation pass.
  No hosted deployment or physical-device test is claimed.

## Still required

Deploy the exact reviewed SQL/API/Desktop candidates in an isolated synthetic
environment, bind the separate workforce origin, and execute authenticated
hosted/physical checks. AWS CLI authentication is currently expired. Production
requires reviewed activation/MFA/database/assignment evidence, not merely
working credentials. This turn did not change any deployment flags.

Engineering still includes operator-led cross-store deletion fulfillment,
large/history privacy workflows, structured/domain correction edits and their
downstream propagation, guardian operations, and the other original account,
processing, clinical, commerce and release requirements. This queue is not
evidence that all six original commercial-readiness phases are complete.
