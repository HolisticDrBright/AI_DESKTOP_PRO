# AWS synthetic deployment acceptance

## Status

The baseline foundation was deployed on 2026-08-12 to dedicated member account
`588966314750` in `us-east-2`. The authenticated API, migrations, and fixtures
described below remain **not deployed**. The organization BAA support case is
still open, so this checkpoint is explicitly non-PHI and synthetic-only.

This phase remains synthetic-only. It is not permission to store PHI or real
patient data. Production requires a separate reviewed infrastructure change,
accepted AWS BAA posture, security review, backup/restore exercise, incident
response exercise, and an explicit production data-classification migration.

## Baseline foundation evidence

- CloudFormation stack `ai-clinical-core-synthetic-staging` is
  `UPDATE_COMPLETE` and drift detection reports `IN_SYNC`.
- `GET /posture` returns `synthetic-staging`, `synthetic_only`,
  `phiAllowed: false`, and `synthetic_staging_not_configured`.
- The clinical document bucket has all four public-access blocks enabled and
  uses the rotating clinical-core KMS key with bucket keys enabled.
- CloudTrail is multi-region, logging, KMS encrypted, and has log-file
  validation enabled with no S3 or CloudWatch delivery error.
- Workforce Cognito MFA is `ON` with software-token MFA enabled; both user
  pools have deletion protection active.
- Aurora is encrypted, IAM database authentication is enabled, the writer is
  not public, deletion protection is on, and its security group has no ingress.
- Both SQS queues use the clinical-core KMS key and refuse insecure transport.
- The monthly budget is USD 100 with forecasted 80% and actual 100% alerts.

The ignored manifest records `pending-organization-acceptance`; preflight
reports `baa_activation_pending: true` and `phi_activation_blocked: true`.
Deployment validation exposed and fixed Windows AWS CLI file URI construction,
Lambda reserved concurrency on a new-account quota, CloudTrail log-group ARN
shape, and SQS's one-resource-per-policy-statement requirement. Empty resources
from failed synthetic attempts were removed; three unused KMS keys are scheduled
for deletion after the seven-day recovery window. No patient data, PHI,
application users, fixtures, or vendor credentials were loaded.

## What this phase closes

The authenticated API from the preceding phase needs three deployment-time
capabilities before an operator can exercise it safely:

1. Aurora Data API receives one SQL statement per call. The migration runner now
   parses PostgreSQL while preserving quoted strings, nested comments, and
   dollar-quoted function bodies, and executes every statement inside one
   transaction protected by the migration advisory lock and SHA-256 ledger.
2. A reviewed, git-ignored fixture manifest provisions only opaque synthetic
   identifiers: one organization, one workforce person and identity, one
   consumer person and identity, one practitioner membership, one patient record,
   and one approved synthetic consent artifact. Existing mismatched rows cause a
   refusal; they are never overwritten.
3. The acceptance runner keeps fresh Cognito ID tokens in process memory and
   performs eight checks through API Gateway, Lambda, and Aurora: invitation,
   claim, replay refusal, wrong-pool refusal, unexpected PHI-shaped field refusal,
   consent grant, duplicate grant refusal, and consent revocation.

No token, invitation secret, Cognito subject, AWS secret ARN, or request payload
is printed by the clinical modules. The operator scripts clear temporary process
variables when finished.

## Reviewed files

- `infra/aws-clinical-core/deployment-manifest.json` copied from the example and
  completed for the intended AWS account.
- `infra/aws-clinical-core/synthetic-acceptance-manifest.json` copied from the
  example. Replace the Cognito subjects only after creating the two synthetic
  users. Do not add emails, names, passwords, tokens, or patient content.
- Both real manifests are git-ignored.

The Cognito users must carry the immutable custom attributes declared by the
foundation template:

- workforce: reviewed workforce `person_id`, `organization_id`, and
  `synthetic_attested=true`
- consumer: reviewed consumer `person_id`, the same `organization_id`, and
  `synthetic_attested=true`

The corresponding `sub` values go into the fixture manifest. Passwords and ID
tokens do not.

## Operator order

Run from a clean checkout of this phase after installing AWS CLI v2 and signing
in to the reviewed synthetic account.

1. Deploy the synthetic foundation using `docs/aws-synthetic-staging-runbook.md`.
2. Create exactly the two synthetic Cognito users and complete the fixture
   manifest with their opaque `sub` values.
3. Apply the migration and fixture path:

   ```powershell
   .\scripts\apply-aws-synthetic-data.ps1 `
     -FoundationStackName "ai-clinical-core-synthetic-staging" `
     -DeploymentManifestPath "infra\aws-clinical-core\deployment-manifest.json" `
     -SyntheticManifestPath "infra\aws-clinical-core\synthetic-acceptance-manifest.json" `
     -Region "us-east-2" `
     -ConfirmSyntheticOnly
   ```

4. Deploy the authenticated API extension only after migration success:

   ```powershell
   .\scripts\deploy-aws-authenticated-api.ps1 `
     -FoundationStackName "ai-clinical-core-synthetic-staging" `
     -ArtifactBucket "REVIEWED-ARTIFACT-BUCKET" `
     -Region "us-east-2" `
     -ConfirmSyntheticMigrationApplied
   ```

5. Obtain fresh Cognito **ID tokens** for those two users without writing them to
   disk. Place them only in the current PowerShell process, then run:

   ```powershell
   $env:CLINICAL_WORKFORCE_ID_TOKEN = "fresh-workforce-id-token"
   $env:CLINICAL_CONSUMER_ID_TOKEN = "fresh-consumer-id-token"
   .\scripts\run-aws-synthetic-acceptance.ps1 `
     -FoundationStackName "ai-clinical-core-synthetic-staging" `
     -DeploymentManifestPath "infra\aws-clinical-core\deployment-manifest.json" `
     -SyntheticManifestPath "infra\aws-clinical-core\synthetic-acceptance-manifest.json" `
     -Region "us-east-2"
   ```

The script clears both token variables even when a check fails. Close the shell
afterward. A clean run reports only safe aggregate counts.

The fixture is intentionally single-use. Invitation and consent history is
append-only, so the tooling never erases a prior run to make a test pass again.
To repeat the entire journey, use fresh opaque fixture IDs and fresh synthetic
Cognito users (or a fresh disposable synthetic stack), then review both manifests
again.

## Failure posture

- Missing AWS CLI, account mismatch, region mismatch, an unreviewed manifest, or
  non-synthetic stack output stops before database or API calls.
- Migration history changes stop on the recorded hash mismatch.
- Existing fixture IDs with different values stop with `fixture_mismatch`.
- Redirects, non-API-Gateway origins, malformed/shared tokens, unexpected response
  shapes, oversized responses, and any wrong status stop the acceptance run.
- No acceptance failure enables PHI, production, fallback fixtures, or patient
  attachment.

## Next checkpoint

After an operator supplies a real synthetic AWS account and the eight checks pass,
record only the stack identifiers, migration versions, safe check totals, and
CloudWatch alarm state. Do not record tokens, invitation material, Cognito
subjects, database secret identifiers, or response bodies.
