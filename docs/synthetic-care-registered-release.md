# Current synthetic care registered release

The current artifact binds the registered source47/live48 synthetic history to
one clean Desktop and V2 source pair. It replaces the build format for future
care releases; it does not revive the retired parent-schema release or change
the classification of its failed run. Build and local inspection are implemented.
The live deployment/recovery/acceptance runner is still engineering work.
Neither app is commercial or PHI ready. PHI remains off and paid mobile builds
remain held.

## Registered history and known predecessor

`scripts/care-canonical-migrations.mjs` checks every ordered source/reference
SQL identity and the exact unchanged terminal SQL. Its expected descriptor
does not establish a live observation. Actual read-only registration passed
under clean Desktop3904899 on October8 UTC; its receipt is
`docs/evidence/2026-10-08-care-intent-canonical-registration.json`.
Source47/live48, the historical alias,89 tables and23,985 original rows were
verified without replay or ledger rewriting. That receipt cannot authorize a
future run or replace a fresh live inspection.

The new artifact names the known intent-aware predecessor Desktop0e38c130 /
V2 1488a3bf, ZIP SHA256
`f8f995e09879eb7b45d17ffc5f18d5ecb9867f21c0a0795eacb3fd31ccaa0216`,
version `lagGFfNd0kIrsydunYd2WvicsWEX9tLC`,1,826,076 bytes. These are expected
identities, not a claim that the service was observed by the build. The target
remains account588966314750/us-east-2/clinical_core and the existing identity
API. The four known absent source routes remain absent; this artifact does not
authorize adding routes, privileges, PHI, providers or consent releases.

## Build and independent local inspection

Run from a clean committed Desktop checkout, with the paired clean V2 root:

```powershell
npm run build:synthetic-care-registered-release -- --v2-root "<V2 checkout>"
npm run inspect:synthetic-care-registered-artifact -- --v2-root "<V2 checkout>" --artifact "<directory returned by build>"
```

The build checks both lifecycle/recovery contracts, owner-erasure journal and
transport/UI hashes, and both synthetic iOS/Android build destinations. It
refuses production-verification flags, dirty sources, old parent history and
cross-app contract drift. It builds the actual Lambda source independently of
supplied artifact bytes and rechecks both source snapshots afterward. No AWS
client, credential access, SQL execution or mobile-build call exists here.

The immutable directory is
`dist/synthetic-care-registered-release/<Desktop commit>/<V2 commit>/<ZIP hash>/`.
It contains exactly `index.js`, `candidate.zip`, `release.json` and
`artifact-manifest.json`. The ZIP is deterministic with the two admitted entries.
Writes are exclusive, fsynced and reread. An identical repeat is allowed; a
different existing file is left unchanged and refused. Parent symlinks/junctions,
extra files and oversized/changing reads are refused. Operational journals and
receipts must live separately, not inside this four-file artifact directory.

Every artifact file is compared as bytes. Reformatted metadata and duplicate
JSON flags cannot be normalized into acceptance. Self-consistent checksums do
not prove source equivalence: `verifyCareRegisteredCandidate` explicitly reports
`sourceRebuilt:false`. `inspectCareRegisteredArtifact` rebuilds the actual current
clean sources, compares actual code bytes, and rechecks their snapshots; only
that local inspection reports `sourceRebuilt:true`. It still reports no live
target observation, deployment, release acceptance or device acceptance.

## Remaining live runner engineering

The next operator must use its own observations, never supplied report flags:

1. Independently rebuild the frozen candidate and qualify its exact application
   source pair separately from any later operator source. Observe the current
   synthetic assumed role, foundation, full registered ledger and preserved
   inventory afresh. Refuse root/long-lived credentials and unrelated targets.
2. Download and verify the actual predecessor ZIP/object version and actual
   managed Lambda bytes. Verify full CloudFormation parameters/resources and
   execution, IAM, encrypted logs, environment,51 JWT routes, authorizers,
   integration, stage and invoke policies. Refuse drift or partial inventories.
3. Admit one narrow immutable upload/change execution under durable exclusive
   custody. Bind exact current code and object version; preserve authority and
   route scope. Unknown responses are observed, never blindly retried. The
   already-registered schema is inspected, not replayed or down-migrated.
4. Rehearse compatible traffic recovery with actual Gateway requests and actual
   metrics, returning to the exact intended handler and removing temporary
   permissions. The ID-less/parent-only API is never a recovery substitute.
5. Run all declared fictional journeys: prepared/erased and prepared/cancelled,
   lost preparation and terminal replies, second-session discovery, both
   cancellation/erasure race orders, replay, cross-owner refusal and withdrawal
   refusal. Restrict mutations to approved fictional owners/fixtures and verify
   unrelated data preservation. A refusal, skipped step, mocked response or
   saved report cannot be a positive acceptance pass.

The old release, resumer, archived locks and historical inspection receipts
cannot authorize these new operations. Record unknown outcomes and retain
custody until independently reconciled; do not recreate retired locks.

## Verification and whole goal

The artifact/mapping suite passes18 tests, including actual clean paired-source
fixture builds and an invented bundle that fails independent rebuilding. All
care-script suites pass261 tests. Final typecheck/lint and CI YAML pass;16
canonical database/historical-command tests pass. The earlier full Desktop
run passes4,314 tests/11 skips; it predates this artifact increment and is not
its full-suite or hosted CI evidence. New CI runs the artifact suite explicitly.
No artifact-level test is an AWS or physical-device acceptance result.

The original six scopes remain partial: plan continuity/legacy reconciliation;
owned lab/document/voice delivery; complete privacy/holds/export/erasure and
retained-clinic amendments; eligible source-verified clinical/catalog/knowledge
releases; Core19.99 store/provider acceptance; matched API/Desktop/mobile and
physical iOS/Android/five-persona, rollback/load/security/recovery verification.
Clinical holds and exclusions remain. Reviewed policies, actual provider
agreement/runtime coverage and separate PHI activation are still required.
