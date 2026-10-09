# Inventory qualification fleet artifacts

The 107-migration inventory successor needs a complete, separately identified qualification fleet before it can replace the existing 106-migration services. The builder now packages all twelve candidates and their fifteen Lambda entry points. This completes artifact construction, not target qualification, deployment, recovery acceptance or production approval. PHI remains disallowed and paid mobile builds remain held.

## Build and tests

```powershell
npm run build:inventory-qualification-fleet
npm run test:inventory-qualification-fleet
npx vitest run src/server/clinical-core/inventory-qualification-envelope.test.ts
```

The default output is `dist/aws-clinical-core/inventory-qualification-fleet`. An optional `--out-dir=<directory>` isolates the output. No activation, PHI or target override is accepted. The builder makes no AWS calls, inserts no fixtures or approval rows, and changes no database.

The fleet manifest records the actual checkout commit, clean-source flag, source-input byte digest, profile, migration count and release digest. The source digest covers tracked and nonignored untracked files under `src`, `scripts`, `infra`, `data` and `.github`, plus package manifests and repository byte rules. Source bytes are checked before and after compilation; this is not an atomic filesystem snapshot. A dirty build is useful for local tests but cannot be admitted by the runtime.

The profile is `adopted-plan-inventory-qualification/1`. Its migration release is `542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c`, with 107 migrations. Historical builders and qualification inspectors remain strict about their original 106-migration release. Do not substitute the successor digest into historical compiled code.

## Package mapping

| Candidate | Lambda entry points | Packaging requirement |
| --- | --- | --- |
| personal-storage | `index.handler` | One version-pinned package |
| privacy-operations | `index.handler`, `retention-sweep.handler` | Both root modules in the same package |
| owned-lab | `index.handler`, `index.cleanup`, `worker.handler` | API and cleanup share one package; worker has its own |
| owned-voice | `index.handler` | One version-pinned package; ordinary draining deployment stays separate |
| recording-authority | `index.handler` | One version-pinned package |
| recording-capture | `index.handler` | Include `recording-capture-runtime.js` |
| recording-transcription | `index.handler` | Include `recording-transcription-runtime.js` |
| recording-drafting | `index.handler` | Include `recording-drafting-runtime.js` |
| recording-cleanup-review | `index.handler` | Include `recording-cleanup-review-runtime.js` |
| recording-cleanup-execution | `index.handler` | Include `recording-cleanup-execution-runtime.js` |
| care-messaging | `index.handler` | Separate compiled 107 entry point |
| care-connections | `index.handler` | Separate compiled 107 entry point; claim recovery remains independently gated |

The lab's historical API already exports cleanup; it was not missing. The new API wrapper retains both exports. The recording runtime files retain the original builder's exact bytes and relative module names. ZIPs use deterministic stored entries with verified checksums, lengths and central-directory offsets. Unsafe paths, duplicates, missing modules and oversized input are refused.

Each ordinary candidate retains the parent's IAM resources, routes, conditions, review inputs, retention controls and identity/consent enforcement. The narrowed templates restrict PHI to false, activation to blocked, account to `588966314750`, region to `us-east-2`, database to `clinical_core_qualification`, and source/profile/release to their exact values. Qualification defaults to disabled. Every Lambda code object has an explicit S3 version parameter. Original code-key defaults are removed rather than silently selecting an older object.

The ordinary handlers receive a compiled qualification envelope that verifies the target before loading their parent modules and checks for environment drift after asynchronous import. Parent results and arguments are unchanged. API refusals return a fixed unavailable response with no qualification marker; worker refusals throw and cannot count as successful cleanup. The envelope is not a substitute for each parent service's reviews, authorization or consent checks, and it does not prove the live database ledger. A separate complete-fleet observer is required.

## Local verification on October 9 2026

The first full fleet test run passed all 55 tests with no skips in 80.82 seconds. These tests build all candidates from source, verify the actual manifests/templates/ZIP bytes, check fifteen exports in subprocesses, exercise target/posture/review refusals and compare preserved resources and conditions. The qualification-envelope suite passed 19 tests. The existing care-artifact suite and ZIP suite passed 15 combined tests. Full typecheck and lint passed, and all twelve generated CloudFormation templates passed `cfn-lint`.

The ten existing infrastructure suites also passed all 54 tests without skips. The canonical production gate remains at 106 migrations with zero seeded rows. The AST-only Graphify refresh produced 14,741 nodes, 33,445 edges and 952 communities; 84 zero-node files remain absent and the HTML view is omitted by size. The shared canvas is unchanged.

These are local package and fictional-runtime results. No provider call, actual AWS deployment, permanent migration apply, production review, physical-device test or PHI activation occurred. Clean-build artifact hashes must be recorded after committing this engineering source; hashes from earlier care-only builds remain historical and must not be relabeled.

## Required sequence before deployment and activation

### Clean source checkpoint

Engineering source `188b3e45981ebad22f183404b1de1f5f3f18564e` is pushed and independently matches the remote branch. The complete rebuild reports `sourceClean=true`, input digest `4b0af9855e62bb5723b2dab1f112821d03e2f66336573a16a6563b3dc5f9db9a`, and fleet-manifest digest `a176dd49a3a2cbe23f24edb8e8fcf1e883a8333b130ed8300d6d8f17b789228c`. All twelve rebuilt templates passed CloudFormation lint. Every candidate manifest, template and deployment ZIP digest is preserved in [the clean-build receipt](evidence/2026-10-09-inventory-qualification-fleet-clean-build.json). This receipt refers to the actual engineering source, not a later documentary commit.

GitHub runs `37919658629` and `37919663623` at this source, and `37920254589` and `37920261266` at documentary commit `b9809a4`, have completed successfully. These checks were independently re-read on October 9. Skipped deployed-backend steps still do not count as AWS acceptance, and the historical encounter-request failure is not retroactively resolved.

### Distinct configuration and ledger checks

The new outer contract is `inventory-qualification-target/1`. Historical target loaders reject it. It requires all twelve candidates, every template parameter, actual manifest/template/package digests, thirteen individually version-pinned code objects under the source-specific prefix, separate consumer and workforce identity pools, the designated subjects, organization and the isolated synthetic account/database. Independent template rules still govern optional recovery, export and retention settings. A review digest binds an input; it is not proof of an actual human review.

The artifact reader checks the generated templates against the preserved parent transformations and recomputes each ZIP from its actual root module bytes. It bounds file reads even if a file grows during inspection and refuses links, traversal, changed metadata, missing modules, reordered/mismatched packages and source identity disagreement. This is local artifact verification, not live AWS resource observation.

```powershell
npm run test:inventory-qualification-target
npm run build:inventory-qualification-target
node dist/aws-clinical-core/inventory-qualification-target/index.cjs --check-configuration --target=<reviewed-target.json>
```

The CLI independently requires clean source and freshly rebuilds the fleet. It accepts no deploy, activation or provider operation. Its successful report explicitly keeps `liveTargetVerified`, `reviewVerified`, `acceptance`, `deploymentPerformed` and `phiAllowed` false. Fictional identities, review values and object versions in unit tests are never copied into deployment configuration.

The separate 107-ledger adapter verifies every ordered row against the complete immutable successor and its exact 106 parent. Its SDK transaction is repeatable-read and read-only, with statement and lock deadlines, one attempt per request and a mandatory rollback. It has no commit, DDL, DML, caller-supplied SQL or automatic write retry. A matching ledger alone does not prove schema definitions, data preservation, resource configuration or hosted acceptance. Historical 106 ledger checks remain unchanged. Complete observer support and real interrupted-write custody qualification are required before the permanent upgrade. Actual serving-fleet and 107-ledger verification follows the preserving upgrade and compatible deployment; the predecessor must not be mislabeled as a verified successor in preflight.

The initial completed local run passed 79 focused tests without skips. Typecheck, full lint, the four historical ledger tests and the canonical 106-migration zero-seeded-row gate also passed. Earlier failed runs remain failures: incomplete fictional release/scope/export/range inputs, the file-tamper test's default timeout, incorrect temporary-directory cleanup in tests, and the SDK union-command type error were repaired. Each configuration negative now first proves its baseline is admitted; an invalid fixture cannot manufacture a passing refusal test. The next clean-commit run also covers the added billing-origin binding. Successful configuration, SDK transport tests and CI are not full resource observation or hosted acceptance.

The clean source run at pushed commit `a6e71da17efec032d4e04ad44b89842639782eb5` passed all 80 focused tests without skips in 188.31 seconds. Its positive bundled-CLI case rebuilt the entire fleet a second time, observed clean source independently and matched the source and artifact digests, while keeping every live/review/acceptance/deployment/PHI flag false. Separate typecheck and full lint passed. A subsequent clean fleet build and independent readback of all twelve manifests/templates and thirteen package hashes are preserved in [the target clean-build receipt](evidence/2026-10-09-inventory-qualification-target-clean-build.json): input digest `24c9f4c05c555b7431b1d3ee1a2c63c4422bcee759fa122ac2ef00a974cffda7`, manifest digest `c007ea27b24189923b5c52d7e106de5869b14454ade6673404f8e3abb4f50132`.

GitHub runs `37925591760` and `37925598144` at that exact source are observed in progress, not completed passes. A read-only AWS foundation inspection reports `CREATE_COMPLETE`, `prepared_no_candidates`, qualification execution disabled, activation blocked and PHI false. No migration apply, deployment, provider request, new review/consent row or mobile build occurred. The latest AST-only graph contains 14,810 nodes, 33,643 edges and 958 communities; 85 zero-node files remain absent, the HTML view is omitted and the shared canvas is untouched.

All twelve templates from the final clean `a6e71da` build also passed CloudFormation lint. The documentary receipt preserves that actual engineering source identity; a subsequent documentation commit must not relabel it.

### Remaining sequence

1. Finish a distinct, exact twelve-candidate target manifest and observer implementation. Bind the reviewed target to each actual template, artifact manifest, immutable S3 version, Lambda code checksum and source identity. Support predecessor and not-deployed preflight without issuing an acceptance verdict. Existing historical target contracts must not silently accept this successor.
2. Qualify the native upgrade operator's interrupted-write custody and reconciliation against the actual synthetic target. Local stopped-process and embedded-database tests do not satisfy this requirement.
3. Only then perform the preserving, rehearsed 106-to-107 upgrade and deploy the exact compatible fleet in dependency order, with PHI off and production activation blocked. No partial fleet may stand in for compatibility qualification.
4. Verify the serving fleet and exact live 107 ledger, then execute complete hosted acceptance, including real S3/KMS export download and integrity, cancellation and late writes, cleanup and retention scheduling, recording/transcription/drafting, messaging/connection isolation and program adoption. Refused, skipped or unconfigured cases are not passes.

All six original commercial-readiness phases remain in scope. Current same-target source-verified ingredient and catalog releases, the separate catalog reader, authoritative acceptance under current adoption/consent/catalog locks, compatible identity recovery, Fullscript cart delivery, all nine positive erasure and processing journeys, provider/store/public-launch acceptance, exact matched backend/Desktop/mobile releases and physical iOS/Android remain required. Clinical holds and exclusions are unchanged, program supplement steps stay held, and human security, provider, clinical, retention and PHI approvals remain separate. Neither application is commercial or PHI ready.

## Resource observation components

The new `inventory-qualification-stack-observer.ts` maps every active declaration in all twelve fleet templates to observed CloudFormation physical identities. It requires complete stack and resource states, exact parameters and templates, complete unpaginated resource lists, conditional resource presence and exact outputs. Its bounded evaluator supports the fleet's Ref, GetAtt, Sub, If, Join, Split and Select expressions, including NoValue omission. Unknown expressions, missing references, unsafe selection, unfinished or unexpected resources and metadata changes between repeated reads are refused. Its member-profile adapter exposes only three read-only CloudFormation operations. The result proves declaration mapping, not actual service configuration, code, ledger, reviews or acceptance.

The new `inventory-qualification-code-observer.ts` reads one immutable artifact version directly through the S3 SDK, on the fixed Ohio endpoint and expected account. It checks the source-specific prefix, version, ContentLength, received byte count and SHA-256 with one attempt. Streaming is bounded to 46 MiB without a whole-object allocation; mismatch, truncation, overrun or a stalled body closes the stream and client. No clinical object, provider credential or caller URL is accepted. This is uploaded artifact verification, not Lambda deployment verification. The version and ownership constraints follow the [S3 GetObject contract](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).

The first declaration test run passed 93 cases but failed one retention fixture because scheduled cleanup requires separate export-cleanup activation. The fixture was repaired without weakening that requirement. A subsequent focused run passed 129 cases across five files; the added malformed-body closure case also passed in the two fast observer suites. These tests use fictional CloudFormation and SDK responses, not real deployed resources.

GitHub runs `37925591760` and `37925598144` at engineering source `a6e71da` completed successfully. Documentary commit `e2d7853` has a successful run `37926254159`, but run `37926249607` failed because Chromium system-dependency installation timed out after ten minutes before its browser tests began. This is a failed CI run, not app acceptance and not a passed browser suite. Its care-artifact job passed; the installation failure does not retroactively resolve earlier browser-request failures.

The complete observer still needs actual Lambda configuration/checksum and versioned-code integration, IAM/trust/policy and invocation isolation, API/authorizer/stage checks, logs/KMS/alarms, schedules, buckets/encryption/policies, DynamoDB, Step Functions, SQS, dependency/foundation identities and the exact whole ledger. The declaration and code components are not an alternative completion criterion. Real interrupted custody recovery, preserving upgrade, full deployment, hosted journeys, matched releases and physical-device acceptance remain required in the original six phases. No AWS mutation, migration apply, provider call, review insertion or mobile build occurred in this increment.
