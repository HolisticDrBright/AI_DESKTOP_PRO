# Exact-live clinical Data API audit candidate — 16 October 2026

This is **source and a local generated candidate for review only**. It did not
create a change set, update CloudTrail, turn on PHI, deploy code or process
patient data. RDS Data API data events would add CloudTrail and storage costs,
and the existing audit destination has seven-year compliance-locked retention.
The owner and security/retention reviewers have not approved that change.

## Why this candidate is separate

The checked-in production-foundation parent differs from the stable live
`GetTemplate(Original)` in four Cognito pool/client resources. Applying the
earlier source-parent audit candidate could carry those unrelated identity
template changes. The exact-live builder instead reads the live original
template from account `173535830222`, region `us-east-2`, pins its complete
canonical SHA-256, and modifies only the `AuditTrail` resource. It refuses a
changed template, account, stack, selector shape or unstable stack.

At the read-only observation, the parent SHA-256 was
`940aa70ca239a0d1403d0adabfbdd8f87bbebf3aab975607d1cde70c491f290d`.
The locally generated candidate SHA-256 was
`7b8cf85a807f3b6e90ba6f7e494de2132699bfc2da0f540bd163c02d28ae511e`.
The only changed template path is `Resources.AuditTrail`. Within it, basic
selectors for all management events and clinical-document S3 object events
are replaced by equivalent advanced selectors plus a new data selector for
the exact `ClinicalDatabaseCluster` ARN. The candidate preserves every other
resource, parameter, condition and output from the observed live template.
The generated JSON is local and ignored by Git.

## Evidence and required review

- The production-foundation and new live-parent tests passed; four new cases
  cover digest stability, exact delta, parent mutation and selector/refusal
  shapes. `cfn-lint` passed on the locally generated JSON.
- These are source checks and a read-only live-template observation. They do
  **not** prove CloudFormation would report only an in-place Trail update or
  that data events would arrive at the intended destination.
- Before any AWS write, rerun the exact hash check, review additional event
  volume, cost, retention and read access, preserve each current stack
  parameter with `UsePreviousValue`, then inspect a CloudFormation
  change set for **no Cognito or other unrelated modification/replacement**.
  A change set and its execution require separate explicit approval.
- After an approved execution, use only fictional calls to verify RDS Data API
  caller/cluster/time events, SQL/database/schema redaction, continued
  management and S3 object events, delivery health and cost.

For a local rebuild from the exact live stack, run
`npm run build:aws-production-data-api-audit-live-candidate -- --profile <profile>`.
Do not commit or submit its generated template without a fresh parent check
and full review of the artifact.
