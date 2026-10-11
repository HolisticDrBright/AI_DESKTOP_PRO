# Clinic custody through database fence exit

Local custody now remains in place until the outer database-fence wrapper returns the exact sealed workflow result. Preparing a settlement records observations and receipts; it does not retire the original lock or the recovery guard. A failed or substituted wrapper result retains the original attempt for explicit read-only recovery, without replaying a write.

This source increment is based on c22901efd9c5fe6a38e5376ae402db1d63d3109a in a separate checkout. It changes neither migration bytes nor the historical operator, approvals, target manifests, source receipt, mapping or deployment. PHI remains disabled. There is no live migration CLI or managed-database admission in this increment.

## Defect and repair

The original native `settle` removed local custody inside the `withFence` callback. The workflow correctly classified an outer-fence failure as an unknown write, but by then its original lock was already gone. A second reproduction showed the same loss during read-only recovery. Both new native-file regressions failed against the prior code.

`settle` now prepares a version-two receipt marked `retirement: prepared_only` and returns a separate local retirement closure. The workflow captures that closure, verifies that the fence executed exactly once and returned its exact sealed result, and invokes retirement only after the wrapper returns successfully. No database work or fence verification occurs after exit. A retirement failure returns a refusal and never retries forward.

The native closure rechecks directory and file identities, original operator and header bytes, the complete journal, prepared receipt and lock archive. Recovery also rechecks the original stopped process and both recovery guards. All validation precedes deletion; recovery removes its subsidiary guard first and the original lock last, without an asynchronous callback between them. The journal cannot change once settlement is prepared. A prepared receipt is not a certificate that a database fence exited, a lock was retired or a production upgrade succeeded.

## Verification

The two original reproductions fail before the repair and pass afterward. The focused five-file run passes110 tests, including three actual PGlite transaction journeys. New cases cover outer exit failure for writer and recovery, exact exit-before-retirement ordering, post-exit source/receipt/journal/lock substitution, substituted results, recovery receipt mutation, sealed preparation and single-use retirement. Typecheck and targeted lint pass. The initial four-file run passed99 tests; it is overlapping evidence, not an additional99 distinct tests.

Native tests use real files, archives, hard links and child-process liveness, but fictional database observations and an injected fence. The separate database journeys use actual embedded SQL and in-memory custody. Neither proves real PostgreSQL lock interleaving, managed Aurora roles, a composed executable or hosted acceptance. Full exact-source tests and CI must be collected separately after publication.

## Remaining operator and launch work

Independent managed-owner source definitions, the canonical fenced forward kernel and reviewed executable composition remain required. Native custody alone does not authorize a writer. The actual qualification database remains last observed at107 after the reviewed rehearsal refused; the repaired107→111 executable needs its own exact approval and managed rehearsal. The dependent111→112 and separately reviewed112→116 paths remain unapplied.

All six launch scopes remain incomplete: catalog/plan continuity and two-device recovery; owned labs/documents; privacy and retention; reviewed clinical release; Core store/provider acceptance; and matched releases, operational drills and physical iOS/Android journeys. Keep holds, exclusions, source verification, Core-only launch and the hold on paid builds. Claude's consumer return at V2 7b1cf4c is a separate source lane and must not be overwritten by this operator branch.
