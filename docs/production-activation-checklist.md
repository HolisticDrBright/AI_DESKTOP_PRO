# Production activation checklist

No item in this document is implied complete by synthetic acceptance. Production and PHI remain disabled until every blocking item is checked, evidenced, and signed by the named owner.

## 1. Legal and vendor agreements

- [ ] Verify the AWS Organizations BAA is `Active` in the management account and applies to the intended production member account. Save the agreement and record account IDs, effective date, and reviewer.
- [ ] Update the reviewed deployment manifest only after that independent verification; two-person review required.
- [ ] Execute and archive BAAs or equivalent approved terms for every vendor that may receive PHI, including Junction, Passio, AI providers, communications, observability, support, and backups.
- [ ] Confirm every selected AWS service is on the current HIPAA-eligible services list.
- [ ] Approve privacy policy, Notice of Privacy Practices, Terms, consent language, data-processing inventory, retention schedule, breach-response procedure, and subcontractor list with qualified counsel/compliance review.

## 2. Isolated production account

- [ ] Create a new production AWS member account. Do not restore, copy, or promote the synthetic staging database or snapshot.
- [ ] Use IAM Identity Center for human access; require phishing-resistant MFA where supported. No shared users or long-lived administrator access keys.
- [ ] Establish break-glass access with sealed credentials, alerts, quarterly test, and documented revocation.
- [ ] Apply organization SCPs that restrict regions, public storage, unencrypted resources, CloudTrail changes, and unsupported services.
- [ ] Create separate KMS keys for database, objects, logs, and backups with rotation and least-privilege key policies.
- [ ] Configure budgets and anomaly alerts. Cost limits must alert but must not disable security, audit, backup, or availability controls.

## 3. Production infrastructure

- [ ] Deploy reviewed templates from source to the empty production account; never hand-create mutable production resources.
- [ ] Aurora: private networking, TLS, encryption, Data API/IAM boundary as reviewed, deletion protection, PITR, backup retention, and maintenance windows.
- [ ] S3: block public access at account and bucket levels, KMS encryption, versioning, lifecycle/retention, access logging where appropriate, and malware/quarantine workflow for uploads.
- [ ] Cognito: separate workforce and consumer pools, custom domains, verified redirect/logout allowlists, strong password policy, workforce MFA, account-recovery review, token lifetimes, and threat protection/rate limits.
- [ ] API Gateway/Lambda: WAF/rate limits, exact JWT issuers and audiences, payload limits, manual redirect refusal, concurrency/cost limits, encrypted bounded logs, alarms, and no request/response body logging.
- [ ] CloudTrail organization trail, AWS Config, GuardDuty, Security Hub, IAM Access Analyzer, and actionable alarms routed to an owned on-call channel.
- [ ] Confirm no secrets, tokens, raw clinical payloads, or identifiers enter source maps, logs, analytics, crash reporting, traces, support systems, or CI artifacts.

## 4. Application identity federation

- [ ] Implement Desktop sign-in with the workforce Cognito pool and V2 sign-in with the consumer Cognito pool; do not exchange or reinterpret Supabase tokens as Cognito tokens.
- [ ] Bind users only through immutable Cognito `sub` plus governed person/organization records. Never match by email, phone, name, or date of birth.
- [ ] Implement invitation claim, account recovery, organization switching, role changes, offboarding, consent withdrawal, and session revocation end to end.
- [ ] Add CSRF protection, secure/httpOnly/SameSite cookies where applicable, mobile secure storage, device/session inventory, reauthentication for sensitive actions, and bounded refresh-token handling.
- [ ] Prove workforce tokens cannot call consumer routes and consumer tokens cannot call workforce routes in production configuration.

## 5. Authorization, consent, and clinical safety

- [ ] Re-run role and tenant matrix for practitioner, staff, coach, billing, patient, and platform operations.
- [ ] Re-run cross-tenant tests for reads, writes, exports, uploads, search, background jobs, caches, logs, and connector callbacks.
- [ ] Verify consent version, scope, representative authority, grant, expiry, and withdrawal at delivery time, not only when work is queued.
- [ ] Verify append-only audit events for authentication, chart access, changes, exports, consent, connectors, administrative actions, AI runs, and emergency access.
- [ ] Keep AI output as unsigned drafts with citations, provenance, safety state, model/version, input/output hashes, and practitioner disposition. No autonomous signing, ordering, billing, messaging, diagnosis, or protocol activation.
- [ ] Complete clinical safety review, red-team testing, prompt-injection tests, hallucinated-citation refusal, interaction-check posture, and rollback/kill switch.

## 6. Junction and Passio activation

- [ ] Create durable, versioned connector-registry records. Environment variables and credentials are configuration only.
- [ ] Record security review, BAA state, approved editions, approved data classes, exact purposes, allowed regions/origins, retention, and reviewer.
- [ ] Require user consent at request time and re-check it before every delivery or provider call.
- [ ] Junction: synthetic sandbox test with opaque IDs, webhook signature/replay tests, minimum scopes, deletion/disconnect, backfill bounds, and data-provenance review.
- [ ] Passio: synthetic food/image test with no person identifiers, raw-image retention decision, human confirmation, provenance, no invented nutrient fallback, and deletion workflow.
- [ ] Confirm vendor request/response bodies are not logged and that vendor errors cannot echo submitted content to users or logs.
- [ ] Activate one connector and one organization at a time behind a reversible governed approval. Monitor before widening.

## 7. Backup, recovery, and incident readiness

- [ ] Run production-account backup and restore rehearsal with synthetic data before PHI activation; document RPO/RTO and actual timings.
- [ ] Test PITR, encrypted snapshot restore, object-version recovery, Cognito configuration recovery, key access, and application rollback.
- [ ] Verify backup immutability/cross-account strategy and deletion/retention policy with counsel.
- [ ] Run lost-device, compromised account, leaked token, malicious insider, vendor outage, data-integrity, ransomware, and breach-notification tabletop exercises.
- [ ] Confirm incident contacts, escalation clock, evidence preservation, customer communication, regulatory notification, and vendor coordination.

## 8. Final activation gate

- [ ] Independent security review and vulnerability remediation complete.
- [ ] Accessibility, reliability, load, abuse, privacy, and clinical workflow acceptance complete.
- [ ] Synthetic end-to-end tests pass in the exact production build and configuration with zero real patient data.
- [ ] No open critical/high security findings; accepted residual risks have owner, rationale, and expiry.
- [ ] Legal/compliance, clinical safety, security, engineering, and business owners sign the production change record.
- [ ] Activate a supervised internal pilot with minimum data and immediate rollback; expand only after an observation period and documented review.

## Current verified posture as of 2026-08-20

- The AWS Organizations Business Associate Addendum is active with an effective date of August 18, 2026. This closes the AWS agreement prerequisite only; it does not approve the application or account configuration for PHI.
- Account `588966314750` remains the synthetic-staging account. Dedicated production account `173535830222` was created empty with `PhiAllowed=false`; no clinical data was copied into it.
- The fail-closed production foundation stack is deployed in account `173535830222`, region `us-east-2`, and is `UPDATE_COMPLETE`. Its live posture response reports `clinical-core/2`, `production-clinical`, `production_foundation_phi_blocked`, and `phiAllowed=false`. The management and synthetic account IDs are refused by the deployment guard.
- The production foundation has private encrypted Aurora, immutable document and CloudTrail archives, a separate encrypted/versioned AWS Config delivery bucket, active Config recording, GuardDuty, Security Hub, Access Analyzer, account/bucket public-access blocks, and a locked backup vault.
- Desktop production source now uses workforce Cognito and the AWS clinical API boundary; V2 production source uses consumer Cognito and is AWS-or-fail-closed. The cross-repository migration gate reports zero direct Supabase, Fly, or App Runner runtime blockers. Historical transition data still requires rotation/redaction, retention, and deletion decisions.
- Exact-commit Desktop and patient-API readiness images are in production ECR and both scan at 0 Critical/0 High. Two private ECS tasks are RUNNING/HEALTHY with no public ingress, secrets, or application IAM permissions. They permit only health checks and return 503 for all normal traffic; `AWS_CLINICAL_ADAPTER_READY=false` and `PHI_ALLOWED=false`.
- Production Aurora contains the reviewed portable empty clinical core: 18 application tables, ten migration-ledger entries, and zero clinical/audit/task rows. A separate deployed JWT API has no clinical data-plane permissions and always fails closed. Fourteen patient/lab/audit/workforce/review-queue operations have an activation-gated source implementation, but all 222 inventory entries remain disabled in the deployed route and 208 still need reviewed AWS implementations for full Desktop functionality. Legacy workforce add-by-email and self-activation remain refused pending governed Cognito identity binding.
- Exact candidate source `40dcfb48597b145f546415eae96c3fa1aa1c69a4` now implements all 21 governed App/Desktop JWT routes against production-specific consent, lab, clinical-record, privacy, and Desktop adapters. It requires both correct Cognito pools, `custom:production_bound=true`, no synthetic attestation, `PHI_ALLOWED=true`, approved activation state, and a 64-character evidence hash. The deployed stack remains `PhiAllowed=false`, `ActivationState=blocked`, and `DataPlaneEnabled=false`, so every functional route returns bounded 503 and cannot access Aurora.
- Both production Cognito pools now contain the immutable `custom:production_bound` schema attribute, but no production users or approved identity bindings exist. The activation-ready CloudFormation candidate and guarded PHI-disabled replacement script are implemented and the exact closed deployment passed evidence exercise v2 (`aa5789c45692cda217b40c7cd12f0ab09bd72d5fd0ad3f27a4238beeb1ab0e87`). The role has one log-only policy and no attached or clinical data-plane permissions. This is engineering preparation, not approval.
- Rollback-only production acceptance proved connection, explicit laboratory-data consent, reviewed provider registration, import, duplicate protection, clinician acceptance, versioned clinical-record transfer, provenance, audit, and tenant isolation, then independently verified zero rows after rollback. This is a production-schema test with synthetic values, not authorization for PHI.
- Aurora point-in-time recovery restored the prior empty seven-migration schema into a private encrypted temporary cluster and verified 17 tables and zero patient/audit rows. The exact temporary recovery resources were deleted afterward; the production cluster remains encrypted, deletion-protected, and configured for 35-day backup retention. Migrations eight through ten require a fresh recovery exercise before activation. Snapshot/object/Cognito/application rollback and incident tabletop items remain open.
- Durable Junction and Passio connector-registry reads and vendor approvals are not implemented.
- GuardDuty and Security Hub are not enabled in the synthetic member account. The current trail is multi-region with validation but is not an organization trail.
- The exact production readiness image uses the non-root distroless runtime and its ECR scan reports zero Critical/High findings. This is image/private-compute evidence only, not approval of PHI processing.
- V2 local PHI storage now uses AES-256-GCM with per-write nonces and record-bound authenticated data. Independent cryptography, lost-device, backup, and deletion review remain required.
- The mobile dependency audit has no critical findings after targeted upgrades. Remaining high findings in the Expo/Metro toolchain require a reviewed Expo SDK upgrade.
- The immutable production identity attributes are deployed without changing the budget resource. Production user bootstrap and account operations remain blocked on a controlled root/budget mailbox that is not `info@AILongevityPro.app`; engineering will not invent that address. The existing budget subscriber remains a known transition item and is not accepted as production-readiness evidence.

Until these blockers are closed, use synthetic identities and synthetic data only.
