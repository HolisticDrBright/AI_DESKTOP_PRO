# Synthetic catalog runtime deployment proposal

The catalog runtime artifact is uploaded, but the running identity API has not changed. The proposal operator admits only a CloudFormation UPDATE that changes the Lambda code key and immutable S3 version. It never executes the change set. Deployment, compatible recovery, same-target catalog acceptance and authoritative owner-adopted plan inventory remain separate engineering and verification work.

## Exact source and target

The uploaded application source is Desktop `65e248f6ecd84a442b1511c52087cd708d7f792b` paired with V2 `e92116b154dd1a206262926388cffe90ac5c06ce`. The artifact is 1,874,730 bytes, SHA-256 `ef9f9d38b755e0aa62da13a848181cc586988ba5bed4c328ab7948114abc27e3`, stored at immutable S3 version `d8uA5e4HL6vnpWXr9UiWYITVp2VeiU42`. The original upload receipt and frozen source are preserved. Hosted CI runs `37887166901` and `37887163408` at that exact source completed successfully; this does not prove runtime acceptance.

The later operator must itself be a clean paired checkout. It independently compiles both its own API source and the frozen uploaded application source, requiring both bundles to equal the candidate's actual bytes. It separately preserves the operator source identity, application identity, mobile contracts, canonical migrations and template hash. Operator-only updates cannot silently relabel the uploaded artifact or introduce changed runtime code.

The account, region, API, stack, database, buckets and identity pools remain fixed to the existing synthetic staging target. The latest deployed predecessor and retained recovery version 2 are distinct fixed profiles. No raw AWS response is rewritten to match either profile. Production account `173535830222` is outside this command's scope.

## Proposal admission

The public constructor accepts only six source-path pairs and the explicit proposal action. It accepts no saved report, target, profile, execution, approval or activation override. It constructs its own fresh observers and uses the preserved sibling checkout's existing shared custody namespace.

```powershell
node scripts/catalog-runtime-proposal-live.mjs --v2-root <current-v2-checkout> --artifact <uploaded-artifact-directory> --custody-root <preserved-desktop-checkout> --deployed-desktop-root <frozen-9597fcb-checkout> --deployed-v2-root <frozen-38ea48c-checkout> --application-root <frozen-65e248f-checkout> --prepare-fictional-catalog-runtime-code-change-only
```

Admission requires the complete canonical database inspection, repeated full AWS controls, independently rebuilt predecessor, distinct retained version and an actual encrypted S3 version readback. The 120-second freshness limit is unchanged. Expired observations may be renewed only through a complete new preflight before a write or publication; a failed validation is not renewal permission. Journal admission is awaited and rechecked before a single create request. An unknown create response is never automatically retried.

Both CloudFormation views and the complete before/after property contexts are mandatory. All non-code properties, IAM, JWT routes and target identities must remain unchanged. The API integration's dependency projection is classified but not claimed to be a proven no-op. The saved report is not execution authority. After storage readback, the operator rereads both proposal views, template and full predecessor controls, and checks the original fresh admission deadline again before settling custody.

## Interrupted proposal recovery

An admitted failure retains the exact shared lock and append-only journal. Read-only reconciliation requires the writer process to be demonstrably stopped, at least 60 seconds since its last journal entry, the exact admitted journal prefix and its original operator/application bindings. A crash may leave no final error entry; a skipped observation or verification step cannot masquerade as completion.

```powershell
node scripts/catalog-runtime-proposal-live.mjs --v2-root <current-v2-checkout> --artifact <original-artifact-directory> --custody-root <preserved-desktop-checkout> --deployed-desktop-root <frozen-9597fcb-checkout> --deployed-v2-root <frozen-38ea48c-checkout> --application-root <frozen-65e248f-checkout> --reconcile-fictional-catalog-runtime-proposal-only
```

Reconciliation reobserves the actual caller, unchanged source, custody, encrypted object, complete target controls and proposal twice, with a final third control/object boundary. An executed, changed, partial or unstable proposal is refused. Absence is an observation, not proof that the original create failed. The original create outcome remains unknown; there is no AWS mutation, deletion, retry or execution port. Only exact immutable local archive and receipt readback permit retirement of the stopped writer's original local lock. Remote objects, change sets and the original journal are preserved.

## Source verification and remaining work

The proposal/projection/reconciliation suite passes 33 credential-free tests. The preceding combined regression run passed 88 tests without skips; a final publication test was added afterward and the focused 33-test suite passed. Initial test-port errors were corrected: a copied timing fixture spent the freshness window during the new post-admission check, and the successor-control fixture addressed a nonexistent singular integration field. Production freshness and raw-response checks were not weakened. Type checking and full lint passed before the final publication check, and focused lint passed after it.

No live proposal, deployment or hosted reconciliation result is asserted by these source tests. Exact AWS receipts and later verification results belong in separate checkpoints. All six original phases remain open: adopted-plan and same-target ingredient continuity; positive lab/document processing and recovery; nine erasure journeys, exports, retention and voice; catalog safety and source verification; providers and commerce; exact matched releases and physical devices. Fullscript cart delivery and the production program/privacy ports remain real engineering, not human-only checklists. Clinical holds, exclusions, source-verification requirements, synthetic-only restrictions and the paid-build hold are unchanged.

The final broader care/catalog/principal regression run passed 498 tests without skips in 56.964 seconds, including the 33 new proposal tests and unchanged earlier release/upload/recovery checks. Upload-documentation head `5858852c3e9fe35231312c6bcfb25c30b9c61595` also completed both hosted CI runs successfully (`37887887717`, `37887885021`). Those are earlier-source CI results, not hosted verification of this new operator.

## First live proposal finding and read latency repair

The first live run at operator source `c6bac1470dea8cc0e24004fdab21b3d7b8c8406c` stopped with `catalog_runtime_upload_preflight`. Process 70239 exited 1; writer PID 17728 is stopped. Run `71d0b4478f078133066cca5a601e00c2` began at `2026-10-09T05:44:44.943Z`, durably admitted a create at `05:49:10.354Z`, then refused at `05:49:44.393Z` during the post-admission guard, before the create call. The exact original lock and journal remain. Admission is not proof that AWS received a create; no change set or deployment success is claimed. The conservative reconciliation result must keep the original create outcome unknown.

Repeated serial AWS control reads consumed the deadline. The later operator adds a complete bounded asynchronous observer: at most four read requests run concurrently, all pages and policy reads remain mandatory, both STS identities must agree, and every started read settles before an error returns. No data is cached or rewritten, no mutation is added, no write is retried and the freshness deadline remains 120 seconds. The existing serial observer and historical artifacts remain unchanged.

The expanded proposal suite passes 38 tests, including full raw-inventory equivalence, pagination, four-reader limits, error draining, identity drift and incomplete policy/route refusal. The first run of the new test file contained a malformed regular-expression terminator; it was corrected before the suite and focused lint passed. Source tests do not settle the retained live custody or prove a new hosted result. The next live command must be read-only stopped-writer reconciliation, not another proposal attempt.

Final regression after the read-latency repair: 503 care/catalog/principal Node tests passed without skips in 62.914 seconds. Standalone typecheck, full lint and diff checks passed. The deployed application and original uploaded artifact remain unchanged.
