# Retained care messaging: read-only hosted inspection

This is deployment inspection, **not** messaging acceptance, a human approval,
or PHI activation. It does not deploy, upload, register consent, issue credentials,
or send messages. All actual database queries run in a repeatable-read read-only
transaction whose rollback must be observed. No automatic provider retries.

## Packaging

`npm run build:aws-care-messaging` now produces `deployment.zip` containing
exactly the compiled `index.js`, with fixed ZIP metadata and a recorded SHA-256
and byte size. Use that ZIP, not a manually repackaged file. The template remains
blocked/logs-only by default. Nothing in the builder accesses AWS.

## Read-only command

From an entirely clean, committed Desktop checkout:

```powershell
npm run inspect:aws-care-messaging-qualification
```

The command independently rebuilds the source and verifies all 104 migration
hashes, not just a row count or last version. It uses only `ai-synthetic-member`
in account `588966314750`, region `us-east-2`, the qualification foundation and
`clinical_core_qualification`. Root credentials, the staging database and the
production account are refused. A missing candidate stack returns
`status: not_deployed`, `acceptance: false`; access errors are never absence.

To inspect an actually deployed candidate, supply a separately reviewed JSON
binding. To compare an existing build too, supply its output directory:

```powershell
npm run inspect:aws-care-messaging-qualification -- --binding=C:\reviewed\care-binding.json --artifact-dir=C:\built\care-messaging
```

The binding's exact keys are:

- `contract`: `care-messaging-qualification-binding/1`.
- `sourceCommit`, `migrationReleaseSha256`, `apiId`, `organizationId`.
- `consumerIssuer`, `consumerAudience`, `workforceIssuer`, `workforceAudience`.
- `codeBucket`, `codeKey`, immutable `codeVersion`.
- `secretKmsKeyArn`, `logsKmsKeyArn`, `alarmTopicArn`.
- `subjects`: three or four distinct designated fictional subject UUIDs.
- `reviews`: exact keys `database`, `workforceMfa`, `messaging`, `retention`,
  `qualification`, containing the genuine separately reviewed evidence digests.

Do not manufacture hashes, infer approvals from this inspection, or reuse the
intake-copy approval as a messaging/security/retention review. A syntactically
valid hash only binds a value; it does not establish that its review happened.

## Observations

For a deployed candidate, the inspector compares the original CloudFormation
template and all parameters/resources/outputs against the rebuilt source, then
observes Lambda's exact ZIP digest and configuration, the version-pinned S3
object bytes, encrypted retained logs, exact IAM inline policies and trust,
absence of managed policies, JWT routes and authorizers, integration, invoke
permissions, default-stage deployment and count-only alarm actions. It repeats
these reads, the object comparison and whole-ledger verification to detect
ordinary deployment drift. This is not an atomic AWS snapshot.

The code-package checksum is Lambda's `CodeSha256`, not a hash of the raw JS:
[AWS FunctionConfiguration](https://docs.aws.amazon.com/lambda/latest/api/API_FunctionConfiguration.html).
The stored package is read using its immutable version and expected bucket owner:
[AWS GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).

Even `deployment_bindings_verified` retains `acceptance: false` and
`humanReviewsVerified: false`. This does not establish effective KMS/SCP/data
permissions, actual Cognito pool policy, consent/provider approvals, delivered
alarms, successful API operations or device behavior. Those require independent
review and physical hosted/device evidence. Missing resources, provider errors,
changed metadata or a rollback failure are incomplete, never a pass.

## Still needed

1. Genuine candidate-specific reviews and fictional identity/organization binding.
2. Reviewed qualification deployment (separate operator; not this read-only tool).
3. Actual positive/negative messaging and paginated export acceptance, including
   cross-owner/clinic denials, both cancellation race orders, late admission,
   idempotent settlement, replacement-link withholding and second-device convergence.
4. Matched Desktop/V2 releases and physical device acceptance. Paid builds remain held.
5. Separate production policies/provider coverage and PHI activation review.

No candidate was deployed by writing these tools. No new installed mobile build
or commercial/PHI readiness claim follows from their fictional unit tests.
