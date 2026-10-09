# Catalog forward upgrade and remaining integration

The catalog reader repair is source-verified, but the registered database still has the original two reference migrations. The pending upgrade replaces one purchase-link access policy so an old approved offer cannot authorize ordering a currently restricted or withdrawn product. Existing clinical approvals, separately approved purchase destinations, verification holds and historical rows stay unchanged. This is synthetic-only engineering, not commercial or PHI activation.

## Release mapping

| Artifact | Identity |
| --- | --- |
| Registered core source | 47 migrations, `02026932fff5a37db42a17a1c4f80bd38a759cf8e2ccb2f4d53b8299c66065e7` |
| Observed core history including the preserved historical alias | 48 entries, `447cf4ea8c8da3decbaa7edea964f97d9e3bdb029c38723bf3a5767c38679a50` |
| Registered reference history | 2 entries, `83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62` |
| Pending forward reference identity | `20261008060000_catalog_offer_current_product`, third entry |
| Pending SQL bytes normalized to LF | `3d63f4a04b8168818844736ea5143115ca1e01fc9b2c96f0da6d5889938a6117` |
| Reference successor identity | `80027d6da351b0756385ba4d68c04dfb7397b21b058e5d341ce625a4c9b1611a` |

The SQL remains in `infra/aws-clinical-core/source-candidates/catalog-offer-current-product.sql`. No historical SQL or registered manifest changed. A disposable PGlite apply is not a canonical registration or hosted migration receipt. The reference successor must be incorporated into a matched release only after existing routing custody is independently settled; the active rehearsal still pins the two-entry history.

## Preservation and refusal controls

`catalog-forward-upgrade.ts` binds the exact synthetic account, region, cluster, secret identifier and database. It refuses production, qualification and foreign database targets, PHI, altered artifact bytes, renamed or missing history and an unrecorded partial policy upgrade. It checks the exact predecessor or successor policy, its role and command, the complete policy set on the affected table, and the absence of superuser or RLS-bypass authority in the application role.

The preserving transaction requires an inspection digest that still matches after acquiring migration advisory locks and write-blocking table locks. It hashes every admitted clinical and catalog row rather than a prefix, refusing any table over the explicit bound. Both full historical ledger rows, including `applied_at`, are preserved. It compares schema, columns, defaults, constraints, indexes, triggers, all other policies, table and schema grants, function definitions and grants, application-role membership, and other relations. Only the one separately verified policy and its new ledger receipt may change. Any other change rolls back.

The library supports inspection, rollback rehearsal and preserving apply. The public operator supports **inspection only** and refuses every lasting or rollback-write command. It observes AWS member STS before the foundation and uses embedded artifacts, not environment target overrides. This is deliberate: a lasting public release still needs shared routing custody, artifact registration, independent readback and a matched runtime deployment. A supplied hash is not review or activation authority.

Postgres grants and RLS are separate layers; a bypass role or an additional permissive policy can defeat a correct-looking predicate. The negative tests cover both. See [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) and [transaction advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).

## Verification

The final focused local run passed 45 tests across the forward operator, source descriptors and existing catalog reader suite. It exercised actual registered SQL, review services, RLS under `clinical_core_api`, rollback and replay, populated held records beyond 5,000 rows, historical receipt preservation, altered grants and function definitions, weakened and extra policies, role bypass, stale inspection and foreign targets. The physical database name and AWS metadata in those tests are fictional substitutions; they do not establish hosted, concurrent Aurora or device acceptance.

The full pre-wire-repair run passed 348 files and 4,411 tests with 11 existing skips in 539.39 seconds, with one worker and unchanged deadlines. A separate probe then found an integration defect those tests did not cover: the actual repository RDS decoder returns `ArrayValue` as a tagged object, while the inspector compared it with a native role array. That probe failed at `before_policy` with one array field and zero AWS calls. The query now projects its complete ordered role array as exact JSON text; it does not discard role entries or change the shared driver. The same actual SQL through the real decoder now passes with zero array fields, and a permanent driver regression test passes. The earlier full pass is not a full pass of this later repair. See [AWS ArrayValue](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ArrayValue.html).

Initial exploratory failures are not passes: the first operator run failed 13 of 23, primarily cascading after a test issued a no-op trigger command and committed its local successor. The trigger case now changes the real immutable intent trigger. Schema changes are classified before row-serialization differences, and inherited over-bound fingerprint refusals retain their category. A later test exposed that the command observed the foundation before refusing an invalid caller; caller validation now happens first. No production predicate, deadline, approval or exclusion was weakened to obtain the focused pass.

Build the read-only operator with `npm run build:catalog-forward-inspector` from a clean source checkout. Its artifact manifest states the operator commit, bundled-byte digest, both reference identities, read-only capability and false activation flags. CI builds it without AWS access. A dirty-source build cannot execute an inspection. Do not use this operator or its library to mutate the database while another run holds routing custody.

## Remaining work toward all six phases

1. Complete and independently settle the currently admitted AWS recovery rehearsal without redefining its routing/refusal matrix as positive erasure acceptance.
2. Add a custodied forward-reference registration and apply workflow; perform rollback rehearsal and exact post-apply readback against the reviewed synthetic target. Update all release verifiers that intentionally pin the two-entry reference history as one coherent successor, without rewriting old receipts.
3. Build and deploy the matched reader/review runtime. Re-run actual API-role offer withdrawal and historical-destination preservation against the same catalog target.
4. Implement authoritative owner-adopted plan versions and their consent-bound, immutable predecessor lineage. Program assignment needs the same-target verified ingredient inventory, not a catalog count or the latest received protocol copy. Keep every supplement step held until those inputs exist. Verify duplicate/conflicting adoption, stale reviews and convergence on a second device.
5. Complete the remaining hosted erasure/export/retention, document/audio import, provider and billing matrices, then matched API/Desktop/mobile release and physical iOS/Android acceptance. Core launch and PHI activation remain separate gated decisions. No paid mobile build is authorized by this upgrade.

Clinical holds, unverified hormone sources, pediatric exclusions, disputed pearls, label holds and gated peptide/longevity tiers remain unchanged. All six original phases still require completion evidence; this forward upgrade does not narrow their scope.
