# Reviewed legacy lab inventory indexing

Original commercial phase 2. Synthetic account 588966314750/us-east-2 only.
This administrative tool does not grant the runtime API Scan permission or expose
a migration route. Indexing is discovery, not ownership authorization, clinical
approval, successful result recovery or full phase completion.

## Operation

1. Commit and inspect the exact source; build with
   node scripts/build-lab-inventory-migration.mjs.
2. Plan with node scripts/migrate-lab-inventory.mjs plan
   --confirm-synthetic-only --source EXACT_COMMIT --file NEW_PRIVATE_PLAN_PATH.
   --only-job UUID limits a fixture run to one job. Default profile is
   ai-synthetic-member; the AWS account, foundation PHI/classification/environment,
   stack, table ARN and ACTIVE owner index must match before access.
3. Review the local plan (metadata only), candidate count and skipped reasons.
   The console prints no patient payloads, subjects, job IDs or credentials.
   Keep plan artifacts outside tracked sources; do not upload them to support.
4. Apply only those exact reviewed bytes:
   node scripts/migrate-lab-inventory.mjs apply --confirm-synthetic-only
   --source EXACT_COMMIT --file SAME_PLAN_PATH --approved-sha256 EXACT_FILE_HASH.
5. Inspect the aggregate result and re-plan conflicts. Plans expire after one
   hour. A partial/uncertain update can be replayed safely during that window.
   Normal inventory API calls still re-read current base rows for authorization.

The operator verifies its bundle against the source-file hashes before loading
it. Runtime AWS credentials are obtained for the selected profile, kept in memory,
never written to a plan or printed. No new IAM permissions are provisioned.

## Safety contract

Only job metadata is projected in bounded, paginated, consistent administrative
scans: identifiers, ownership triplet, timestamps, state, progress, and existing
index fields. No document names, biomarker values, results, storage paths,
source fingerprints, clinical contexts or credentials are read by this scan.

Eligibility requires complete canonical existing identity/date/job metadata,
unexpired/non-deleting state and no existing index fields. The exact ownership
triplet must match one currently enabled, explicitly synthetic-attested Cognito
user in the stack's configured consumer pool. No emails or shared-table proximity
are used to guess ownership. Expired, malformed, ambiguous, unverified and
partially/conflicting indexed rows remain untouched and are counted.

Apply rechecks current metadata and Cognito ownership. The conditional update
compares all original projected metadata, verifies expiry and missing index
fields, and writes ONLY inventoryOwner/inventoryOrder. It cannot recreate deleted
jobs, overwrite a changed row, extend retention or modify clinical source data.
Already matching stamps are recognized on replay; conflicting stamps are never
overwritten. Network/permission failures do not become empty successful scans.

This does not invent absent recovery-request metadata, checksum manifests or
source provenance. Unsupported legacy saved jobs can be listed without becoming
automatically resumable. Existing API authorization does not trust GSI membership.

## Verification

34 dedicated tests cover owner/schema/time gates, metadata-only projection,
pagination, duplicate/cyclic pages, exact selection, stale plans, plan counts,
row changes, deletion/expiry races, uncertain updates, replay and unchanged runtime
permissions. Hosted script --TestLegacyInventoryMigration creates a new synthetic
fixture, conditionally removes only its index fields, plans/applies/replays only
that job, and exercises owner visibility and second-user exclusion. No analysis
worker, model call, email or real data is required. Record actual executions in
the hosted evidence; writing this test is not evidence that it ran.

Production migration, account-wide erasure, active-plan adoption, physical mobile
qualification and human/clinical gates remain separate. Do not change source
verification, holds, exclusions or PHI settings to close this migration.
