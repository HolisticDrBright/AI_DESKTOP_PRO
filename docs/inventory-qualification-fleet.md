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

GitHub runs `37919658629` and `37919663623` at this source are observed in progress, not completed passes. Both prior care-only engineering runs at `e12c982` completed successfully. The prior documentary head's main run `37916909284` succeeded, while browser run `37916913957` remains in progress. Skipped deployed-backend steps still do not count as AWS acceptance, and the historical encounter-request failure is not retroactively resolved.

### Remaining sequence

1. Finish a distinct, exact twelve-candidate target manifest and observer. Bind the reviewed target to each actual template, artifact manifest, immutable S3 version, Lambda code checksum, source identity and live 107 ledger. Existing historical target contracts must not silently accept this successor.
2. Qualify the native upgrade operator's interrupted-write custody and reconciliation against the actual synthetic target. Local stopped-process and embedded-database tests do not satisfy this requirement.
3. Only then perform the preserving, rehearsed 106-to-107 upgrade and deploy the exact compatible fleet in dependency order, with PHI off and production activation blocked. No partial fleet may stand in for compatibility qualification.
4. Execute complete hosted acceptance, including real S3/KMS export download and integrity, cancellation and late writes, cleanup and retention scheduling, recording/transcription/drafting, messaging/connection isolation and program adoption. Refused, skipped or unconfigured cases are not passes.

All six original commercial-readiness phases remain in scope. Current same-target source-verified ingredient and catalog releases, the separate catalog reader, authoritative acceptance under current adoption/consent/catalog locks, compatible identity recovery, Fullscript cart delivery, all nine positive erasure and processing journeys, provider/store/public-launch acceptance, exact matched backend/Desktop/mobile releases and physical iOS/Android remain required. Clinical holds and exclusions are unchanged, program supplement steps stay held, and human security, provider, clinical, retention and PHI approvals remain separate. Neither application is commercial or PHI ready.
