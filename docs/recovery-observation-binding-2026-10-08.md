# Recovery observation binding

The failed standalone rehearsal5945b25ef9f739096c238544b7fc5b0a remains failed.
Its105 recorded functional cases are not a completed rehearsal, positive erasure
acceptance or PHI activation. Stopped restoration67157 completed with exit0,
unchanged database and exact code, original routing and absent temporary
permission. It performed no AWS mutation. Its receipt and settled-lock archive
exist and the shared operator lock is absent. The original failure prefix SHA
6b46b4a21337090be8d944b7ddc8fabf96947aab55257e484bc3cd50c384f832 is preserved;
the restoration journal SHA is e098ed78664a121b2c7ec3458ed4049f7ba373890f4320a8cc9bea7ba09a8c4d.

## Reproduced verifier defect

The final comparison treated raw AWS usage observations as immutable configuration,
although the existing authority verifier already separates those observations.
Three tests failed before repair: a changed IAM RoleLastUsed value, changed log
storedBytes, and both together. Read-only AWS inspection also confirms this run's
role usage date advanced from22:41:32UTC to23:57:36UTC; log storedBytes was531 in
both the archived before and current observation. The exact recovery-end snapshot
was not archived by the old operator, so these observations do not establish the
sole field responsible for its failure.

The final comparison now admits only the existing two usage fields after shape
validation. LastUsedDate must parse and not be future-dated; Region must have an
AWS-region shape; storedBytes must be a nonnegative safe integer. Unknown keys
inside RoleLastUsed are refused. Every other raw field remains exact, including
the full returned stage, Lambda configuration and metadata, IAM policy and role
configuration, logs configuration, code, routes, authorizers and database. The
separate, durably admitted Lambda permission metadata lineage is unchanged.

## Durable failure evidence

The operator now archives its validated recovery report before final repeated
readback and binding. The new journal event binds exact bytes to a digest-bearing
standalone-recovery file in the operations directory. The source, clock, original
custody and archive bytes are rechecked before each later action. New completion
reports must carry the same archived witness. A later refusal keeps the original
result failed and preserves the actual service snapshots for investigation.

Existing journals without that optional historical event remain readable. No
old event, snapshot, failed receipt or migration is rewritten. The public runner
still cannot accept a supplied report, target/profile override, activation, schema
change or paid build. Evidence readers reject wrong kinds, aliases, traversal,
changed bytes and false digests. An archive never authorizes a deployment.

## Verification and remaining scope

The three standalone/custody/restoration suites passed46 tests after the initial
repair. At the final source, the full registered-operator suite passed182 tests,
including additional archival and malformed-observation negatives. Typecheck
and focused lint passed. AST refresh is pending. A fresh hosted
rehearsal must be separately admitted only after the previous custody has settled;
never replay or relabel the failed run. The application remains frozen9597fcb,
V2 remains38ea48c and the immutable candidate ZIP remains285f33d0.

All six original scopes remain incomplete: authoritative owner-plan continuity,
owned lab/document/audio recovery, complete privacy/export/erasure and retention,
eligible knowledge/catalog releases, Core commerce/provider acceptance, and exact
matched releases with rollback/security/load and physical iOS/Android acceptance.
Clinical holds, exclusions and source verification remain unchanged. PHI is OFF;
paid mobile builds remain HELD.
