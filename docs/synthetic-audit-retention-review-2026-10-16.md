# Fictional audit-log one-year deletion proposal — review only

**Blocked.** This is a generated template proposal, not an AWS change set, an approved retention policy, an executed lifecycle change, or a deletion receipt. It applies only to account `588966314750`'s synthetic clinical-core stack. It grants no PHI or production authority.

Brandon requested a one-year permanent-deletion proposal for the fictional audit logs. The live audit S3 bucket has versioning enabled. Its current rule transitions current objects to Standard-IA at day 30 and expires current versions at day 365, but it has no noncurrent-version expiration. The CloudWatch log group has 30-day retention. Current-version expiration creates a delete marker and retains a noncurrent version, so the existing rule does not permanently delete the underlying S3 log bytes at one year.

## Exact source candidate

Run `node scripts/build-aws-synthetic-audit-retention-review.mjs --build-review-only` to create the local artifact `dist/aws-clinical-core/synthetic-audit-retention-review.json`. It uses the exact **unexecuted** Data API audit candidate (`371d8136e8e3215707338e3721cefb732d953dac32d05afc36dd90e330ac4152`) as its parent and refuses a different template. The combined audit-plus-retention candidate has canonical SHA-256 `0a2a460280c5324226660250ccd9ff4cb951e8c3b18558c7e5e6dd6c16b2d124`.

Relative to that parent, only `Resources.AuditBucket.Properties.LifecycleConfiguration.Rules` changes:

- The existing `ArchiveAuditLogs` rule retains its Standard-IA transition at day 30, changes current-version expiration from day 365 to day 364, and adds noncurrent-version expiration one day after a version becomes noncurrent.
- A separate rule removes an expired delete marker only after it has no remaining underlying versions. It does not delete a log version by itself.

For the normal case of a log object never overwritten, day-364 current expiration creates a noncurrent version, which becomes **eligible** for permanent deletion after one more noncurrent day, around day 365. CloudTrail's log filename includes a unique string intended to prevent overwrites. This design is **not** a hard 365-day deletion guarantee: S3 lifecycle actions are asynchronous, and an unexpected early overwrite could make the older version eligible one day after that overwrite. The current version also becomes unavailable around day 364. A reviewer must decide whether those bounds satisfy the desired one-year fictional-log schedule. Do not represent the rule as an exact legal retention guarantee.

## Evidence and remaining review

Three focused tests prove the parent hash, candidate hash, one-resource-only delta and refusals for drifted parents. `cfn-lint` and AWS `ValidateTemplate` accepted the generated JSON; neither calls CloudFormation update or S3 mutation. The live bucket versioning/lifecycle and 30-day CloudWatch retention were read without reading any log object.

Before any change-set creation, re-check the live parent template, physical selectors, bucket lifecycle/versioning, all current parameters, trail delivery and account. Before any **execution**, separately review event volume and charges, bucket access, the exact retention policy, legal holds, any existing old/noncurrent versions that would become immediately eligible, lifecycle timing, and monitoring. The combined candidate differs from the currently deployed template in **two** resources: `AuditTrail` and `AuditBucket`; a change set must show in-place modifications only, no replacement or unlisted resource. Approval to prepare this source proposal is not approval to create or execute that change set.

Rollback can restore the old configuration but **cannot recover object versions S3 already permanently deleted**. Any execution therefore needs a reviewed evidence-preservation and rollback plan. The existing clinical and PHI holds remain in force.

AWS references: [versioned S3 expiration behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html), [CloudFormation lifecycle rule properties](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-s3-bucket-rule.html), [noncurrent-version expiration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-s3-bucket-noncurrentversionexpiration.html), and [CloudTrail unique log filenames](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-examples.html).
