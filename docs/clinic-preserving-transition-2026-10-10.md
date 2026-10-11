# Clinic preserving schema transition

The clinic source now has an exact transition description for migrations 112 through 116 and a complete historical-row witness. These are inputs to the remaining preserving operator, not an executable upgrade or a deployment approval. PHI remains disabled, activation remains blocked, and no disclosure release or signing key is seeded.

## Source identity

The committed receipt `infra/aws-clinical-core/source-receipts/clinic-native-source-52d1742.json` contains metadata compiled from executable source commit `52d17428d4a68d44508c6e3bf4873179e7cd7ba6` under a restricted local PostgreSQL 17.7 owner. Two independent native runs produced matching projections for every prefix. The receipt SHA-256 is `c9e718b8b782803b0ba5a05230df12e459e339c384b5e2e0873be50992100dc6`.

That local owner has no superuser or bypass-RLS authority. Its profile does not stand in for Aurora's managed role or membership semantics. Source projections cannot be copied into a runtime admission simply because the database version matches.

`npm run build:clinic-preserving-transition` validates the exact source assembly and receipt, then writes `dist/aws-clinical-core/clinic-preserving-transition/source-transition.json`. Unsupported target, approval, profile and PHI options are refused. The output carries no operator acceptance, runtime admission or upgrade authority.

| Transition | Added metadata objects | Changed metadata objects | New tables |
| --- | ---: | ---: | ---: |
| 112 to 113 | 10 | 7 | 2 |
| 113 to 114 | 23 | 4 | 4 |
| 114 to 115 | 0 | 1 | 0 |
| 115 to 116 | 28 | 4 | 5 |

No projected object is removed. The complete added and changed object lists, SQL digests, prefix schema digests, ledger identities and assembly identities are in the generated transition. The eleven new coverage entries are explicitly unregistered and unreviewed proposals. Private signing material is represented only by counts and digests, never as patient content.

## Preservation witness

`readClinicHistoricalRowWitness` reads all 217 historical tables with `row_security=off`, so a denied read stops the check rather than silently excluding protected rows. It validates the exact migration history and table inventory, hashes every historical row and every field of the original 112 migration receipts, and requires all eleven successor tables to be empty. Table reads are batched; more than 100,000 rows in any table is refused instead of accepting a truncated digest.

`assertClinicHistoricalRowsPreserved` compares the parent and successor witnesses. Same-count content changes, timestamp changes to migration receipts, missing legal holds and seeded successor data are failures. The witness deliberately states `schemaAdmissionProven:false`, `custodyProven:false`, `managedRoleSemanticsVerified:false` and `operatorAcceptance:false`. It proves only the row comparison made inside the caller's transaction.

## Local verification

The source suite has 43 passing positive and refusal tests. The embedded database suite has 21 passing tests. Its positive journey applies the actual four extensions to the exact 112 predecessor with fictional records and a legal hold, compares complete historical witnesses, deliberately rolls back, and checks that both the whole schema projection and the row witness return to their original state.

The embedded suite also exercises same-count corruption, receipt corruption, hold removal, seeded signing keys, ledger and table drift, denied API-role reads, malformed or incomplete query results, oversized row counts and attempts to promote a witness into an approval. It does not exercise Aurora, a real interleaved lock wait, a restricted native owner's protected-row access or commit-recovery custody.

## Remaining operator and hosted work

1. Compile and review the managed runtime profile separately from local source metadata. Refuse unexplained owner, grantor, membership, ACL or engine differences.
2. Assemble the fenced preserving operator: exact target and source admission, migration and fixture locks, complete protected-row access, checks at every prefix, rollback readback and a durable journal for uncertain commit recovery.
3. Register the exact successor mappings and coverage only through a reviewed operator. No key or disclosure approval may be inferred from a passing source test.
4. Obtain an exact review for the assembled executable. The pending `10443ee` review covers only the separate 107-to-111-to-112 operators; it does not cover this 112-to-116 transition.
5. Run the approved rollback and preserving upgrade against the isolated qualification database, then deploy exact candidate releases and execute every mandatory hosted case without treating skips or refusals as passes.

Read-only AWS inspection on October 10 found `clinical_core_qualification` at 107 migrations, under PostgreSQL 17.7 and `clinical_admin`, with PHI disabled and activation blocked. The inspection transaction was rolled back. Those observations neither apply the pending predecessor upgrades nor qualify this transition. Matched releases, physical device acceptance, provider coverage and policy approvals remain separate commercial and PHI readiness gates.
