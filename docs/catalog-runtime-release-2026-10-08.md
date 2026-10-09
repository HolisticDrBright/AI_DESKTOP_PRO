# Catalog runtime release and verification

The current catalog history is registered, but the deployed identity API and the retained recovery version have different source identities. The new catalog-runtime profile keeps those identities separate while preparing a matched successor. It provides source construction and read-only inspection, not upload, deployment, recovery rehearsal or PHI activation.

## Exact artifact identities

| Role | Desktop source | V2 source | ZIP SHA-256 | Storage or function version |
| --- | --- | --- | --- | --- |
| Deployed latest API | `9597fcb709482c8eb9bedb2841b27993844a4a6e` | `38ea48c07dc7d4ca7c2c37962b2a50ac178e381b` | `285f33d0c033d266b34febbf53336e1f1853873d31c29138f3fc92e52941b0fc` | S3 `wVlgZVgXihAPuhEl0e8uk9P__oUn75Mn` |
| Retained recovery API | `0e38c130fa212a7a418301b4b72094c649f8f2fe` | `1488a3bf85aca5e2c9a7b8b5c7179e314397dc66` | `f8f995e09879eb7b45d17ffc5f18d5ecb9867f21c0a0795eacb3fd31ccaa0216` | Lambda `2`, S3 `lagGFfNd0kIrsydunYd2WvicsWEX9tLC` |
| Catalog-runtime successor | Actual clean builder commit | Actual clean V2 commit | Derived from rebuilt bytes and metadata | Not uploaded or deployed |

The frozen deployed ZIP is 1,827,487 bytes. Retained version 2 is 1,826,076 bytes. Neither can be relabeled as the other. The original registered-release profile remains pinned to the older artifact and must refuse the newer deployed predecessor.

## Source and observation checks

`synthetic-catalog-runtime-release/1` builds a deterministic artifact from actual clean Desktop and V2 snapshots, the current three-row catalog mapping, cross-app contracts and the synthetic mobile destination. Its predecessor and recovery records are fixed definitions. The artifact requires subsequent same-target catalog ingredient and owner-adopted plan acceptance; it does not claim those features are complete.

The read-only inspector validates the frozen deployed source snapshots before invoking that source's original independent artifact rebuild. It does not import a current mapping into the historical release, patch saved metadata, or substitute an invented bundle. Current source is independently rebuilt too.

The complete live control inventory checks the actual template, exact versioned code key, all resources, all 112 API routes, the 51 identity routes, JWT authorities, integration, IAM, logging, permissions and the synthetic foundation boundary. Raw AWS observations remain unchanged. The managed Lambda bytes and exact S3 version must match the independently rebuilt deployed ZIP. Retained version 2 is separately downloaded and must have no qualified invoke policy.

Current database, control, retained configuration, source and STS observations are repeated. The database inspection binds the source commit and all preservation fingerprints. No saved receipt, environment success flag, CLI target override, supplied approval or historical inspection can replace those observations. A successful report explicitly grants no deployment or activation authority.

## Operator commands

Run these from the clean current Desktop checkout. Each path below identifies a local source or immutable artifact directory, never an AWS target override.

```powershell
node scripts/build-synthetic-catalog-runtime-release.mjs --v2-root <current-v2-checkout>
node scripts/inspect-synthetic-catalog-runtime-release.mjs --v2-root <current-v2-checkout> --artifact <new-artifact-directory> --custody-root <preserved-desktop-checkout> --deployed-desktop-root <frozen-9597fcb-checkout> --deployed-v2-root <frozen-38ea48c-checkout> --inspect-fictional-catalog-runtime-only
```

Only account `588966314750`, profile `ai-synthetic-member`, region `us-east-2`, API `wxv734oi12` and database `clinical_core` are admitted. Endpoint overrides are refused. The separate qualification database is not silently substituted for this existing synthetic staging target.

## Verification and remaining work

At parent source `069ab459a3fbe6ffce696eed072bebbd8c046a96`, the full local suite passed 4,455 tests across 351 files with 11 existing skips, in 622.27 seconds. The separate complete care Node suite passed 420 tests without skips. Hosted CI runs `37883308731` and `37883311843` completed successfully at that exact source. Skipped deployed-backend CI steps are not live acceptance.

The first focused run of this successor implementation passed 39 tests without skips, including the unchanged original registered-release/preflight suites and the new profile. Its tests cover cross-profile refusals, template/JWT/IAM/pagination drift, captured asynchronous witnesses, repeated observations, missing independent reconstruction, unknown authority fields, retained-version confusion and immutable artifact collisions. The live successor inspection and final-source build are still pending at document creation; record their results separately after they actually complete.

Next engineering must wire the distinct predecessor profile into the custodied upload, exact code-only proposal, execution, settlement and recovery workflow before deploying a successor. Reusing the older execution profile or normalizing observations is not permitted. Then qualify the updated identity and catalog runtimes and implement authoritative owner-adopted plan continuity with complete same-target ingredient inventory. All program supplement steps stay held until that inventory is available.

All six original commercial-readiness phases remain open. Positive processing, all nine erasure journeys, export/retention/voice recovery, provider and commerce acceptance, matched releases, physical devices and policy/provider reviews retain their original scope. Clinical holds, source-verification requirements and exclusions remain intact. PHI is off and paid mobile builds remain held.
