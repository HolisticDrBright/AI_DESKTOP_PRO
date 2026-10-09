# Qualification-only, data-preserving migration 103

## Scope and why this is separate

The production schema installer intentionally requires zero clinical rows. The real
102-migration artifact plus the 24-row fictional fixture reproduces its refusal when
migration 103 is added: new DDL and ledger writes roll back, existing rows remain.
Do not relax that installer, clear the fixtures, or rewrite the old ledger.

This separate operator supports only the exact **102 -> 103** transition in synthetic
account `588966314750`, region `us-east-2`, database `clinical_core_qualification`.
It is not a general production migration tool or authorization to change PHI policy.
Future transitions need independent source review, tests and pinned identities. The
production/populated-data release upgrade procedure remains a separate readiness item.

## Three different hashes — correction to the earlier recovery note

| Identifier | Algorithm / use | Migration 103 value |
|---|---|---|
| Ledger identity | SHA-256 of ordered `version:sql_sha256` lines, `productionArtifactReleaseHash` | `9bc30d04930816a523a7dc67b95944fba1d294dad4d71cf7585158fbc3a874aa` |
| Builder release | SHA-256 of ordered `version:filename:sql_sha256` lines | `8a9a8f321fafc1f4e2c20b44825845cc64bb291c1746b1cdacfe7f23bfa3c9c2` |
| Gate combined-SQL checksum | SHA-256 of joined SQL bytes | `06572c1889bf6d3e6bf6c65e8b687dd10500d445338ebc3233f9b447fe5c543f` |

The earlier recovery handoff/upload receipt mislabeled the last value as the first.
Use the ledger identity in the qualification target manifest. The operator recomputes
it from all actual migration bytes and verifies the 102-file prefix against
`d6b0a8a5d61c465f8e1db1181c52d6bf4d90db0b65068042d8ebf56358dd82b3`.
None of these hashes represents human approval, provider review or PHI readiness.

## Checks

- CLI observes STS and the fixed qualification foundation itself, requiring completed
  infrastructure, correct account/region/database, `PhiAllowed=false`, `Activation=blocked`
  and foundation `QualificationExecution=disabled`. Candidate execution is not activated.
- CLI and RDS SDK both explicitly use `ai-synthetic-staging`; SDK credentials do not fall
  back to unrelated environment credentials. No secret values or data are printed.
- Upgrade requires a clean-source compiled operator and an explicit confirmation switch.
  Dirty-source builds may inspect only. The actual `current_database()` is checked.
- Actual SQL hashes, exact versions/order and both ledger endpoints are pinned. Unknown,
  missing or mismatched history is refused before DDL. Applied hashes are never rewritten.
- One transaction, bounded lock/statement timeouts, shared migration/fixture advisory
  locks and deterministic table locks fence ordinary row writers during the upgrade.
- All 202 table names across core, audit, private, clinical reference and commercial
  reference are pinned. RLS/forced-RLS flags must stay unchanged. `row_security=off`
  causes failure rather than silently accepting a policy-filtered partial inventory;
  it grants no bypass privilege and does not disable table policies.
- Before/after fingerprints hash every row (including duplicates), not only row counts.
  SQL is batched into at most 20 tables / 20,000 bytes per request in the same transaction.
  Any table over 5,000 rows is refused, rather than truncated or treated as preserved.
- Only migration 103 DDL and its new ledger receipt are written. Function body digest,
  return type, security-definer flag, API execute privilege and absence of public execute
  privilege are checked before commit. Retry recognizes the exact completed release.
- Data change, RLS drift, missing execution privilege or failed receipt causes rollback.
  Errors report only a bounded category/stage, not SQL, parameters or database messages.

## Commands (from the exact Desktop checkout)

```powershell
node scripts/build-aws-production-clinical-core.mjs
node scripts/check-aws-production-clinical-core.mjs
node scripts/build-aws-qualification-schema-upgrade.mjs
node dist/aws-clinical-core/qualification-schema-upgrade/index.cjs inspect
# Only after checking the inspected identity and source:
node dist/aws-clinical-core/qualification-schema-upgrade/index.cjs upgrade --confirm-qualification-upgrade
node dist/aws-clinical-core/qualification-schema-upgrade/index.cjs inspect
```

The CLI's parameters cannot redirect it to staging or production. The built operator's
manifest records its source commit, clean status and bundle digest. Build only reads Git
and writes local artifacts; CI builds it but never runs it against AWS.

## Evidence boundary

Real-artifact PGlite tests reproduce the original refusal and exercise success, replay,
wrong account/database/policy, changed artifacts/history, receipt failure, same-count
row corruption, RLS drift, absent privilege, added tables and the row bound. PGlite's
database-name observation is explicitly simulated; all migration and transaction SQL is
real. Live read-only inspection additionally verified AWS database name, ledger 102,
202 tables and 24 fictional rows. The initial unbatched read exceeded the Data API SQL
request capacity; bounded batches resolved the hosted inspection failure.

This document does not claim a hosted upgrade or candidate acceptance. Record the exact
committed operator and before/after results in the release handoff after execution.
Local verification: 15 targeted tests, typecheck, lint (zero errors/five existing warnings),
migration and coverage gates passed. The first full suite timed out in two files during
a Windows-confirmed 22-minute Modern Standby interval. The unchanged rerun after resume
passed all 269 files: 3,258 tests passed, 11 existing skips. The failed run is not relabeled.
Afterward: update the reviewed target manifest with the **actual ledger identity**,
re-run rollback acceptance, qualify matched candidates and physical devices. Existing
capacity, alarm-delivery, security/retention/provider reviews and PHI activation gates remain.
