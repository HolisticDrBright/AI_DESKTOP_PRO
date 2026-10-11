# Fullscript extension shape verification

The preserving 107 to 111 rollback rehearsal in the synthetic AWS database refused the eight-table shape at source10443ee. The engine-specific metadata check is now repaired in source; neither preserving upgrade has been committed to AWS.

## Cause and exact source projections

The embedded test engine is PostgreSQL18.3, while the independently built native source engine and the last AWS identity observation are17.7. PostgreSQL18 stores column NOT NULL declarations in pg_constraint as well as pg_attribute. The same111 SQL therefore creates77 additional constraint records in18.3. Every other projected field of all eight tables matches between the two fresh local databases. This matches the [PostgreSQL18 release notes](https://www.postgresql.org/docs/18/release-18.html) and the [PostgreSQL17 catalog definition](https://www.postgresql.org/docs/17/catalog-pg-constraint.html).

The existing18.3 projection remains pinned to3db36bba5d38a41b0e6a6264f956e852ad5be191af4048cc184db5862136ed0d. A distinct17.7 source projection is pinned to9bdcb1ffc4a0f9a28c631d2545c4c1fd276aa53c4edf186b3d4d7dbcd8e28ee5. The database must report exactly one known engine version before either pin is selected. Unknown, ambiguous and malformed versions are refused, and pins never fall back across versions. The SQL projection is unchanged and still includes columns, nullability, defaults, constraints, indexes, policies and triggers; no NOT NULL record is filtered from the runtime check.

## Reproduction and regression evidence

Runpg17-ufvUhk reproduced the unchanged gate's extension_shape refusal using only fresh local source objects. The embedded result matched the historical pin, and the native result differed. Runpg17-Fz7VMG passed the repaired whole verifier, including function permissions, under the restricted clinical_admin owner. Three savepoint tests removed NOT NULL, changed a default or dropped a check; all were refused at extension_shape. Four existing widened-membership tests were refused. The original107 ledger, two fictional unprotected rows and historical metadata were preserved after rollback, and the owned native cluster was confirmed stopped.

The first comparison attempt overwrote its captured digest when reading the metadata projection; that diagnostic capture error was fixed before deriving either digest. The corrected source report retains full metadata and exact SQL-query hashes. The new version tests initially exposed a test-table argument mistake; object-wrapped test cases corrected it, and all13 cases pass. The focused five-file operator/rollback suite passes119 tests. The credential-free argument/scope suites pass18 tests. Typecheck, targeted lint and whitespace checks pass. These results do not replace full-suite, CI or actual managed rollback evidence for the final commit.

The compact source receipt is infra/aws-clinical-core/source-receipts/fullscript-extension-shape-pg17-pg18.json. The reproducible diagnostic is scripts/qualify-fullscript-extension-shape.mjs. It accepts only explicit local PostgreSQL17.7 binary and pg8.16.3 driver directories, creates its own loopback-only SCRAM cluster, refuses cloud/target/approval/database-URL inputs and does not install managed-role simulations. The pg17-Fz7VMG report SHA is recorded in the receipt. Source diagnostics do not prove managed role semantics, protected-row reads, custody or operator acceptance.

## Deployment boundary

Historical migration bytes, ledger/assembly hashes, consent text, provider activation, operator custody and permissions are unchanged. The operator executable changes because version-bound shape selection is new code. Approval of10443ee does not cover the changed executable. Build both preserving operators from the final clean commit, obtain exact new reviews after CI and source verification, then repeat the managed rollback rehearsal under the original target guard before considering an apply. The second111 to112 step remains dependent on a settled111 parent. Production, PHI, providers and paid mobile builds remain disabled; this repair alone completes none of the six commercial launch scopes.
