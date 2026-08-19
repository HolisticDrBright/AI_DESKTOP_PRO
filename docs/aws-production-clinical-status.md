# AWS production clinical migration status

This is the engineering status of the separate production clinical target. It
does not authorize PHI. The existing App Runner Desktop, Fly patient API,
Supabase projects, and synthetic AWS account remain synthetic-only.

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
- Desktop and patient-API startup guards that refuse a production label if
  Supabase, Fly, or App Runner variables are present, if the AWS adapter is not
  ready, or if PHI activation evidence is absent.
- A migration inventory gate covering both repositories.
- A production readiness gate requiring every named control, runtime boundary,
  and legal/security/clinical/engineering approval. Empty manifests cannot pass.
- A public no-PHI posture response at the stack `PostureUrl` reports
  `clinical-core/2`, `production-clinical`,
  `production_foundation_phi_blocked`, and `phiAllowed=false`.
- The production ECR repositories and ECS cluster contain no images, services,
  or tasks. No application workload or patient data was deployed with the
  foundation.

## Current measured blockers

The migration inventory currently identifies 17 source files with direct
Supabase runtime dependencies and two source files with Fly-specific runtime
references. This count is a lower bound: many route files call shared Supabase
wrappers and must move with those wrappers. The AWS production adapter is not
yet implemented, so `AWS_CLINICAL_ADAPTER_READY` must not be set to `true` in a
real deployment.

A dedicated production member account now exists as account `173535830222`.
Account `588966314750` remains synthetic staging and account `449901517958`
remains the management account; both are explicitly refused by the production
deployment script.

The production endpoint registry reserves `desktop.ailongevitypro.app`,
`clinical-api.ailongevitypro.app`, `staff-auth.ailongevitypro.app`, and
`app-auth.ailongevitypro.app`. Public DNS remains inactive until the reviewed
targets and GoDaddy DNS validation records exist.

## Inputs that cannot be invented by engineering

1. Confirmation that `info+aws-prod@AILongevityPro.app` is received and retained
   by the controlled `info` inbox.
2. A controlled evidence reference showing the AWS Organizations BAA applies to
   the new member account.
3. GoDaddy DNS changes and ACM validation for the four reserved endpoint names.
4. Decisions and agreements for every downstream service that may receive PHI.
5. Named reviewers and timestamps for legal/compliance, security, clinical
   safety, and engineering approval.

## Required migration sequence

1. Create the empty dedicated AWS account and apply organization controls.
2. Deploy the production foundation with PHI blocked.
3. Replace Supabase Auth with the two Cognito identity planes.
4. Move schemas, policies, RPC behavior, and server adapters to Aurora/AWS; do
   not copy staging snapshots or synthetic identities.
5. Deploy Desktop and patient API to ECS/Fargate behind reviewed TLS/WAF
   boundaries; remove App Runner and Fly from the PHI route.
6. Run synthetic migration, reconciliation, duplicate/replay, tenant-isolation,
   consent, provenance, clinician-review, backup/restore, and incident tests in
   the exact production configuration.
7. Complete independent risk, security, privacy, vendor, and clinical reviews.
8. Only after the signed readiness manifest passes may a supervised minimum-data
   pilot be considered. Activation remains a separate, reversible change.

## Safe commands

- `bun run build:aws-production-foundation`
- `bun run check:aws-production-foundation`
- `bun run audit:aws-data-plane-migration`
- `bun run check:aws-production-readiness -- <reviewed-manifest>`

The `check:aws-data-plane-migration` command is intentionally expected to fail
until all legacy production runtime paths have been removed.
