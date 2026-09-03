# AWS synthetic lab analysis

The synthetic staging account exposes a test-only lab pipeline for AI Longevity Pro V2. It must never receive real patient data.

## Flow

1. A dedicated Cognito synthetic identity creates a lab job.
2. The API returns one short-lived, KMS-encrypted S3 upload target per document.
3. The client uploads the fake image and completes the upload.
4. Step Functions runs five durable passes: extract, verify, normalize, interpret, and synthesize.
5. DynamoDB stores the resumable job and a draft result for practitioner review.

The first four passes use Textract table analysis plus deterministic normalization and range rules. They retain credible reported biomarker rows even when a biomarker is not in the governed functional-range catalog. A functional range is added only for an exact governed match; otherwise the reporting laboratory range is preserved without inventing one.

The fifth pass sends only the normalized synthetic biomarker envelope to the pinned OpenAI Responses API model. It requests concise strict structured JSON with `store: false`, no tools, no web access, no background processing, and no reserved reasoning budget. Extraction retains every credible biomarker, while the narrative cites at most the 40 most relevant supplied biomarker IDs. The response is rejected if it is incomplete, substitutes a model, cites a biomarker outside the supplied envelope, adds a commercial link, or gives a product, dose, or treatment directive. The result remains a draft for practitioner review and `recommendations` remains empty.

The API key is read by the worker from AWS Secrets Manager at runtime. It is not stored in the app, repository, CloudFormation parameters, logs, or result payloads.

## Live synthetic acceptance

From this repository in PowerShell:

```powershell
.\scripts\run-aws-lab-live-test.ps1
```

The script signs in through Cognito, generates and uploads a synthetic lab image, waits through all five passes, proves that the AI synthesis marker is present, retries completion to prove idempotency, signs in again, confirms the same result can be resumed from a fresh session, and deletes the job through the authenticated consumer API.

## Deletion

`DELETE /clinical-core/consumer/labs/jobs/{jobId}` is protected by the same consumer JWT authorizer as the rest of the lab API. The API verifies ownership without revealing whether another user's job exists, removes every version and delete marker under the job's source and artifact prefixes, and then removes the DynamoDB job record. Repeating the request is idempotent.

Jobs in `awaiting_upload`, `completed`, `needs_review`, or `failed` can be deleted. Jobs actively moving through extraction or analysis return a conflict response and remain intact; the client must wait for a terminal state and try again. If cloud deletion fails, the mobile app keeps its local panel instead of showing a false success.

The high-volume regression sends four synthetic table images containing 80 unique markers and requires all 80 to survive the real AWS workflow:

```powershell
.\scripts\run-aws-lab-80-marker-test.ps1
```

Existing saved measured markers can be reprocessed into a governed plan without inventing a source document. The recovery route recomputes governed functional ranges in AWS, preserves reporting-lab ranges, labels every marker as needing source-document review, and runs the same interpretation and plan synthesis passes:

```powershell
.\scripts\run-aws-saved-lab-plan-live-test.ps1
```

Both tests use generated synthetic records only. Never use a real patient report in this stack, even if the AWS account has a BAA; the deployed resources are explicitly tagged and constrained as `synthetic_only` with `PhiAllowed=false`.

Verified on 2026-08-14 against the deployed synthetic stack:

- the standard panel completed all five passes with 11 retained biomarkers and a persisted AI synthesis;
- the high-volume panel retained 80 of 80 unique biomarkers and completed AI synthesis;
- both returned zero product recommendations and remained `draft_for_practitioner_review`.

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
