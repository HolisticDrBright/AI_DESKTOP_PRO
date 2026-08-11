# AWS synthetic-staging runbook

## Purpose

This stack is the first deployable AWS clinical-core slice shared by AI
Desktop Pro and AI Longevity Pro V2. It is intentionally unable to accept PHI
or real-patient data. Its only HTTP route is `GET /posture`, which reports that
the environment is synthetic staging and not configured for clinical use.

AI Longevity Pro V1 is outside this work and remains unchanged.

## What the stack creates

- Separate Cognito user pools for workforce and consumers. Workforce MFA is
  mandatory; consumer TOTP MFA is available.
- A private Aurora PostgreSQL Serverless v2 cluster with IAM authentication,
  an AWS-managed master secret, no public endpoint, and no network ingress.
- Private, versioned S3 buckets for synthetic clinical documents and audit
  logs, encrypted with a rotating customer-managed KMS key.
- A multi-region CloudTrail with log-file validation and S3 object data events
  for the document bucket.
- KMS-encrypted SQS event and dead-letter queues plus a dedicated EventBridge
  bus. Nothing publishes or consumes clinical events in this slice.
- A throttled API Gateway HTTP API and one 128 MB Lambda that returns only the
  synthetic posture. It has no database, S3, queue, or secret permissions.
- A $100 account-level monthly budget with forecasted 80% and actual 100%
  email alerts.

## Cost posture

The stack omits NAT Gateways, elastic IPs, load balancers, ECS services, VPC
endpoints, provisioned Lambda concurrency, and Aurora readers. Aurora is set
to auto-pause after 15 idle minutes on engine versions that support zero ACUs.

The AWS Budget is an alert, not a hard spending cap. Storage, backups,
CloudTrail data events, KMS requests, logs, database wake time, and traffic can
still exceed $100. Review Cost Explorer weekly during the pilot and daily
after any load test.

## Operator prerequisites

These actions cannot be performed by source code:

1. Create or select the dedicated synthetic-staging AWS account. Do not deploy
   this stack into a production or personal catch-all account.
2. Accept the AWS BAA in AWS Artifact for the organization or intended account.
3. Confirm `us-east-2` as the reviewed staging region.
4. Install and authenticate AWS CLI with a short-lived administrative role.
   Do not create a long-lived access key for this deployment.
5. Choose the infrastructure owner, security reviewer, budget-alert email, and
   exact local or HTTPS client origins.

The stack does not create AWS Organization accounts and cannot accept a legal
agreement on the operator's behalf.

## Local preparation

From the AI Desktop Pro repository:

```powershell
Copy-Item `
  "infra/aws-clinical-core/deployment-manifest.example.json" `
  "infra/aws-clinical-core/deployment-manifest.json"
```

Complete `deployment-manifest.json`. The real manifest is git-ignored because
it carries the AWS account id and reviewer identities. It must continue to say:

```json
{
  "environment": "synthetic-staging",
  "data_classification": "synthetic_only",
  "contains_phi": false,
  "real_patient_data_allowed": false,
  "vendor_phi_enabled": false
}
```

Run the local checks:

```powershell
npm run check:aws-clinical-core
npm run preflight:aws-synthetic -- infra/aws-clinical-core/deployment-manifest.json
```

The committed example deliberately fails preflight. A successful preflight
prints only the account id, region, environment, classification, and PHI=false;
it never prints credentials.

## Deployment

After the prerequisites and local checks pass:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-aws-synthetic.ps1
```

The deployment script:

1. Re-runs the fail-closed preflight.
2. Confirms the authenticated AWS account matches the reviewed manifest.
3. Calls CloudFormation template validation.
4. Deploys only the `synthetic-staging` and `synthetic_only` parameter values.
5. Prints the non-secret stack outputs.

It never applies a database schema, loads Supabase data, creates users, stores
Junction or Passio credentials, or enables V2/Desktop clinical traffic.

## Post-deployment acceptance

Do not connect either application yet. First record evidence for all of these:

- The budget email subscription is confirmed.
- `PostureUrl` returns `phiAllowed: false` and
  `status: synthetic_staging_not_configured`.
- Both S3 buckets have all public-access blocks enabled.
- CloudTrail is logging and log-file validation is enabled.
- The workforce user pool requires MFA.
- Aurora is not public, has deletion protection, and its security group has no
  ingress.
- The document bucket and queues use the clinical-core KMS key.
- A stack drift check reports no unreviewed changes.

Keep `CLINICAL_DATA_PLANE=supabase_staging` in the Desktop runtime. AWS
environment variables alone cannot activate the AWS data plane; a future
adapter must present a durable `production-clinical` runtime approval record.

## Next engineering slice

The next slice adds a synthetic schema migrator and the first authenticated
vertical contract: stable person identity, explicit practice invitation, and
versioned consent. Only after its tenant-isolation, backup/restore, audit, and
cross-product tests pass should Junction or Passio secrets be created.
