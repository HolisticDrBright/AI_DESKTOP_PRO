# Production RDS Data API audit successor — review only

This is a source-only, **inactive** successor for the existing production CloudTrail trail. It is not a PHI approval or an instruction to run `put-event-selectors` directly. The production foundation's normal build remains unchanged.

## Observed production state

On 16 October 2026, a read-only check in AWS account `173535830222`, `us-east-2`, found trail `ai-clinical-core-production-clinical` logging with no delivery error. Its basic `EventSelectors` include all management events and S3 object events for the clinical-documents bucket. They do **not** include RDS Data API data events. The production clinical Aurora cluster has its HTTP Data API enabled. AWS documents `ExecuteStatement`, `BatchExecuteStatement`, `BeginTransaction`, `CommitTransaction`, and `RollbackTransaction` as separately selectable data events, not enabled by default. Those events can identify the caller, cluster and time but redact the database/schema/SQL. They incur additional charges.

AWS documentation:

- https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/logging-using-cloudtrail-data-api.html
- https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cloudtrail-trail-advancedeventselector.html
- https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cloudtrail-trail-advancedfieldselector.html

This is an audit-coverage gap, **not** proof that no other database or application audit exists. It does not establish PHI readiness either way.

## Candidate identity and exact scope

Build with `npm run build:aws-production-data-api-audit-candidate`. The source generator refuses any production-foundation parent whose canonical JSON SHA-256 differs from `a741599b1febd1b8a9d76123ce68bf6c2c162a9412fc5ec7480821710a2d872d`. The generated candidate SHA-256 on this source is `5d28286ebed8332b421ae8223e4022885676999948ee28b3f60b48671257bd02` for canonical JSON; the output file includes a trailing LF and consequently has a different byte hash.

The only template difference is `AuditTrail.Properties`: replace its basic `EventSelectors` with three `AdvancedEventSelectors` for:

1. all management events, preserving read and write coverage;
2. clinical-documents S3 object data events scoped to the existing bucket prefix;
3. RDS Data API data events scoped by exact ARN to `ClinicalDatabaseCluster`, **not** all DB clusters in the account.

The trail destination, KMS key, CloudWatch log group, multi-region logging, log-file validation, PHI-off output, and every other resource are unchanged. The parent-pinned test proves that delta and refuses a drifted parent. This candidate has not been uploaded, deployed or activated.

**Live-stack drift:** `GetTemplate(Original)` for the deployed production foundation has the same 65 resource names as this source parent, but its workforce and consumer Cognito pools/clients differ in email configuration, verification text, admin-create settings and client read attributes. Physical Cognito settings may already have been updated out of band, but that is not proved by this template comparison. This candidate is a narrow **source-to-source** delta, **not** yet a logging-only live CloudFormation update. Reconcile the identity template drift or explicitly review those changes in a full change set before any execution; an audit-only approval cannot authorize Cognito changes.

The read-only `node scripts/check-aws-production-data-api-audit-live-parent.mjs --profile ai-production` preflight pins the production account, region and stack, refuses an in-progress stack, verifies this candidate's exact reviewed source parent, and compares the **original live template** without printing values. On the observed production stack it returns `ready:false`, `live_template_drift` and four Cognito resource paths. Run it again immediately before any later change-set preparation. A pass would prove only the starting template, not cost approval or the proposed change set.

## Verification and hold

The source test reproduces the gap on the current production-foundation generator (no RDS data selector), then passes against the candidate. `cfn-lint` accepted the generated candidate locally. The `test:aws-production-foundation` CI script now runs the candidate's structural tests alongside the existing production-foundation checks. None of that demonstrates actual CloudTrail delivery.

Before executing a CloudFormation change set, resolve the live-template drift above, obtain a reviewed estimate of RDS Data API event volume and incremental CloudTrail/S3/CloudWatch costs, confirm audit-log retention and access policy, and review the exact change set for **no unapproved Cognito change or trail replacement**, preserved S3/management coverage and the single cluster ARN. The account's October forecast already exceeded its $100 budget in the prior read-only cost review, so cost approval is a material gate. If approved, apply through the CloudFormation owner, not an out-of-band selector mutation. Then issue one fictional Data API call, locate its delivered event in the encrypted trail, verify the caller and cluster, verify SQL is redacted, verify existing management and S3 events continue, and record actual event volume/cost. No real patient data should be used for this check.

Rollback is the reviewed parent template with its prior basic selectors. A rollback would again stop RDS Data API data-event logging; preserve the delivered audit objects and their retention controls. Do not treat rollback as deletion of audit history.
