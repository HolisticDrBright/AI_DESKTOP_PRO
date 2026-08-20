# AWS production clinical migration status

This is the engineering status of the separate production clinical target. It
does not authorize PHI. Historical App Runner, Fly, and Supabase environments
remain excluded from the PHI route; the synthetic AWS account remains
synthetic-only.

## What is implemented and deployed

- A generated and machine-checked CloudFormation foundation for a dedicated
  `production-clinical` account. Stack
  `ai-longevity-production-clinical-foundation` is `UPDATE_COMPLETE` in account
  `173535830222`, region `us-east-2`.
- Separate rotating KMS keys for application, Aurora, documents, audit, and
  backups.
- Private encrypted Aurora, object-locked/versioned document and CloudTrail
  archives, a dedicated encrypted/versioned AWS Config delivery bucket,
  GuardDuty, Security Hub, Access Analyzer, AWS Backup vault lock, Cognito
  workforce/consumer pools, ECR repositories, and an ECS/Fargate cluster.
- Account and bucket public-access blocking in the guarded deployment workflow.
- An immutable `PhiAllowed=false` foundation output.
- Immutable four-character `custom:production_bound` attributes in both
  production Cognito pools. No production users or approved identities were
  created by the schema update.
- A separate production-only `Dockerfile.production` that accepts no provider
  credentials or staging/synthetic defaults and runs as non-root distroless.
- An encrypted, deletion-protected, point-in-time-recoverable DynamoDB billing
  ledger with a minimum-necessary ECS task role limited to `dynamodb:PutItem`.
- Desktop and patient-API startup guards that refuse a production label if
  Supabase, Fly, or App Runner variables are present, if the AWS adapter is not
  ready, or if PHI activation evidence is absent.
- A migration inventory gate covering both repositories.
- A production readiness gate requiring every named control, runtime boundary,
  and legal/security/clinical/engineering approval. Empty manifests cannot pass.
- A public no-PHI posture response at the stack `PostureUrl` reports
  `clinical-core/2`, `production-clinical`,
  `production_foundation_phi_blocked`, and `phiAllowed=false`.
- A separate private production-readiness stack builds one immutable Desktop
  image from an exact pushed commit, proves the health/refusal boundary in the
  same container, requires a 0 Critical/0 High ECR scan, and then runs exactly
  one Fargate task with `PRODUCTION_WORKLOAD_MODE=readiness_only`,
  `AWS_CLINICAL_ADAPTER_READY=false`, and `PHI_ALLOWED=false`.
- The readiness task has no public IP, load balancer, ECS Exec, secrets, or
  application IAM permissions. It uses private ECR/Logs/S3 endpoints, a
  read-only root filesystem, non-root distroless UID, and encrypted logs.

## Current engineering boundary

The migration inventory now reports zero direct Supabase, Fly, or App Runner
runtime dependencies across the Desktop and mobile App source trees. The mobile
App is AWS-or-fail-closed, and Desktop clinical calls use a Cognito bearer plus
the bounded AWS API Gateway route
`/clinical-core/workforce/data-compatibility`. The retired REST-shaped
transport remains available only to the explicitly enabled loopback contract
fixture and is categorically refused in a deployed process.

This source-level result and the healthy readiness container are not the same
as a functioning production data plane. Production Aurora now contains the
reviewed portable clinical-core schema: 18 application tables and ten
immutable migration-ledger rows, with zero organization, person, patient, lab,
clinical-record, review-queue, or audit rows. The production API that is actually deployed
is a separate Cognito-JWT boundary with no database, secret, S3, or KMS
data-plane permissions; it always returns `503 production_not_activated` after
authorization. Until the required operations are implemented, deployed, and
accepted end to end, clinical features fail closed and
`AWS_CLINICAL_ADAPTER_READY` remains false.

The required compatibility surface is now explicit rather than estimated:
`infra/aws-clinical-core/desktop-compatibility-operations.json` contains 217
RPC functions and five bounded read models used by the live Desktop adapters.
`npm run check:aws-desktop-compatibility-contract` parses the TypeScript call
graph, refuses unreviewed or stale operations, rejects dynamic operation names
outside literal conditionals, and verifies that every RPC has an authored
PostgreSQL definition in the legacy migration history. This proves the port's
scope; it does not claim those definitions are Aurora-portable or deployed.

The authenticated AWS API now also contains the workforce-only
`POST /clinical-core/workforce/data-compatibility` boundary. It validates the
reviewed operation allowlist, rejects cross-organization RPC and read requests,
sets the immutable Cognito-backed request context, and invokes only a registered
uniform database wrapper. Migration `20260821040000` creates that registry and
dispatcher with zero enabled operations. The API role cannot change the
registry. This is intentionally fail-closed until all required wrappers have
been ported and the deployed registry is reconciled to the source manifest.
The production functional candidate currently accounts for twenty operations:
`create_patient_profile`, `review_biomarker`,
`list_patient_lab_observations`, `list_audit_events`,
`record_registered_audit_event`, `list_my_organizations`, `list_org_members`,
`set_org_member_role`, `remove_org_member`, `patient_profiles`, and
`lab_documents`, plus `create_review_task`, `list_review_queue`, and
`resolve_review_queue_item`, plus `get_desktop_calendar`, `book_appointment`,
`update_appointment_status`, `reschedule_appointment`,
`transition_appointment`, and `correct_appointment_status`. The scheduling
operations add tenant-scoped calendar reads, practitioner/patient overlap
locking, an explicit status machine, optimistic versions, idempotent replay,
append-only status history, and admin-only terminal-state corrections. The
two audit operations use a database-owned event registry, bounded scalar
metadata, append-only storage, and workforce/tenant/patient authorization. The
membership operations expose no workforce email/display data, require
owner/admin authorization, preserve the last owner, refuse self-removal, and
suspend rather than delete. Legacy add-by-email and self-activation remain
unported pending governed Cognito identity binding. All 222 inventory entries
remain disabled in the deployed production route, and 202
still need reviewed AWS implementations for full Desktop functionality.

The same candidate now covers the complete 21-route governed
App/Desktop clinical contract for both Cognito pools: invitation and connection,
versioned consent artifacts and grant/withdrawal, lab import/review/read-back,
versioned consumer clinical records, privacy requests, and the bounded Desktop
compatibility route. Its production adapters set `production-clinical`,
`clinical_phi`, and `containsPhi=true` only after the independent activation
gate and a token with `custom:production_bound=true`; a token carrying the
synthetic attestation is refused. Exact source
`c662ffcf844cce89356f809c38cdeb4a8cc1d457` is now deployed behind all 21
explicit JWT routes, but its activation inputs remain false/blocked and the
Lambda role has encrypted-log writes only. It therefore still returns the
bounded 503 before parsing a request or touching Aurora. No PHI data plane is
enabled.

`production-clinical-api-candidate.json` is the in-place deployment definition
for that candidate. Its defaults are `PhiAllowed=false`,
`ActivationState=blocked`, and no activation evidence. In that state its IAM
role contains encrypted-log writes only: Aurora Data API, Secrets Manager, and
KMS decrypt statements are removed by a CloudFormation condition. The guarded
deployment script accepts only the exact pushed commit, the reviewed production
account, and two explicit PHI-disabled confirmations, then verifies the role has
one log-only policy and the function returns bounded 503. The template's future
data-plane condition cannot become true unless PHI, approval state, and a
64-character evidence digest are coherent. Adding this template does not
satisfy or bypass the independent human activation checklist.

Production activation separately requires the
`desktop_compatibility_contract` control and the
`desktop_operations_migrated` runtime boundary to be approved. Neither may be
approved from the existence of the endpoint alone.

The first native compatibility slice is the governed App-to-Desktop lab path.
`list_patient_lab_observations`, `patient_profiles`, and `lab_documents` are
served from the AWS patient, accepted-import, and observation tables rather
than the legacy schema. The deployed synthetic acceptance now verifies import,
duplicate replay, practitioner acceptance, Desktop-formatted read-back,
patient/document lookup, and cross-tenant refusal in 35 authenticated calls.

A dedicated production member account now exists as account `173535830222`.
Account `588966314750` remains synthetic staging and account `449901517958`
remains the management account; both are explicitly refused by the production
deployment script.

The production endpoint registry reserves `desktop.ailongevitypro.app`,
`clinical-api.ailongevitypro.app`, `staff-auth.ailongevitypro.app`, and
`app-auth.ailongevitypro.app`. Public DNS remains inactive until the reviewed
targets and GoDaddy DNS validation records exist.

## Inputs that cannot be invented by engineering

1. A controlled production/root/budget mailbox that is not
   `info@AILongevityPro.app`, with evidence of delivery and retention. The
   address cannot be invented by engineering.
2. A controlled evidence reference showing the AWS Organizations BAA applies to
   the new member account.
3. GoDaddy DNS changes and ACM validation for the four reserved endpoint names.
4. Decisions and agreements for every downstream service that may receive PHI.
5. Named reviewers and timestamps for legal/compliance, security, clinical
   safety, and engineering approval.
6. A documented HIPAA Security Rule risk analysis and risk-management plan,
   incident-response exercise, workforce access reviews, and vendor
   inventory/BAA decisions. Aurora point-in-time recovery has now been tested;
   the remaining recovery controls and incident exercise still require review.
7. Named practitioner decisions for the unresolved governed-catalog label and
   classification review packets. Code must not invent those decisions.

## Required migration sequence

1. Create the empty dedicated AWS account and apply organization controls.
2. Deploy the production foundation with PHI blocked.
3. Replace Supabase Auth with the two Cognito identity planes. (Implemented in
   source; production deployment verification remains.)
4. Port the remaining explicitly allowlisted Desktop API operations to
   Aurora/AWS; do not copy staging snapshots, service-role keys, or synthetic
   identities. The empty portable schema is deployed, but the functional API
   is not.
5. Deploy Desktop and patient API to ECS/Fargate behind reviewed TLS/WAF
   boundaries; remove App Runner and Fly from the PHI route.
6. Run synthetic migration, reconciliation, duplicate/replay, tenant-isolation,
   consent, provenance, clinician-review, backup/restore, and incident tests in
   the exact production configuration. The rollback-only transfer proof and
   Aurora PITR restore have passed; deployment-path and incident exercises
   remain.
7. Complete independent risk, security, privacy, vendor, and clinical reviews.
8. Only after the signed readiness manifest passes may a supervised minimum-data
   pilot be considered. Activation remains a separate, reversible change.

## Safe commands

- `bun run build:aws-production-foundation`
- `bun run check:aws-production-foundation`
- `bun run audit:aws-data-plane-migration`
- `bun run check:aws-production-readiness -- <reviewed-manifest>`
- `npm run check:aws-production-readiness-workload`
- `./scripts/deploy-aws-production-readiness-workload.ps1 -ConfirmPhiDisabled -SourceVersion <full-sha>`
- `./scripts/deploy-aws-production-clinical-api-candidate-disabled.ps1 -ArtifactBucket <reviewed-bucket> -SourceVersion <full-sha> -ConfirmPhiDisabledCandidateDeployment -ConfirmReplaceLogOnlyBoundary`
- `./scripts/run-aws-production-pitr-recovery-exercise.ps1 -ConfirmPhiDisabledRecoveryExercise -OutputPath <controlled-evidence-path>`

The `check:aws-data-plane-migration` command now passes with zero direct runtime
dependency blockers while preserving `phi_allowed=false`. That check proves
provider removal only; it does not prove the missing Aurora operations,
production workload, operational safeguards, or HIPAA compliance.

## Latest production-clinical evidence (2026-08-20)

- Workload stack: `ai-desktop-pro-production-readiness`, `UPDATE_COMPLETE`.
- Exact source: `c606066cf4e2879b535aa491029e6d08711a38cf`.
- ECR digest: `sha256:344e5ff3731877883c482083f8ffacb7bac2269dc5eb188ce074faa595cd987d`.
- Image scan: 0 Critical, 0 High.
- ECS: one RUNNING/HEALTHY task, private address only, no public association.
- Container smoke test: `/api/health` succeeds; normal Desktop traffic returns
  `503` with `production_not_activated` and `phiAllowed:false`.
- Encrypted runtime error search: zero ERROR/Error/FATAL/Exception events.
- Container Insights running-task alarm: `OK`.
- Production Aurora: 20 application tables, 11 migration ledger entries,
  and zero clinical/audit rows.
- The companion AI Longevity Pro V2 patient API readiness service is also
  deployed privately from exact commit
  `a6af612826f9e0e5afa29eefcde72226fc19a25e`; ECR digest
  `sha256:f1f809b9d9f0bb4f5585384066e8aebd11d34bec22678e51b2e97a418e8ef4c7`
  scans at 0 Critical/0 High, its one task is healthy,
  runtime error search is empty, and its running-task alarm is `OK`.

- PHI-disabled API stack:
  `ai-longevity-production-clinical-api-disabled`, `UPDATE_COMPLETE`.
  It is now `UPDATE_COMPLETE` with exact candidate source
  `c662ffcf844cce89356f809c38cdeb4a8cc1d457`. API Gateway exposes exactly 21
  explicit JWT-only routes. Unauthenticated requests return 401; direct or
  authorized execution returns bounded 503. Its Lambda execution role has one
  log-write policy, no attached policies, and no Aurora/secret/KMS data-plane
  permissions. `PhiAllowed=false`, `ActivationState=blocked`, and
  `DataPlaneEnabled=false`.
- Rollback-only clinical acceptance passed connection, explicit lab consent,
  provider registration, import, replay/duplicate protection, clinician
  acceptance, idempotent biomarker review, versioned clinical-record transfer,
  provenance retention, cross-tenant refusal, and 11 audit events. Evidence
  SHA-256:
  `39006ee03d373dd6a7d85050f08809f684e2c77ca876eb6538fbf574262f4d37`.
  The transaction was rolled back and an independent post-check returned zero
  rows.
- Aurora PITR first restored the prior seven-migration state and has now been
  rerun against the current schema. The current exercise restored a private,
  encrypted full copy, independently read 11 migrations, 20 tables, and zero
  clinical/audit/appointment rows in 755.1 seconds, then deleted the exact
  temporary instance and cluster. The production cluster remains encrypted,
  deletion-protected, and configured for 35-day backup retention. Evidence
  SHA-256:
  `98a3183c5f84ef1e5014e3c595cc8b05719064b87aed18295c25e7f9c3a3ed63`.
- The repeatable closed-boundary exercise independently rechecked the account,
  public PHI posture, unauthenticated 401, bounded 503, log-only Lambda role,
  empty 17-table database, `OK` alarm, and zero sensitive-log pattern matches.
  Evidence SHA-256:
  `5b260b5d593fd357c787a53165970c6688c8d76641c430df22aae0db017b7f5a`.
- After deploying the exact closed candidate, exercise version 2 additionally
  verified its source commit, all 21 JWT route definitions, absent wildcard
  routes, both immutable production identity attributes, six explicitly
  managed GuardDuty protection plans, zero unreviewed foundation drift,
  blocked activation, disabled data plane, empty database, `OK` alarm, and
  zero unsafe log matches. Evidence SHA-256:
  `b425616777af158967b80c62b43aee85b21be94ef1e4310dabe19f6cbbb8cc54`.
- The PHI-disabled schema-only operator then added the eighth registered-audit
  migration with zero clinical rows. Exact candidate `954b148` was deployed
  closed and the exercise reverified the 8-migration/17-table empty state,
  immutable identity binding, 21 JWT-only routes, 401/503 refusal, log-only
  IAM, alarm `OK`, and zero unsafe log matches. Evidence SHA-256:
  `d3bb7035ae949bc51ea1eca20a54af5d39cca784fb16d48949bb78ccc9b36b73`.
- It then added the ninth workforce-membership migration with zero rows and
  deployed exact candidate `c4d309f` closed. The exercise reverified the
  9-migration/17-table empty state and all refusal/security invariants.
  Evidence SHA-256:
  `2b1868fadcbad96c2144dc35a7feb40453d6c96f9474a3c51b25dd3ed35886fd`.
- The tenth migration added the encrypted, tenant-scoped review queue with no
  seeded rows, and exact candidate `40dcfb4` was deployed closed. The exercise
  reverified 10 migrations, 18 tables, zero clinical/audit/task rows, and all
  refusal/security invariants. Evidence SHA-256:
  `aa5789c45692cda217b40c7cd12f0ab09bd72d5fd0ad3f27a4238beeb1ab0e87`.
- The eleventh migration added encrypted, tenant-scoped scheduling and
  append-only appointment-status tables with no seeded rows. Exact candidate
  `c662ffc` was deployed closed. The exercise reverified 11 migrations, 20
  tables, zero clinical/audit/appointment rows, all 21 JWT-only routes, 401/503
  refusal, log-only IAM, alarm `OK`, and zero unsafe log matches. Evidence
  SHA-256:
  `8e47401874e1f3de6cb3c5f2c7813a3ef040da2b1a0fdb2eda982f44ade6b3ad`.

CloudFormation drift detection reports only three GuardDuty service-returned
result fields as additions: disabled `AI_ANALYST`, disabled `AI_PROTECTION`,
and disabled `EKS_RUNTIME_MONITORING`. The latter cannot be declared alongside
enabled `RUNTIME_MONITORING`; the exercise allows exactly these three disabled
results and fails for every other resource or property difference. The six
managed production plans—S3 data events, EKS audit logs, EBS malware
protection, RDS login events, Lambda network logs, and Runtime Monitoring—are
all declared and live-enabled.

This evidence closes the exact-image/private-compute proof, portable empty
schema proof, rollback-only minimum patient/lab transfer semantics, tenant
isolation, and Aurora PITR proof. It does not authorize PHI and must not be
represented as a live clinical application, HIPAA certification, or a complete
port of the Desktop's 222-operation surface.
