# Catalog reference registration

The synthetic database now contains the third catalog migration. The current source registry and read-only registration inspector must describe that history exactly. This increment preserves the earlier two-migration history explicitly for archived release tests; it does not turn an old inspection into current release authority.

## Verified synthetic apply

Run `07dd6f805a8ff49528e05127bbac039d` completed at Desktop source `a7c40e58bbacf9d343a5dbe0e2a90531e2523e84`. Its terminal returned exit zero. The command completed the mandatory rollback rehearsal, independent-writer lock race, exact fixture cleanup, preserving apply, separate post-commit readback and final custody settlement. Both routing lock files were absent after settlement.

The byte-exact report and durable event journal are preserved in:

- `docs/evidence/2026-10-08-catalog-preserving-apply.json`, SHA-256 `0703af40302a2ad94cd3bee3c67d0d751beaecb42368a2736179910b8bf8d056`.
- `docs/evidence/2026-10-08-catalog-preserving-apply.events.jsonl`, SHA-256 `d69fd2a8d5e4875b90e67bd3904eb436283c38ddbce2b488c33fed1ff69f395b`.

The exact reference ledger changed from two migrations (`83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62`) to three (`80027d6da351b0756385ba4d68c04dfb7397b21b058e5d341ce625a4c9b1611a`). The 47 source core migrations, their 48-row live history including its historical alias, 89 tables, 24,035 preserved rows, existing receipt bytes and timestamps, data and preserved schema fingerprints remained unchanged. The one new reference receipt is excluded only from the preservation fingerprint; it is verified separately as part of the complete new ledger.

The report explicitly leaves canonical source registration, hosted feature acceptance, API deployment and PHI approval false. Do not edit those historical flags. The report proves this database transition, not the commercial or PHI readiness of either application.

## Current source boundary

The default catalog loader now reads the registered third migration `20261008060000_catalog_offer_current_product.sql`. Its LF-normalized bytes must match the source candidate exactly, with SHA-256 `3d63f4a04b8168818844736ea5143115ca1e01fc9b2c96f0da6d5889938a6117`. Current canonical mapping checks the complete three-row digest, the two-row prefix and the exact terminal SQL. Missing, duplicated, reordered or consistently rehashed invented histories are refused.

`historical-catalog-parent-2.json` and the named historical loader preserve the frozen two-row view. Archived upgrade fixtures and explicitly historical source builders use it deliberately. Ordinary current builders never fall back to it after a current-history refusal.

The current registration inspection contract is `care-catalog-canonical-registration-inspection/1`. It captures supplied artifacts and configuration before asynchronous work, inspects the real catalog ledger and policy without replaying SQL, and refuses an absent third receipt. The fixed-target operator repeats its database and control-plane observations, refuses endpoint overrides and dirty source, and has no apply or activation action.

The current release preflight requires that new contract, the exact clean operator source, fresh repeated observations and the complete post-apply inventory. Old reference-two reports, relabeled contracts, missing history, added acceptance flags and old schema inventories fail. The preflight loads no saved apply report. Its test-only fixture helper is not an execution observer.

## Verification scope

At the preceding apply source, the full local suite passed 4,453 tests across 351 files, with 11 existing skips. Both final-source hosted CI runs, `37879264632` and `37879292833`, completed successfully. Their deployed-backend steps were skipped for missing secrets, so they do not prove live API acceptance.

During registration development, the focused catalog SQL suites passed 58 tests and the three updated SQL suites passed 18 tests. The first broad care Node run failed four archived resumption fixture cases because they paired an old core history with the new catalog manifest. The fixture now explicitly selects its frozen catalog parent; the complete isolated resumption suite passes 17 tests. That earlier broad run remains failed.

At clean committed source `b986efdb70121082ffab07381603e344306f0fae`, the fresh complete broad care run passes 419 tests without skips. The full local suite passes 4,455 tests across 351 files, with 11 existing skips, in 633.26 seconds. Standalone typecheck, full lint, the catalog boundary, clinical-core, identity/consent, authenticated API, catalog API, production migration and provider configuration source gates pass. These are source checks, not provider activation or patient feature acceptance.

The actual read-only current registration inspector completed at that same source, observed `2026-10-09T04:05:46.387Z`, with repeated live database/foundation reads and unchanged preservation fingerprints. Its exact result is `docs/evidence/2026-10-08-catalog-reference-registration.json`, SHA-256 `23b006b65d5d1a30bceff3bbc9b7955ee9543807e65ee4b1d76328caae2740aa`. All deployment, feature acceptance and PHI flags remain false.

The matched source-only API candidate binds Desktop `b986efd` to V2 `e92116b154dd1a206262926388cffe90ac5c06ce`. ZIP SHA-256 is `9f7d2d134648f89c5ad35cbb3531e09ed51cde483f2677f445a6f5f10cce969a`, 1,873,901 bytes. An independent rebuild verifies the exact source and bytes. Nothing was uploaded, deployed or device-tested.

One subsequent negative test proved that an extra top-level `hostedAcceptance:true` field was accepted by the report validator. The live operator never emitted it, and it did not authorize a deployment, but unknown authority claims must not survive validation. The validator now requires the exact read-only contract key set, refusing unknown fields even when false, as well as every missing required field. The permanent regression failed before repair; all 128 complete selected preflight, proposal, deployment, reconciliation and restoration tests pass after repair. The earlier full local result belongs to `b986efd`, not this later source change.

V2 capability and disclosure gates pass at its unchanged source. Both V2 hosted CI runs `37854800859` and `37854805769` are successful. Its strict store gate still refuses submission with eight blockers: intended-use/Core review, privacy review, store products, paid-app agreements, production HealthKit artifact, physical devices, production build authorization and production backend activation. Do not substitute an education-only scope or remove those gates to claim completion.

## Next release work

1. Preserve the completed read-only registration result separately from the preceding apply receipt. A future release admission must execute a fresh current-source inspection; neither saved result is execution authority.
2. Build a matched source-only Desktop API and V2 candidate. Reconcile the exact deployed predecessor and recovery authority before any upload or code change. The older registered-release predecessor pins still describe `0e38c130…` and `f8f995e0…`, while the observed deployed release is `9597fcb7…` and `285f33d0…`; do not weaken or normalize those checks to make a deployment pass.
3. Deploy and qualify the matched catalog and identity runtime through the reviewed synthetic workflow, then prove authoritative owner-adopted plans with same-target verified ingredient inventory. Every program supplement remains held until that inventory is reachable.
4. Complete the remaining positive lab, document, audio, privacy, retention, provider, commerce and physical device matrices in the original six-phase ledger. Clinical holds, exclusions and source-verification requirements remain intact.

All six original commercial-readiness phases remain incomplete. PHI is off, production activation is unchanged, and paid mobile builds remain held.
