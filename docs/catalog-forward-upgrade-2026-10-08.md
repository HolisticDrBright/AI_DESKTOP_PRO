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

## Writer snapshot repair

The initial source candidate used repeatable read for writers before acquiring table locks. PostgreSQL fixes that snapshot at the first non-transaction-control statement; a writer that commits while the operator waits for a table lock could therefore be absent from its preservation witness. Table locks do not refresh an already fixed snapshot. See [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

Write commands now use read committed, acquire the complete preservation-table and ledger locks, recheck the inventory, and only then read migration history, policies and fingerprints. Those locks keep preserved rows and ledger receipts stable during the mutation; the read-only inspector still uses repeatable read. The fresh inspection digest remains mandatory, so an intervening committed change must be refused rather than silently incorporated.

The regression failed before this repair because the first write command selected repeatable read. After repair, all 46 focused tests in three files pass in 48.69 seconds, including actual command order, a real local row change injected at lock admission, its refusal before policy SQL, and rollback. Typecheck and focused lint pass. PGlite does not prove the two-session Aurora race; that hosted concurrency case remains mandatory before lasting deployment. The full run at predecessor source `62954f1` is separate and cannot qualify this later repair. Historical SQL, catalog approvals, holds, roles, timeout limits and activation restrictions are unchanged.

## Remaining work toward all six phases

1. Complete and independently settle the currently admitted AWS recovery rehearsal without redefining its routing/refusal matrix as positive erasure acceptance.
2. Add a custodied forward-reference registration and apply workflow; perform rollback rehearsal and exact post-apply readback against the reviewed synthetic target. Update all release verifiers that intentionally pin the two-entry reference history as one coherent successor, without rewriting old receipts.
3. Build and deploy the matched reader/review runtime. Re-run actual API-role offer withdrawal and historical-destination preservation against the same catalog target.
4. Implement authoritative owner-adopted plan versions and their consent-bound, immutable predecessor lineage. Program assignment needs the same-target verified ingredient inventory, not a catalog count or the latest received protocol copy. Keep every supplement step held until those inputs exist. Verify duplicate/conflicting adoption, stale reviews and convergence on a second device.
5. Complete the remaining hosted erasure/export/retention, document/audio import, provider and billing matrices, then matched API/Desktop/mobile release and physical iOS/Android acceptance. Core launch and PHI activation remain separate gated decisions. No paid mobile build is authorized by this upgrade.

Clinical holds, unverified hormone sources, pediatric exclusions, disputed pearls, label holds and gated peptide/longevity tiers remain unchanged. All six original phases still require completion evidence; this forward upgrade does not narrow their scope.

## Custodied rollback operator

The read-only inspector remains read-only. A separate rollback-only operator now embeds the same exact histories and pending SQL. Its public command is `npm run rehearse:catalog-forward-rollback` from a clean checkout. It has no lasting-upgrade argument, database override or deployment port. A dirty build cannot run.

The command uses the actual shared routing custody directory in the primary `DESKTOP_COMMERCIAL_20261005` working copy, a kernel-held Windows mutex, the existing reconciliation guard and an exclusive create-only operator lock. It requires the byte-exact completed recovery report and its settled archive, then independently checks the actual current Lambda code, revision, unqualified API integration and retained permission absence. An existing lock, whether live or abandoned, is never replaced or deleted by this command.

Before rollback DDL is admitted, the command durably saves the full predecessor inspection. The preserving library then applies the exact policy and receipt inside a transaction, deliberately rolls that transaction back, and inspects again. A further separate read-only inspection must equal the original result. Source, control plane, all preserved data, complete historical receipts and preserved schema must remain unchanged. Only then are the completed report and original lock archived and read back before the owned lock is removed. A refusal, failed readback, process loss or uncertain transaction retains the operator lock for reconciliation; it cannot be marked successful by a supplied report or an automatic retry.

This is one hosted prerequisite for a custodied forward registration and matched reference3 runtime, not their replacement. The writer-lock race still needs an actual two-session Aurora test. The nine positive erasure journeys, authoritative owner-plan and ingredient pipeline, other processing/privacy/provider matrices, matched releases and physical-device acceptance remain separate requirements. No clinical approval, source-verification hold, tier gate, PHI setting or paid-build authorization changes.

### October 8 hosted rollback result

At clean source `7619d2fe57ae2d8393d43e895faf3e110b9cc933`, the actual fixed-target operator finished exit0 on October 9 at 01:53:21 UTC (October 8 in California). Run `bb5e6174636cac35ef973d88cfc34cf2` deliberately rolled back the successor SQL and receipt. Independent predecessor and post-rollback inspections both returned observation SHA `3a1f6c9692d3de9a9cac6311b3e9e19949dae7c263d7e77e7470fa057254a14e`, core48/reference2,89tables and24035rows including50historical ledger rows. Source and actual current Lambda/integration/permission hashes stayed equal. The completed report's bytes SHA is `2e0360d45870d74cbaae716fe2e2c74dbff2af3b28421c494a1ea9a4cacc3107`; its journal SHA is `e8b0aa5b630b70970893587590670e06482d7575c1df5a2531d1d3bf7c4294d7`. Report and lock archives were read back before release; independent local inspection confirms both shared locks are absent. The report is preserved in `docs/evidence/2026-10-08-catalog-forward-rollback.json`.

At that same source,47focused SQL tests in three files and seven credential-free custody/artifact/control tests passed. Typecheck and focused lint passed. Full local suite4071 passed348files/4414tests/11existing skips in523.08seconds, with one worker, the repository's timezone and unchanged deadlines. CI37871802002/37871869566 was still running when this receipt was written; neither is claimed green. A source-only dirty build was correctly labeled `clean:false` and was not executed against AWS. The later clean rollback bundle was `f4055b9afff147bb1c1ab91770ce006cdf4980821d507dfb2d1d3e1358820646`.

No lasting apply, canonical reference registration, runtime deployment, clinical activation, erasure acceptance, paid mobile build or PHI activation occurred. The passing rollback does not close any original phase by itself. The source-only code map was refreshed without an LLM call:12808nodes/30081post-clustering edges/795communities;67zero-node code files and174non-code skips are recorded omissions, not validated clinical content.

## Concurrent lock admission qualification

The separate public command `npm run qualify:catalog-lock-admission` is synthetic-only, bound to the same exact source artifacts, AWS account, foundation, database, current runtime and shared custody. It cannot apply a lasting migration or register the successor. It refuses a dirty build, target override, existing operator lock, missing real lock observation or an incomplete proof.

One newly generated `src_syn_catalog_lock_` parent row is admitted durably before insertion. It stays `needs_review`, has no active version, holds no PHI, and is never released or linked to a patient, product, destination or protocol. The exact original and expected changed row are saved and read back before the competing writer starts. That independent writer changes only the temporary row's timestamp and holds its transaction open. The actual migration must wait for its table lock; a third independent database transport observes both the ungranted `ShareRowExclusiveLock` and the blocking writer PID. A sleep or an environment value cannot supply that observation.

Only after the observed wait may the writer commit. The preserving migration must then refuse `observation_changed` at `before_fingerprint`, before policy DDL or a receipt is inserted. Its existing five-second lock timeout is unchanged. Every admitted worker and lock request must settle before exact fixture cleanup. Cleanup accepts only the original or the single expected changed row, with no approval, active version or source version; an outside modification is preserved and reported as a finding. The independent final full database observation must exactly equal the original before custody can settle. An ambiguous creation or failed cleanup leaves custody unresolved for reconciliation, never automatically unlocked or replayed.

Local evidence for this increment: 18 orchestration and actual fixture-SQL tests passed, nine custody/artifact/control tests passed, and the existing 47 focused SQL tests passed. Typecheck and focused lint pass. Fictional transports and PGlite do not prove concurrent Aurora behavior; the real hosted result must be recorded separately. The source-only uncommitted build remained `clean:false` and was not executed against AWS. PR80's documentation head `b27f11c` completed both CI runs37872629168 and37872634052 successfully; that does not qualify this new increment.

The full six-phase requirements remain unchanged: canonical reference3 and matched runtime, authoritative owner-adopted plans and same-target ingredient inventory, positive processing/privacy/provider acceptance, store test-mode acceptance, matched releases and physical device verification. All clinical holds, source-verification requirements, synthetic-only restrictions and the paid-mobile-build hold are preserved.
