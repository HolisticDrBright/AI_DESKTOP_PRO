# AWS production clinical migration status

This is the engineering status of the separate production clinical target. It
does not authorize PHI. The existing App Runner Desktop, Fly patient API,
Supabase projects, and synthetic AWS account remain synthetic-only.

## What is implemented

- A generated and machine-checked CloudFormation foundation for a dedicated
  `production-clinical` account.
- Separate rotating KMS keys for application, Aurora, documents, audit, and
  backups.
- Private encrypted Aurora, object-locked/versioned S3, CloudTrail, Config,
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

## Current measured blockers

The migration inventory currently identifies 17 source files with direct
Supabase runtime dependencies and two source files with Fly-specific runtime
references. This count is a lower bound: many route files call shared Supabase
wrappers and must move with those wrappers. The AWS production adapter is not
yet implemented, so `AWS_CLINICAL_ADAPTER_READY` must not be set to `true` in a
real deployment.

No dedicated production member account exists in the reviewed AWS Organization.
Account `588966314750` is synthetic staging and account `449901517958` is the
management account; both are explicitly refused by the production deployment
script.

## Inputs that cannot be invented by engineering

1. A unique, controlled email address for the new AWS production member account.
2. The controlled billing/security alert email.
3. Production domain names and an ACM certificate for the Desktop and patient API.
4. A controlled evidence reference showing the AWS Organizations BAA applies to
   the new member account.
5. Decisions and agreements for every downstream service that may receive PHI.
6. Named reviewers and timestamps for legal/compliance, security, clinical
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
