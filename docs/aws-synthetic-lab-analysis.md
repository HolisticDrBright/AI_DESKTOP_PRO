# AWS synthetic lab analysis

The synthetic staging account exposes a test-only lab pipeline for AI Longevity Pro V2. It must never receive real patient data.

## Flow

1. A dedicated Cognito synthetic identity creates a lab job.
2. The API returns one short-lived, KMS-encrypted S3 upload target per document.
3. The client uploads the fake image and completes the upload.
4. Step Functions runs five durable passes: extract, verify, normalize, interpret, and synthesize.
5. DynamoDB stores the resumable job and a draft result for practitioner review.

The test engine uses Textract table analysis plus deterministic range rules. It retains credible reported biomarker rows even when a biomarker is not in the governed functional-range catalog. A functional range is added only for an exact governed match; otherwise the reporting laboratory range is preserved without inventing a functional range. It makes no OpenAI request and emits no product recommendation.

## Live synthetic acceptance

From this repository in PowerShell:

```powershell
.\scripts\run-aws-lab-live-test.ps1
```

The script signs in through Cognito, generates and uploads a synthetic lab image, waits through all five passes, retries completion to prove idempotency, signs in again, and confirms the same result can be resumed from a fresh session.

The high-volume regression sends four synthetic table images containing 80 unique markers and requires all 80 to survive the real AWS workflow:

```powershell
.\scripts\run-aws-lab-80-marker-test.ps1
```

Both tests use generated synthetic records only. Never use a real patient report in this stack, even if the AWS account has a BAA; the deployed resources are explicitly tagged and constrained as `synthetic_only` with `PhiAllowed=false`.

## Test account

The locally protected credential can be displayed with:

```powershell
.\scripts\show-aws-lab-test-credentials.ps1
```

The password is protected with Windows DPAPI and is not stored in Git, CloudFormation, documentation, or shell output captured by the acceptance test.

## Current deployment

- AWS account: dedicated synthetic staging only
- Region: `us-east-2`
- API origin: `https://wxv734oi12.execute-api.us-east-2.amazonaws.com`
- Contract: `lab-analysis/1`
- Data classification: `synthetic_only`
- PHI allowed: `false`
