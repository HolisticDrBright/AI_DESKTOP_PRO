# Qualification export bucket inspection — October 6, 2026

This is a read-only technical inspection, not an export-delivery release, retention-policy approval, independent security review, or authorization for PHI. The owner's fictional intake-consent approval is unrelated to export retention. No real records may enter this target.

## Bound target

- Account `588966314750`, region `us-east-2`, AWS profile `ai-synthetic-staging`. The observed CLI principal was account root; that is a qualification limitation, not the accepted production operating model.
- Bucket `alp-qualification-exports-588966314750-us-east-2` is owned by the `ai-clinical-core-qualification-foundation` CloudFormation stack. Tags include `PhiAllowed=false`, `DataClassification=synthetic_only`, and `Purpose=isolated-qualification`.
- The current `ai-clinical-core-qualification-personal-storage` stack is `UPDATE_COMPLETE` but still uses source `a300c633ac81909842503ad37e77170ad63ed605`; `Activation=blocked`, `PhiAllowed=false`, `QualificationExecution=enabled`, `DatabaseName=clinical_core_qualification`. Its `ExportBucketName` and `ExportReviewSha256` parameters are empty. Thus **export delivery is not configured** in the running candidate.

## Read-only observations

AWS S3 reported versioning enabled, all four public-access-block controls enabled, `BucketOwnerEnforced` ownership, and `IsPublic=false`. The default encryption is SSE-KMS using key `8095d2eb-4db8-40e5-9062-6e34c490674a`; KMS reported the key enabled for encryption/decryption with automatic rotation enabled. The bucket lifecycle has enabled rules under `personal-exports/`: abort incomplete multipart uploads after one day, expire noncurrent versions after one day, expire current versions after three days, and remove expired delete markers. The bounded current-object and multipart-upload listings returned no entries; that is not a historical inventory or a deletion receipt.

The source candidate template grants export object operations only under `personal-exports/*`, prefix-bounds version listing, and grants multipart-upload listing at bucket scope. This inspection found a qualification-designated bucket but does not prove every historical object, every bucket-policy path, the runtime IAM behavior, or KMS/HEAD/checksum semantics. Those require hosted negative and positive tests.

## Exact-source checkpoint, not deployment approval

The reviewed older candidate at `a300c63` predates the current source. Between that source and Desktop `f5f2660`, the personal-storage API appends an owner-scoped `GET /privacy-export/job/current` route and related tests. The current locally generated personal-storage `index.js` SHA-256 is `e676d187ca6d1d4559130667c9128fccaabfa5307319e483bea56559f85a3bfd`; template SHA-256 is `b21e61d80ab4f3c32718cd2558183ed359d396727c527db95d8aeba31100c44a`. `cfn-lint` passed on that generated template. Neither artifact was uploaded or deployed by this inspection. The previous source-bound technical review hash cannot be reused as if it covered the new route or export delivery.

## Release and policy gates still open

1. Record a separate owner decision for the proposed **48-hour fictional export download window**. This is not a decision about original health records, backups, or production retention. The S3 lifecycle's three-day current-object expiration is a backstop, not proof of a 48-hour deletion service level.
2. Review the exact new API route, identity checks, export IAM, KMS policy, bucket policy, lifecycle, alarm routing and scope against a newly packaged, immutable source artifact. Bind the technical review to the specific source, artifact digest, stack parameters and fictional identity manifest; leave cross-store lab/voice export parameters empty until separately qualified.
3. Before executing a change set, verify `PhiAllowed=false`, `Activation=blocked`, `QualificationExecution=enabled`, qualification database and account pin. Inspect the change set for no replacement or unintended routes, and retain the old artifact for rollback. A generated template alone is not hosted validation.
4. Run the full hosted fictional export matrix: fresh sign-in, own-job and cross-owner refusals, multipart checksum and byte bounds, exact-version download, cancel/expiry races, failed upload recovery, cleanup listing proof, scheduled sweep and alarm delivery. A skip, refusal on a positive path, or `not_configured` is not a pass.
5. Keep original-record retention, production BAAs/provider runtime coverage, workforce access, security review, physical devices and PHI activation as separate gates. This inspection makes neither app commercially ready or PHI ready.
