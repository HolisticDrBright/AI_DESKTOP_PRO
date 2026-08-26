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
The production functional candidate currently accounts for 32 operations:
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
encounter and note operations add start/complete/cancel/error transitions,
bounded encounter/note/timeline reads, optimistic draft versions, SHA-256-bound
signatures, idempotent signing, frozen signed content and provenance, and
append-only addenda through `start_encounter`, `set_encounter_status`,
`save_note_draft`, `mark_note_ready`, `sign_note`, `add_note_addendum`,
`mark_note_error`, `get_desktop_encounter`, `list_desktop_patient_encounters`,
`get_desktop_note`, and `get_desktop_patient_timeline`. The two audit
operations use a database-owned event registry, bounded scalar
metadata, append-only storage, and workforce/tenant/patient authorization. The
membership operations expose no workforce email/display data, require
owner/admin authorization, preserve the last owner, refuse self-removal, and
suspend rather than delete. Legacy add-by-email and self-activation remain
unported pending governed Cognito identity binding. The bounded
`get_patient_overview` aggregate then combines only verified AWS
demographics, care-team roles, appointments, encounters, labs, and review tasks;
it returns contact-presence flags instead of contact values and explicitly
labels allergy, medication, and problem lists as unrecorded until governed
write contracts exist. The connection-control slice adds a ten-character,
single-use invitation code whose SHA-256 hash alone is stored, optimistic
pause/resume/revoke transitions, automatic consent withdrawal on connection
revocation, approved-artifact-only consent grants (including
`lab_results_import`), and tenant-scoped Desktop connection/operations views.
All 222 inventory entries remain disabled in the deployed production route,
and 183
still need reviewed AWS implementations for full Desktop functionality.

The same candidate now covers the complete 21-route governed
App/Desktop clinical contract for both Cognito pools: invitation and connection,
versioned consent artifacts and grant/withdrawal, lab import/review/read-back,
versioned consumer clinical records, privacy requests, and the bounded Desktop
compatibility route. Its production adapters set `production-clinical`,
`clinical_phi`, and `containsPhi=true` only after the independent activation
gate and a token with `custom:production_bound=true`; a token carrying the
synthetic attestation is refused. Exact source
`f4611c664e3e808c6b3c1f67e28c839cfede4801` is now deployed behind all 21
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
   address cannot be invented by engineering. Live AWS Budgets inspection on
   2026-08-20 found the healthy `$100` production budget but zero configured
   notifications/subscribers; alert delivery must be added and verified once
   the controlled address is supplied. The ignored local synthetic deployment
   manifest now contains only `REPLACE_WITH_CONTROLLED_BILLING_EMAIL`.
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
- Production Aurora: 26 application tables, 15 migration ledger entries,
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
  `f4611c664e3e808c6b3c1f67e28c839cfede4801`. API Gateway exposes exactly 21
  explicit JWT-only routes. Unauthenticated requests return 401; direct or
  authorized execution returns bounded 503. Its Lambda execution role has one
  log-write policy, no attached policies, and no Aurora/secret/KMS data-plane
  permissions. `PhiAllowed=false`, `ActivationState=blocked`, and
  `DataPlaneEnabled=false`.
- Rollback-only clinical acceptance passed the ten-character invitation code,
  connection claim and optimistic pause/resume, approved Desktop consent,
  bounded sync posture reads, revoke-with-consent-cascade, explicit App lab
  consent, provider registration, import, replay/duplicate protection,
  clinician acceptance, idempotent biomarker review, versioned clinical-record
  transfer, provenance retention, cross-tenant refusal, and 13 audit events.
  Current evidence SHA-256:
  `fadeb920f20271f930b114e7ef7594e473a69e50183b3db5ef84ccf1b8f95587`.
  Earlier core-transfer evidence SHA-256:
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
- The twelfth migration added encounters, clinical notes, immutable note
  versions, SHA-256-bound signatures, append-only addenda, and governed
  provenance with no seeded rows. Exact candidate `98b4233` was deployed
  closed. The exercise reverified 12 migrations, 26 tables, zero clinical,
  note, signature, addendum, provenance, or audit rows, plus all JWT/IAM/log
  refusal invariants. Evidence SHA-256:
  `b3843bd16da82f449bc7fbcf21af5fb68e60e916318ebd5fe913e06598e44d00`.
- The thirteenth migration added the bounded, read-only patient overview with
  no new table or row. Exact candidate `31e904e` was deployed closed. The
  exercise reverified 13 migrations, 26 tables, zero clinical/audit rows, and
  all JWT/IAM/log refusal invariants. Evidence SHA-256:
  `c27861202656da4df5e65f1fc9ca7f73d68237469fd381389bdd5010de4dac9f`.
- The fourteenth migration added the governed Desktop-side connection control
  plane without adding a table or row: ten-character one-time invitation
  codes with hash-only storage, versioned pause/resume/revoke, automatic
  consent withdrawal on revocation, approved-artifact-only scoped consent,
  and tenant-bounded sync posture reads. Seven additional Desktop operations
  are therefore implemented but activation-blocked (39 total; 0 enabled).
  Exact candidate `c2ec3e5` remains closed. The exercise reverified 14
  migrations, 26 tables, zero clinical/audit rows, 21 JWT-only routes,
  401/503 refusal, log-only IAM, alarm `OK`, and zero unsafe log matches.
  Evidence SHA-256:
  `5be0b5e7bbc850ec774f1096561db15a3e345c0760d2468031dcea2ba1d25bbd`.
- The rollback exercise then found that the empty search path in the
  security-definer invitation function correctly blocked unqualified pgcrypto
  lookups. The fifteenth immutable repair migration qualified only those two
  extension calls while retaining the empty search path. Rollback acceptance
  then passed every connection/consent/transfer invariant and retained zero
  rows. Exact candidate `f4611c6` remains closed; the exercise reverified 15
  migrations, 26 tables, zero rows, 21 JWT-only routes, 401/503 refusal,
  log-only IAM, alarm `OK`, and zero unsafe log matches. Evidence SHA-256:
  `2b1eff659d9d9469f21c4f07ef995037c75ff73d685a0acc7e2e0f05185fe078`.
- Point-in-time recovery restored the current empty 15-migration schema into
  a private encrypted full-copy cluster and independently verified 26 tables
  and zero clinical/audit rows in 691.1 seconds. The exact temporary writer
  and cluster were deleted afterward; the protected production cluster remains
  encrypted, deletion-protected, and configured for 35-day backup retention.
  Evidence SHA-256:
  `ebbe679d77f940499fd99c5fdf78cbd8fe9d3458bd0d47bc0e5e34d109afed3f`.
  Snapshot/object/Cognito/application rollback and the incident tabletop
  remain open.

## Patient protocol production schema (2026-08-24; PHI disabled)

The current Desktop branch adds a sixteenth immutable migration with four
tenant-scoped protocol tables and seven AWS-native operations:
`get_patient_protocol`, `create_protocol_draft`, `save_protocol_draft`,
`approve_protocol_version`, `activate_protocol_version`,
`set_protocol_lifecycle`, and `revise_protocol_version`. The generated
inventory now records **46 implemented but activation-blocked operations, zero
enabled, and 176 not ported** out of the fixed 222-operation surface.

The candidate keeps approved/active versions immutable, uses optimistic draft
concurrency, records bounded audit events, separates approval from explicit
activation, and cannot create orders, messages, charges, prescriptions, or
signed notes. Commercial destinations are refused. Product entries are saved
as unverified and any product-bearing protocol remains unapprovable until the
governed production catalog supplies server-verified product evidence. This
allows non-product diet, lifestyle, monitoring, and follow-up plans to use the
governed lifecycle without accepting client-asserted supplement verification.

The guarded PHI-disabled operator applied migration 16 to production Aurora.
The live database now has 30 application tables, nine production contracts,
and zero clinical/audit rows. Closed-boundary exercise v3 independently
confirmed the empty database, 21 JWT-only clinical routes, unauthenticated 401,
bounded 503 refusal, log-only IAM, zero unsafe log matches, `PHI_ALLOWED=false`,
`ActivationState=blocked`, and `DataPlaneEnabled=false`. Evidence SHA-256:
`0a58965d459470f961acd4c78b84b5c740c4a38da3e4bb5f95dfd85f119ec8ee`.
All 222 operations remain disabled in the deployed route.

## Durable patient-sync delivery controls (2026-08-25; PHI disabled)

Migration 17 adds six empty, tenant-scoped tables for outbound events, inbound
review events, append-only corrections, dead letters, conflicts, and resource
acknowledgements. Seven Desktop operations are now AWS-native: queue export,
queue withdrawal, retry, cancel, accept/reject inbound, record a bounded
correction overlay, and resolve a conflict with optimistic concurrency. The
inventory is **53 implemented but activation-blocked, zero enabled, and 169
not ported** out of 222.

Exports are limited to server-built approved protocol versions without product
items, minimum-necessary appointment summaries, and aggregate laboratory
summaries. An active reviewed provider, verified connection, and current scope
consent are required. Consent revocation cancels pending events. Clinical
payload, correction reason, and review note content never enters the audit
stream. Inbound acceptance records review only and explicitly does not
materialize chart data.

The guarded operator applied the empty migration to production Aurora. Live
state is 17 migrations, 36 application tables, 16 counted contracts, and zero
clinical/audit/sync rows. The delivery worker and provider registration remain
absent, every functional route remains disabled, and the service still reports
`PHI_ALLOWED=false`, `ActivationState=blocked`, and `DataPlaneEnabled=false`.
Closed-boundary evidence SHA-256:
`b1caf7acab662562816890239b6d0988035e08a739e28cac25f91dc3b4bb7192`.

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

## AWS-native patient-sync worker and reviewed materialization (2026-08-25; PHI disabled)

Migrations 18 and 19 add the inactive production worker contract and an
immutable lab-summary timestamp repair. Six empty tables now retain delivery
attempts, provider evidence, PHI-free worker cycles, circuit state, callback
nonces, and inbound-to-lab links. Aurora has **42 application tables, 19
migrations, 25 counted contracts, and zero clinical/audit/sync rows**.

Provider registration is a two-step admin workflow: registration always lands
in `pending_review`; a version-matched review is required before the provider
can become active. The worker is a dedicated no-login database role. It leases
bounded batches with `FOR UPDATE SKIP LOCKED`, re-checks provider, connection,
and consent at delivery time, records provider evidence, backs off retryable
failures, dead-letters permanent failures, and rejects callback replay.

The signed inbound `lab-result/1` contract carries a panel plus bounded marker
rows. Receipt requires a verified connection, active reviewed provider, and
current `lab_results_import` consent. Exact provider-event replay is
idempotent; a changed hash conflicts. Receipt creates review work and no chart
observation. Only explicit clinician acceptance creates governed observations
with App source, external panel/marker identifiers, resource version, payload
hash, accepting clinician, and acceptance time.

Rollback-only production acceptance proved provider registration/review,
outbound lease/recheck/delivery/ack, nonce replay refusal, inbound lab receipt,
duplicate protection, clinician materialization, provenance, and tenant
isolation. All synthetic rows were rolled back. Evidence SHA-256:
`7781bf21dce29358b276a90b449112ba69a09e08f910fc95ce814176711cc25e`.
The independent empty-boundary check then reconfirmed 19 migrations, 42 tables,
zero rows, PHI false, activation blocked, log-only deployed API permissions,
and bounded 401/503 refusal. Evidence SHA-256:
`559fc3dda9145cc00ae6f0099a8ea2f18551b5a581305a50d79674896aeaa6ed`.

The production sync Lambda/CloudFormation candidate was deployed from exact
pushed commit `7bea773e4473d4293a0db3a2327b3a1998f2383d` as stack
`ai-longevity-production-patient-sync-disabled`. Artifact SHA-256:
`e4663a496e12fb5ffadbf9a848ba93435799a405dfb70194d1d34d989ff5ea55`.
The stack is `CREATE_COMPLETE`, but deliberately inert: PHI false, activation
blocked, schedule disabled, provider URL disabled, placeholder secret marked
unconfigured, and log-only IAM with no database, Secrets Manager, or KMS data
permissions. The HMAC callback returns bounded `503
production_not_activated`. No provider was registered and no PHI was enabled.

The repeat point-in-time recovery exercise restored the current empty
19-migration/42-table schema into an isolated private copy, independently
verified it, and deleted the exact temporary writer and cluster. Evidence
SHA-256:
`043d1e7e22880b7ec9a6ff1b810b85c4d58e07295ff29c45b19fb1a47f9d65e4`.
PR #41 head `7bea773e4473d4293a0db3a2327b3a1998f2383d` passed every GitHub CI and
browser check. These are closed-boundary and recovery proofs only; they do not
authorize PHI or activate the provider.

## Governed product and protocol-template catalog (2026-08-25; PHI disabled)

Production migration `20260826100000` adds an empty, reference-only catalog in
the dedicated `clinical_reference` and `commercial_reference` schemas. Aurora
now has 22 migration-ledger entries plus eight clinical-reference tables and
two isolated commercial tables. No product, template, offer, verification, or
review row was seeded or retained.

Seven Desktop operations are now AWS-native and activation-blocked:
`get_product_catalog`, `get_product_label_detail`,
`verify_product_label_version`, `get_protocol_template_detail`,
`compare_protocol_template_versions`,
`record_protocol_template_safety_review`, and
`supersede_protocol_template`. The inventory is **61/223 implemented, zero
enabled, and 162 not ported**.

Catalog and template versions are immutable. Clinical payloads reject
commercial destinations and tracking fields. Commercial offers remain in a
separate schema and cannot affect clinical eligibility, ranking, safety, or
evidence. Named owner/admin review is required for verification and template
safety actions; a passed safety review is refused for an unsourced dose;
supersession preserves prior versions and refuses cycles. This phase does not
import or approve Claude's governed package, resolve the eight practitioner
decisions, or permit product-bearing patient protocols.

The deployed rollback-only exercise proved all seven functions plus the
existing App-to-Desktop sync contract, then rolled every temporary row back.
Evidence SHA-256:
`5300158382e7a9be7435d69e76f2f239ad8e2b4f90c76e5d13b075386f9274ab`.
An independent query confirmed zero rows across all ten new tables. Local
verification passed 945 unit tests with 10 intentional skips and the complete
210-page clinical build. `PHI_ALLOWED=false`, the private production API, and
all human activation gates remain blocked.
