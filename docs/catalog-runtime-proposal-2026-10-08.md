# Synthetic catalog runtime deployment proposal

The original catalog runtime artifact has been deployed to the identity API; the completed execution evidence is recorded below. The proposal operator admits only a CloudFormation UPDATE that changes the Lambda code key and immutable S3 version. It never executes the change set itself: execution uses the separate fixed operator. Compatible recovery, the separate catalog endpoint deployment and acceptance, and authoritative owner-adopted plan inventory remain separate engineering and verification work.

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

## Completed synthetic proposal and preserved recovery evidence

Read-only process 87966 completed successfully at `2026-10-09T06:01:55.145Z`. Repeated actual observations found no matching change set for the first admitted run. The exact stopped writer's lock was archived and retired; its original journal remains. The original create outcome is still `unknown`, not retrospectively labelled a failed AWS write. No AWS mutation or retry occurred in reconciliation. The committed original receipt is `docs/evidence/2026-10-08-catalog-runtime-proposal-reconciliation.json`, byte-identical SHA-256 `65a6f8f3cd3ac37b532d3000f82f94ac2be335699b51ca298f4296aeb806dccc`.

After that settled observation, a separate fresh proposal process 8474 ran from clean operator `87e7ce96a41df075809e2d3bf928a628a8dc8bc5`. Run `5de94b1cbb644db501fc276941942341` started at `06:03:15.605Z`, admitted its single create at `06:07:05.974Z`, observed the returned change set at `06:07:33.577Z`, and completed at `06:12:03.072Z`. A full preflight renewal was independently observed at `06:10:19.783Z`; final publication remained within the unchanged 120-second deadline. Both complete views, the proposed template, actual encrypted artifact and unchanged predecessor controls passed readback. Shared custody settled and an independent filesystem listing found no shared locks.

The resulting change set is `catalog-runtime-a4ff17fe8c48c9caf5718c9eda86bcb5`, ARN `arn:aws:cloudformation:us-east-2:588966314750:changeSet/catalog-runtime-a4ff17fe8c48c9caf5718c9eda86bcb5/44ca72b3-81a5-4a66-9d62-f25b05de415d`, state `AVAILABLE`. The summary has two classified resources and the detailed property-value view has one; their digests are respectively `7505fe647f2038f846e074a735747e1f886140da666140d8adc97a2952f1787c` and `a3eae94efed0a7fc8aaa515ce31ab8614b50b0738b9b0d45d1f3425219d37de6`. The committed original receipt is `docs/evidence/2026-10-08-catalog-runtime-proposal.json`, byte-identical SHA-256 `26fd001cdc8b9c6e1e0624266a0cbd676bac8aeb60c456a8d36a7dcd499f6231`.

This is an unexecuted AWS proposal, not execution authority or deployment. Latest runtime remains the predecessor. Hosted CI for operator `87e7ce9` completed successfully in runs `37891034133` and `37891031852`. Clinical holds, source-verification gates, PHI OFF and the paid-build hold remain unchanged.

## Separate execution and deployment observation primitives

`scripts/catalog-runtime-deployment.mjs` adds the distinct fixed catalog profile rather than changing historical registered-release assertions or rewriting AWS responses. It requires its own complete fresh preflight, two unchanged before observations, exact immutable artifact readback and awaited durable admission before a single execute port. It captures candidate, source and artifact witnesses before the first asynchronous call and passes copies of the admitted binding to external ports. Expiry or source, principal or custody loss after admission refuses before execution. A lost execute reply permits observation of that same execution only, never replay.

Post-execution verification requires both actual completed change-set views, exact downloaded ZIP bytes, a changed Lambda revision, unchanged full IAM/JWT/route/configuration/resource identities, and complete canonical database preservation. Final object and awaited journal boundaries recheck freshness and identity before returning success. A separate stopped-writer profile preserves historical admission while requiring current database inspection under the current clean operator identity. A retained-route observation is distinct from latest restoration and certifies neither recovery nor release.

The focused suite passes 31 tests without skips: 19 catalog tests and all 12 unchanged registered-deployment tests. A copied source-text assertion initially still expected the old un-copied execute argument; it was updated for the intentional binding capture, while the historical test remains unchanged. These are fictional transport tests. No live execution/reconciliation/recovery operator or hosted deployment is asserted by them. Public execution custody, interruption recovery, compatible routing rehearsal, exact hosted feature acceptance and authoritative adopted-plan inventory integration still need implementation and actual qualification.

The final broader care/catalog/principal regression passed 522 tests without skips in 62.587 seconds. Independent compilation of the current operator checkout and frozen application reproduced the original 1,868,663-byte API bundle, SHA-256 `c17009886939c39a901d2197274ac30c65235127dc342757ed97d6aa634976fa`; neither changes the already uploaded ZIP identity. AST-only Graphify refresh produced 14,448 nodes, 32,602 edges and 926 communities; 77 zero-node files remain absent and the large HTML visualization is omitted. Navigation output is not deployment or feature acceptance.

## Public synthetic execution and interruption recovery

The public operator now executes only the existing, uniquely named catalog change set. It independently rebuilds the operator and frozen application bundles, reads the immutable encrypted S3 version, preserves the distinct source identities, and constructs complete fresh AWS and database observations. It uses the existing shared custody namespace. Two immutable before observations and the hashed admission are saved before its single execute call. An uncertain reply permits observation of that same execution, not replay. Publication requires a second complete post-execution readback and unchanged source, storage, database, routes, IAM and resource identities.

```powershell
node scripts/catalog-runtime-execution-live.mjs --v2-root <current-v2-checkout> --artifact <original-artifact-directory> --custody-root <preserved-desktop-checkout> --deployed-desktop-root <frozen-9597fcb-checkout> --deployed-v2-root <frozen-38ea48c-checkout> --application-root <frozen-65e248f-checkout> --execute-fictional-catalog-runtime-code-only
```

An admitted failure retains the original lock, journal and evidence. After the actual writer stops and the 60-second settlement interval passes, the read-only command requires the exact journal order, hashed historical observations and admission, then three stable live observations. It accepts a fully verified completed deployment or a still-available proposal with the actual predecessor ZIP; partial, pending, rolled-back or changed execution remains held. The original execution outcome stays unconfirmed. Only immutable local receipt and lock-archive readback allow retirement of the exact stopped writer's local lock. No AWS execution, retry, deletion or response rewriting occurs.

```powershell
node scripts/catalog-runtime-execution-live.mjs --v2-root <current-v2-checkout> --artifact <original-artifact-directory> --custody-root <preserved-desktop-checkout> --deployed-desktop-root <frozen-9597fcb-checkout> --deployed-v2-root <frozen-38ea48c-checkout> --application-root <frozen-65e248f-checkout> --reconcile-fictional-catalog-runtime-execution-only
```

The first before observation is validated at its original archive boundary; the renewed final observation must still be fresh at admission. Historical timestamps are not rewritten. A final revision or control change refuses publication even when the earlier deployment observation passed.

The 11 new custody and public-operator tests pass; combined with the earlier catalog deployment suite, 30 focused tests pass. The broader care/catalog/principal run passed 533 tests without skips in 67.810 seconds. Standalone typecheck, full lint and diff checks passed. The positive completed-deployment reconciliation path is covered with fictional transports; the available-proposal path has negative coverage but has not yet been positively qualified against the pinned predecessor bytes. AST-only refresh completed with 14,481 nodes, 32,844 edges and 948 communities; 77 zero-node files remain absent and HTML visualization is omitted. Both hosted CI runs at the preceding `d4ccba2` source completed successfully (`37893182458`, `37893179950`); these are not CI or hosted evidence for the new operator.

No live execution result is asserted by these source checks. Even a successful deployment receipt requires separate compatible routing recovery, same-target catalog and complete ingredient acceptance, owner-adopted plan integration, and the remaining six-phase journeys. All clinical holds, source-verification requirements, PHI OFF and the paid-build hold remain unchanged.
## Completed identity API deployment and remaining catalog work

The authorized code-only execution completed successfully on October 9, 2026. Run `76172424668b9bfbf737304682807481` admitted one execution at `06:56:15.826Z`, observed terminal AWS execution at `06:57:04.205Z`, completed two full deployed readbacks at `06:58:33.877Z` and `06:59:48.915Z`, and settled its original custody at `07:00:02.526Z`. An independent listing found no shared locks. No uncertain execution reply or recovery replay occurred.

The original execution receipt is preserved byte-identically as `docs/evidence/2026-10-09-catalog-runtime-execution.json`, SHA-256 `1e7326d369af71ca281f100b6845f7f1038a30467faa28d606a7a6e6edd964d9`. The deployed identity function `wxv734oi12-synthetic-identity` contains the original frozen `65e248f6ecd84a442b1511c52087cd708d7f792b` application ZIP, 1,874,730 bytes, SHA-256 `ef9f9d38b755e0aa62da13a848181cc586988ba5bed4c328ab7948114abc27e3`, revision `fb841759-6280-40a9-ab16-32c6433703f9`. IAM, routes, authorizers, integration, resource identities and the canonical database remained unchanged. PHI remains disabled; no paid mobile build started.

This is identity API deployment evidence, not catalog endpoint acceptance. The separate `wxv734oi12-synthetic-staging-catalog` function has not received the updated reader in this execution. Compatible recovery, current catalog deployment and acceptance, complete same-target ingredients, authoritative owner-adopted inventory, and the remaining six-phase requirements are still open.

Hosted main CI `37895353974` completed successfully at operator commit `31c5fda84c361f36faf70b7ee6cd26dbd4b06722`. Browser CI `37895362162` failed: `e2e/live-sync.spec.ts:199` lost the socket during its first delivery callback; 77 tests passed, one failed and 13 did not run. The failure is under investigation and is not reclassified as a pass or dismissed by a rerun.
## Fixture connection repair and unchanged browser journey

The preserved failed CI trace shows a completed navigation and a valid event ID before the first delivery callback disconnected in about six milliseconds. The fixture continued serving later tests. It does not identify the original socket at server level, so stale reuse is a supported mechanism, not a retrospectively proven cause of that exact request.

`scripts/fixture-json-response.test.mjs` reproduces the unknown-write failure with a real HTTP server on a separate thread: an actual server-close signal arrives while the client is paused, and the next pooled POST fails with `ECONNRESET` on a reused socket. `fixture-json-response.mjs` closes JSON response connections explicitly; the actual fixture imports that helper. Positive tests prove no pooled socket remains, the next callback uses a new connection exactly once, and HTTP 503 stays a refusal without replay. Browser retries remain zero and all existing sync assertions are unchanged. The production clinical API is untouched.

Four transport tests and the combined 46-test deployment/custody/transport regression passed without skips. Full typecheck, lint and diff checks passed. The unchanged local `e2e/live-sync.spec.ts` passed all 21 tests in 2.4 minutes, including delivery acknowledgment after reload, duplicate protection, scope withdrawal, cross-tenant denial and console/off-origin checks. This is local synthetic contract-fixture evidence, not hosted AWS acceptance, a physical-device result or a replacement for the failed historical CI run. New hosted CI must independently run the repaired source.

## Adopted plan ingredient inventory candidate

The independent personal-storage API now has a read-only, JWT-protected `GET /clinical-core/consumer/personal/active-plan/inventory` route. It resolves the owner's exact adopted record, revision, content digest and consent revision in the same database as the governed product versions. A newer received plan never replaces the adopted pointer. Consent withdrawal refuses access; a regrant requires renewed adoption. A stale record, missing item identity, unknown dose, unknown status, unresolved peptide or incomplete label mapping leaves the inventory held.

The inventory covers the adopted plan only. It is not an inventory of all medications, an interaction assessment, a dosage calculation or clinical clearance. It returns explicit unresolved items and a digest bound to the owner, adopted pointer, products and holds. The V2 client validates that contract, verifies the digest and discards replies if the account changes. The device-preview helper always reports incomplete; local cache contents and ingredient highlights cannot release a program supplement.

### Separate schema candidate and review authority

`infra/aws-clinical-core/production-candidates/owned-plan-inventory.sql` adds three protected functions: full-ingredient verification, verification withdrawal, and the owner-specific inventory source. Verification requires actual workforce catalog-admin membership, a source-verified full mapping and exact product/version/label hashes. It appends the reviewer's identity and timestamp through the existing immutable label-verification history. Consumer callers and workforce practitioners without catalog-admin authority cannot sign it. Historical prose notes and recalled or partial mappings remain unresolved; no catalog package was marked fully verified by this change.

Production product-version UUIDs and staging label keys are different identities. The production inventory uses the former; the staging importer validates an optional separate crosscheck block against its own product and label hashes. It does not convert marketing text into a full inventory or substitute one target's label identity for another.

`npm run build:adopted-plan-inventory-candidate` builds a distinct 107-migration artifact. Its parent is the unchanged 106-migration qualification ledger `514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b`; its successor ledger is `542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c`. The candidate is explicitly not deployed, activation blocked and PHI disallowed. The historical qualification gate rejects it. It must receive a distinct forward-apply/inspection/recovery profile; do not widen the historical gate, apply it to staging `clinical_core`, or count old 106-migration evidence as qualification of this successor.

### Verified scope and remaining integration

Seven Desktop suites passed 99 tests without skips, including all 107 migrations in PGlite under the API role, owner and consent isolation, review authority, immutable parent-byte checks and default-blocked infrastructure. V2 passed 29 focused tests, typecheck, targeted lint and the capabilities, disclosure and TestFlight source gates. These are local source and embedded-database results, not hosted AWS or physical-device acceptance.

The staging program acceptance path is not yet integrated with this production inventory. It must recheck the authoritative snapshot, current catalog and consent at acceptance; a read-only snapshot is not an authorization token. Complete reviewed ingredient releases on the same target, the separate catalog reader deployment, compatible recovery, hosted program journeys and all remaining original six-phase journeys are still required. Program supplement steps remain held. PHI remains disabled and paid mobile builds remain held.

### Preserved hosted browser failure

At predecessor `fcb8d9c`, main CI `37898435939` succeeded and browser CI `37898440713` failed. The old sync callback test passed, but `e2e/live-capture-resume.spec.ts:140` failed during setup's POST to `http://localhost:3114/api/live/emr/encounter` with `ECONNRESET` (90 passed, 19 skipped, one failed in that shard). This distinct failure remains unresolved; no retry or relaxed assertion replaces its evidence. The current candidate still requires independent hosted CI and acceptance.

## Separate qualification inventory upgrade operator

The distinct 106-to-107 inventory transition now has a bundled operator. It accepts only the fixed synthetic member account, Ohio region and completed qualification foundation. SQL is embedded in the bundle; command-line and environment target overrides, dirty-source writes, production activation and staging `clinical_core` are refused. The canonical 106-migration builder and historical qualification gates remain unchanged.

An upgrade must first execute the actual migration in a rollback-only rehearsal, independently inspect the rolled-back database, and reobserve the same AWS principal and foundation. The committing transaction locks the entire registered table inventory and migration ledger, then compares the exact rehearsal data, schema and ledger state before DDL. A changed prestate refuses admission. The single successor adds three protected functions and one migration receipt; it must not change any application row, historical receipt, table, constraint, index, policy, internal foreign-key trigger, role, membership, default grant, type or existing function. The new functions require their exact bodies, owners, search paths and execution permissions, with no delegation grants or unexpected overloads.

The operator does not automatically retry a write after an uncertain provider response. Such an outcome requires read-only inspection of the same target and further reconciliation; this source increment does not provide durable interrupted-write custody or certify that an interrupted run preserved its original prestate. An already-applied no-write replay is not retrospective evidence of an earlier interrupted execution.

```powershell
npm run build:adopted-plan-inventory-upgrade
node dist/aws-clinical-core/adopted-plan-inventory-upgrade/index.cjs inspect
node dist/aws-clinical-core/adopted-plan-inventory-upgrade/index.cjs rehearse --confirm-fictional-adopted-inventory-upgrade
```

Do not run the separate `upgrade` action until the new target manifest and candidate fleet support the 107-migration identity and its interruption/recovery procedure is qualified. Applying it now would invalidate historical 106-migration inspectors. This tool does not activate a candidate, approve ingredients or release program supplements.

### Verification and observed database state

Five focused suites passed 91 tests without skips, including actual PGlite DDL, rollback, no-write replay, concurrent-prestate refusal, function permission failures and the built command's target-override refusals. Negative testing found that the initial schema witness omitted internal foreign-key triggers; it now includes all triggers and tests their loss. The first artifact test also incorrectly prohibited file reads in bundled AWS credential code; the corrected assertion applies to the application migration loader, while the built CLI is physically tested from an unrelated directory with AWS unavailable. Typecheck passed.

A read-only run of the dirty-source operator observed account `588966314750`, foundation `ai-clinical-core-qualification-foundation`, 106 migrations, 209 application tables and 46 rows. Data digest: `cbd17d4480be6ca45d6e20dfce06fdd49a374cb7bdcb27883d31cd110b4b14a4`; historical schema digest: `a9b0b647966fe76bbc6e9617cf56d895007f325b01714a65692598d1ed93ea73`. The result explicitly reports `clean:false`, `applied:false`, PHI disallowed and activation blocked. It is hosted read-only inspection, not a clean-source rehearsal, migration or feature-acceptance result.

Desktop CI `37903644781` and `37903648961` at prior inventory source `4507677` completed successfully; V2 CI `37903652883` and `37903657240` at `4f9cff1` also completed successfully. Desktop's deployed-backend setup, build and test steps were skipped because secrets were absent, so that job supplies no hosted API acceptance. These are earlier-source results and do not qualify this new operator. The historical encounter-request failure remains unresolved.

All six original readiness phases remain open. Same-target reviewed ingredients, program acceptance integration, the separate catalog reader, compatible recovery, Fullscript cart delivery, positive erasure and processing journeys, provider/store acceptance, matched releases and physical devices remain required. PHI stays off and paid mobile builds remain held.

### Hosted rollback rehearsal at clean source

Clean source `2162bca6084eab3780681ba47f56eb23696c1f8e` was pushed and independently matched to the remote branch. Its rebuilt operator has SHA-256 `6539e65ac2f49027344fb87d96209a1f5fbf1fe32f3955dcd21b6db4208bb26c`. The actual AWS `rehearse` command completed successfully: all successor DDL, new-function body/permission checks and preservation checks ran, then the transaction rolled back. Independent post-rollback inspection confirmed 106 migrations, 209 tables, 46 rows and the same data and historical-schema digests recorded above.

The returned receipt is preserved in `docs/evidence/2026-10-09-adopted-inventory-rehearsal.json`; the build identity is in the adjacent operator-build receipt. This is hosted rollback-only qualification of that exact tool. It is not a permanent migration apply, interrupted-write recovery, compatible candidate deployment, API acceptance or approval to release a program supplement. Existing application deployments and data remain unchanged. CI for `2162bca` is separately in progress; none of its run statuses is claimed as a completed pass.

### Expanded metadata preservation checks

The later source expands the schema witness to full column, constraint and index metadata, plus replica identity and table options. It also pins the successor receipt's name, both in the embedded artifact and the actual ledger. The historical 106 receipts remain preserved as observed rather than rewritten. These checks do not change the extension SQL, either migration-release hash or any historical gate.

Five focused suites passed 94 tests without skips after these additions. A negative test initially attempted to relabel the new receipt before it existed, producing no mutation; it now injects the change after INSERT and requires `history_refused:final_history`. The compound inspect/rehearsal/commit/replay test initially exceeded its default five-second test deadline after metadata expansion; its own deadline is now 30 seconds, while all assertions and the operator's five-second lock and 30-second statement limits remain unchanged. Both earlier failed runs remain failures, not retroactively counted as passes.

The `2162bca` hosted rehearsal above qualifies only its original witness. The expanded witness produces a different schema digest and requires its own clean-build hosted rehearsal. A digest change between witness versions is not, by itself, evidence of changed database objects; compare before and after using the same operator artifact.

### Hosted verification of the expanded witness

The expanded operator was committed, pushed and rebuilt from clean source `ae2300d483d970028b40cadfb55c64202633a83b`, with bundle SHA-256 `7a273b59410fa45d62ceac917f0d9f2f32505f11829831f35490f3d02da9cfe9`. Its actual AWS rollback rehearsal completed successfully and independently confirmed the same 106-migration, 209-table, 46-row predecessor. The data digest remains `cbd17d4480be6ca45d6e20dfce06fdd49a374cb7bdcb27883d31cd110b4b14a4`. The expanded historical-schema witness matched before and after at `f038481492c2d628411e31fb5d484815b16e9a7be82adeb064fab16eb2444a14`.

The separate expanded rehearsal and build receipts are preserved alongside the original receipts in `docs/evidence/2026-10-09-adopted-inventory-rehearsal-expanded.json` and `docs/evidence/2026-10-09-adopted-inventory-operator-expanded-build.json`. Full lint and typecheck passed. The AST-only refresh completed with 14,604 nodes, 33,073 edges and 949 communities; 80 zero-node files remain absent and the HTML view is omitted by size. These results qualify the expanded rollback path only, not interrupted recovery, a permanent upgrade or deployed features. CI `37908265589` is observed in progress and `37908259888` queued at this exact source. Clinical holds, PHI OFF and the paid-build hold are unchanged.

### Durable upgrade custody and read only reconciliation

The native CLI now binds the original shared `DESKTOP_COMMERCIAL_20261005/dist/synthetic-care-routing/operator.lock` namespace, the actual running bundle bytes and a transaction-held database operator fence. Before publishing a shared lock it writes, flushes and reads back immutable source/header files and a baseline journal. Hash-linked journal stages record the rehearsal, write admission, write reply and independent readbacks. Unknown writes are never automatically retried, and a finding leaves the original lock in place. Foreign locks, changed bytes, lost database fences and live recovery guards are refused.

The public recovery command is `reconcile --reconcile-fictional-adopted-inventory-upgrade`. It requires the same clean, frozen operator build and actual target configuration, preserved original custody, an observed stopped original PID and the settlement interval. It takes the real migration and table locks under READ COMMITTED for three independent inspections. No DDL, DML, inverse migration or provider-write retry runs during reconciliation. A complete admitted-write journal may reconcile either preserved predecessor or successor; a torn final event cannot create admission. The receipt always retains `originalWriteOutcome: unknown` and archives the original bytes rather than pretending to recover a missing write response.

Recovery retires its subsidiary guard before the original operator lock while holding the database fence. Interruption between those steps leaves the original lock recoverable. An orphan or foreign guard is not blindly removed. This source protects process-interruption custody; it does not certify disk power-loss, real AWS transaction expiry or deployed release compatibility. The current build manifest explicitly reports `hostedRecoveryQualified: false`. Do not perform the permanent 107 upgrade until the distinct compatible target/fleet profile and real hosted recovery checks exist.

The final seven focused suites passed 123 tests without skips in 102.53 seconds, run sequentially without weakening assertions or deadlines. The first focused run passed 68 tests. An intervening broader run passed 121 and failed two: one live-guard test checked the guard before its required interval, and one full-schema mutation test exceeded its unchanged five-second deadline under concurrent suites. The clock setup was corrected; both earlier failed runs remain failures. CI runs these resource-heavy operator suites sequentially too. Full typecheck, lint and the canonical 106-migration/zero-seed gate passed. The AST-only refresh produced 14,647 nodes, 33,246 edges and 956 communities; 82 zero-node files remain absent and HTML is omitted by size. GitHub CI for both expanded-witness runs and both documentary-checkpoint runs is now observed completed successfully; this does not turn skipped deployed-backend steps into hosted acceptance.

All six original commercial-readiness phases remain in scope. Same-target catalog/ingredient releases, authoritative program acceptance, separate catalog deployment, compatible identity recovery, Fullscript delivery, all nine positive erasure and processing journeys, provider/store/public-launch acceptance, matched releases and physical devices remain required. Clinical/source holds, PHI OFF and the paid-build hold remain unchanged.

The clean custody source `4b86bc413041ca62f46ffa52ba295694c3fe463c` was pushed and its remote head matched. Its rebuilt bundle SHA is `360bb439ef48991167a07fba10034f83e1d2b6da914023d240c235bd8cc7dced`. Actual AWS read-only `inspect` completed successfully against the qualification foundation: 106 migrations, 209 tables, 46 rows, unchanged data digest `cbd17d4480be6ca45d6e20dfce06fdd49a374cb7bdcb27883d31cd110b4b14a4` and expanded schema digest `f038481492c2d628411e31fb5d484815b16e9a7be82adeb064fab16eb2444a14`. The returned observation is preserved in `docs/evidence/2026-10-09-adopted-inventory-custody-source-inspection.json`. This confirms the predecessor, not interrupted-write recovery. New CI `37913046456` and `37913053372` is observed in progress; no completed pass is claimed. Shared Graphify entry 429 was appended with a modification-time guard and its entire prior prefix verified unchanged; canvas untouched.

## Separate inventory care qualification profile

The subsequent complete artifact build and its remaining target/deployment requirements are documented in [Inventory qualification fleet artifacts](inventory-qualification-fleet.md). That build supplies all twelve candidate packages, but does not replace the distinct target observer, recovery qualification or hosted acceptance required below.

The care messaging and connection services now have separate compiled entry points for `adopted-plan-inventory-qualification/1`, pinned to the exact 107-migration successor. The original entry points and builders retain their 106 contract. The new runtime refuses PHI, approved production activation, a different account, region, database, source, release or missing profile. It admits only designated fictional subjects after the existing independent reviews, identity, consent and metadata checks. A disabled qualification profile remains inert. Claim recovery remains a separate opt-in with its own review.

The new builder writes into `dist/aws-clinical-core/inventory-care-qualification`, leaving the historical output untouched. It recompiles the two new entry points, retains the original permissions and review conditions, limits template parameters to PHI false, activation blocked and `clinical_core_qualification`, and binds code, deterministic ZIP, template, source input and migration digests. It records the actual clean or dirty source state; dirty artifacts cannot serve qualification requests. Input bytes are re-read at the end of the build, including untracked source files. This is a before/after build check, not an atomic filesystem snapshot or interrupted-write qualification.

```powershell
npm run build:inventory-care-qualification
npm run test:inventory-care-qualification-artifact
npx vitest run --no-file-parallelism src/server/clinical-core/inventory-care-qualification.test.ts src/server/clinical-core/inventory-care-qualification.database.test.ts
```

Negative testing exposed a real messaging gap: malformed function metadata could construct a data client before refusal. The handler now validates exact function identities, privileges and digest shapes before client construction, and captures them before asynchronous work. The first new test run had 53 passes and three failures: that defect and two incorrect workforce test fixtures. Those fixtures now exercise practitioner invitation issuance, not a patient-only status action; the route and reauthentication checks were not weakened. A subsequent four-suite run passed 101 tests. The final five-suite run, including two additional independent-review cases and the existing actual-SQL messaging regressions, passed 124 tests without skips in 14.21 seconds. The 12 artifact tests, full typecheck, full lint, both generated CloudFormation templates and unchanged canonical 106-migration/zero-seed gate passed.

CI at the previous committed heads is now observed complete and successful: `4b86bc4` runs `37913046456` and `37913053372`, and `ad9a20e` runs `37913420090` and `37913426480`. This is previous-source CI, not verification of the new profile; skipped deployed-backend steps still supply no AWS acceptance. The historical encounter-request browser failure is not retrospectively resolved by these passes.

The new artifact deliberately reports `fleetComplete:false`, `hostedVerified:false` and `deploymentPerformed:false`. The other ten candidate bindings, a distinct complete-fleet target contract and actual target observer are still required. Neither the two service builds nor local execution of all 107 migrations qualifies permanent AWS upgrade, interrupted recovery or program adoption. Do not widen historical gates or apply 107 yet. All six original phases, the held supplements, source requirements, PHI OFF and paid-build hold remain unchanged.
